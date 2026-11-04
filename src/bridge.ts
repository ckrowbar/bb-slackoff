// The Slackoff bridge: BB thread events → Slack, and Slack messages, buttons
// and forms → BB.
//
// Durable state is one Binding per mirrored thread (store.ts). Everything
// else here is rebuilt from BB after a restart: the turn in progress is
// replayed from its first event, so cards and the held final reply survive.
// All work for one thread runs in order on a per-thread queue.
import { z } from "zod";

import { errorText, isNotFound, threadLink, threadTitle, type InteractionResolution, type PromptInput, type ReasoningLevel, type Sdk, type ThreadResponse } from "./bb.ts";
import { ACTION, MORE, VIEW, notification, type CardStatus } from "./blocks/common.ts";
import { MIRROR_FIELDS, NEW_THREAD_FIELDS, buildHomeView, buildMirrorModal, buildNewThreadModal } from "./blocks/home.ts";
import { buildAnswerModal, type ApprovalDecision } from "./blocks/interaction-cards.ts";
import { buildThreadCard, type LastTurn, type ThreadCardState } from "./blocks/thread-card.ts";
import { Catalog } from "./catalog.ts";
import { COMMAND_HELP, parseThreadCommand, type ThreadCommand } from "./commands.ts";
import { collectFiles, SlackFileSchema, type SlackFile } from "./files.ts";
import { markdownToPlainText, markdownToSlackMessages } from "./format/markdown.ts";
import { escapeMrkdwn, slackMessageToMarkdown, truncate } from "./format/mrkdwn.ts";
import {
  answerFromReply,
  answersFromModal,
  approvalResolution,
  cardKind,
  describeOutcome,
  interactionCard,
  questionsOf,
  type PendingInteraction,
  type Resolution,
} from "./interactions.ts";
import type { Preferences } from "./settings.ts";
import type { Log, Outbox } from "./slack/outbox.ts";
import type { SocketEnvelope } from "./slack/socket-mode.ts";
import type { RichTextInline, SlackMessage } from "./slack/types.ts";
import type { Binding, Store } from "./store.ts";
import { TRACKED_EVENT_TYPES, TurnTracker, type Effect, type Row } from "./turn.ts";

export interface BridgeOptions {
  pluginId: string;
  sdk: Sdk;
  outbox: Outbox;
  store: Store;
  preferences: () => Preferences;
  log: Log;
  /** Tell open BB windows that mirror state changed (null: everything). */
  publish?: (threadId: string | null) => void;
  now?: () => number;
  /** Minimum gap between live status card updates for one thread. */
  cardIntervalMs?: number;
}

type Phase = "idle" | "starting" | "working" | "stopping" | "done" | "stopped" | "error" | "archived";

interface Reaction {
  channel: string;
  ts: string;
  state: "queued" | "running";
}

/** In-memory state for one mirrored thread. */
interface Runtime {
  tracker: TurnTracker;
  /** The in-progress turn has been rebuilt from BB since this process started. */
  hydrated: boolean;
  phase: Phase;
  waiting: "approval" | "question" | undefined;
  lastTurn: LastTurn | undefined;
  /** Texts sent from Slack that BB will echo back as user messages. */
  echo: string[];
  /** Slack messages waiting for the turn that answers them. */
  reactions: Reaction[];
  lastError: string | undefined;
  /** Model and effort chosen in Slack, until the next turn reports its own. */
  override: { model?: string; effort?: string };
  cardTimer: ReturnType<typeof setTimeout> | undefined;
  lastCardAt: number;
  syncQueued: boolean;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retries: number;
  /** BB says the thread is idle: finish a turn that never reported turn/completed. */
  idleSeen: boolean;
}

const EVENT_PAGE = 100;
const MAX_PAGES_PER_SYNC = 20;
/** A restart replays the whole turn in progress; allow long ones. */
const MAX_HYDRATE_PAGES = 200;
const DEFAULT_CARD_INTERVAL_MS = 3_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];

const MessageEventSchema = z.object({
  type: z.literal("message"),
  channel: z.string(),
  channel_type: z.string().optional(),
  user: z.string().optional(),
  text: z.string().default(""),
  ts: z.string(),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
  files: z.array(SlackFileSchema).default([]),
});
type MessageEvent = z.infer<typeof MessageEventSchema>;

const ActionPayloadSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  trigger_id: z.string().optional(),
  channel: z.object({ id: z.string() }).optional(),
  container: z.object({ message_ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
  actions: z.array(
    z.object({
      action_id: z.string(),
      block_id: z.string().optional(),
      value: z.string().optional(),
      selected_option: z.object({ value: z.string() }).nullish(),
    }),
  ),
});
type ActionPayload = z.infer<typeof ActionPayloadSchema>;

const ViewPayloadSchema = z.object({
  type: z.literal("view_submission"),
  user: z.object({ id: z.string() }),
  view: z.object({
    callback_id: z.string(),
    private_metadata: z.string().default(""),
    state: z.object({ values: z.record(z.string(), z.record(z.string(), z.any())) }),
  }),
});

export class Bridge {
  readonly #o: BridgeOptions;
  readonly #catalog: Catalog;
  readonly #runtimes = new Map<string, Runtime>();
  readonly #chains = new Map<string, Promise<void>>();
  /** Slack messages for one thread reach BB in the order they were sent. */
  readonly #inbound = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<void>>();
  readonly #mirrored = new Set<string>();
  readonly #seenEvents = new Map<string, number>();
  readonly #pendingPrompts = new Map<string, { text: string; files: SlackFile[] }>();
  readonly #titles = new Map<string, string>();
  #homeTimer: ReturnType<typeof setTimeout> | undefined;
  #homeNotice: string | undefined;
  #paused = false;
  #disposed = false;

  constructor(options: BridgeOptions) {
    this.#o = options;
    this.#catalog = new Catalog(options.sdk, options.log, () => this.#now);
  }

  get #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  get #prefs(): Preferences {
    return this.#o.preferences();
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /** Load the mirrored set so agent instructions are right from the start. */
  async start(): Promise<void> {
    for (const binding of await this.#o.store.list()) if (binding.mirrored) this.#mirrored.add(binding.threadId);
  }

  dispose(): void {
    this.#disposed = true;
    for (const runtime of this.#runtimes.values()) {
      clearTimeout(runtime.cardTimer);
      clearTimeout(runtime.retryTimer);
    }
    clearTimeout(this.#homeTimer);
  }

  /** Wait for all queued work; used before a restart and by tests. */
  async idle(): Promise<void> {
    while (this.#chains.size > 0 || this.#background.size > 0) {
      await Promise.allSettled([...this.#chains.values(), ...this.#background]);
    }
  }

  isMirrored(threadId: string): boolean {
    return this.#mirrored.has(threadId);
  }

  /** Catch every mirror up after a (re)connect. */
  async reconcileAll(): Promise<void> {
    this.#paused = false;
    for (const binding of await this.#o.store.list()) {
      if (!binding.mirrored) continue;
      void this.#serial(binding.threadId, async () => {
        let thread: ThreadResponse;
        try {
          thread = await this.#o.sdk.threads.get({ threadId: binding.threadId });
        } catch (error) {
          // Only a definite "not found" retires a mirror; anything else waits for the next reconnect.
          if (isNotFound(error)) await this.#markDeleted(binding);
          else this.#o.log.warn(`could not reconcile ${binding.threadId}: ${errorText(error)}`);
          return;
        }
        if (thread.deletedAt !== null) {
          await this.#markDeleted(binding);
          return;
        }
        const runtime = this.#runtime(thread.id);
        runtime.phase = phaseFromThread(thread);
        // Idle while we were away: a held reply can go out now.
        runtime.idleSeen = thread.status === "idle";
        await this.#sync(thread.id);
        const current = await this.#o.store.get(thread.id);
        if (current) await this.#refreshCard(current, thread);
      });
    }
    this.#scheduleHome();
  }

  /** Show every card as paused before Slackoff disconnects. */
  async pauseAll(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    for (const binding of await this.#o.store.list()) {
      if (binding.mirrored) await this.#serial(binding.threadId, () => this.#refreshCard(binding));
    }
  }

  // -------------------------------------------------------------------------
  // Mirroring on and off

  /**
   * Start or resume mirroring. A new mirror starts at the end of the thread
   * (showing the latest reply for context) unless `fromStart` is set.
   */
  enable(threadId: string, options: { fromStart?: boolean; root?: { channelId: string; ts: string } } = {}): Promise<Binding> {
    return this.#serial(threadId, () => this.#enable(threadId, options));
  }

  async #enable(threadId: string, options: { fromStart?: boolean; root?: { channelId: string; ts: string } }): Promise<Binding> {
    const prefs = this.#prefs;
    if (!prefs.userId) throw new Error("Slackoff has no Slack member ID");
    const thread = await this.#o.sdk.threads.get({ threadId });
    const existing = await this.#o.store.get(threadId);
    if (existing?.mirrored) return existing;
    const runtime = this.#runtime(threadId);
    runtime.phase = phaseFromThread(thread);
    runtime.hydrated = true;
    runtime.tracker = new TurnTracker(prefs.replies);
    const lastSeq = options.fromStart ? 0 : await this.#latestSeq(threadId);
    this.#mirrored.add(threadId);

    if (existing) {
      const binding: Binding = { ...existing, mirrored: true, lastSeq, projectId: thread.projectId, turn: null };
      await this.#o.store.save(binding);
      await this.#refreshCard(binding, thread);
      await this.#syncInteractions(binding);
      this.#changed(threadId);
      return binding;
    }

    const card = buildThreadCard(await this.#cardState(thread, true));
    const place = options.root ? { channel: options.root.channelId, threadTs: options.root.ts } : { channel: prefs.userId };
    const posted = await this.#o.outbox.post(place, card);
    if (!posted) {
      this.#mirrored.delete(threadId);
      throw new Error("Slack refused the status card; check the bot token and scopes");
    }
    const binding: Binding = {
      threadId,
      projectId: thread.projectId,
      channelId: posted.channel,
      rootTs: options.root?.ts ?? posted.ts,
      cardTs: posted.ts,
      mirrored: true,
      lastSeq,
      createdAt: this.#now,
      cards: {},
      turn: null,
    };
    await this.#o.store.save(binding);

    if (!options.fromStart) {
      const { output } = await this.#o.sdk.threads.output({ threadId }).catch(() => ({ output: null }));
      if (output?.trim()) await this.#postMarkdown(binding, output, { lead: [{ type: "text", text: "Latest reply", style: { bold: true } }], notify: threadTitle(thread) });
    }
    await this.#syncInteractions(binding);
    this.#changed(threadId);
    return binding;
  }

  disable(threadId: string): Promise<void> {
    return this.#serial(threadId, async () => {
      const binding = await this.#o.store.get(threadId);
      if (!binding?.mirrored) return;
      const next: Binding = { ...binding, mirrored: false, turn: null };
      await this.#o.store.save(next);
      this.#mirrored.delete(threadId);
      const runtime = this.#runtime(threadId);
      runtime.tracker.clear();
      runtime.hydrated = false;
      await this.#o.outbox.status(binding.channelId, binding.rootTs, "", this.#now);
      await this.#refreshCard(next);
      this.#changed(threadId);
    });
  }

  async threadState(threadId: string): Promise<{ mirrored: boolean; permalink: string | null }> {
    const binding = await this.#o.store.get(threadId);
    if (!binding?.mirrored) return { mirrored: false, permalink: null };
    return { mirrored: true, permalink: (await this.#o.outbox.permalink(binding.channelId, binding.rootTs)) ?? null };
  }

  /** Mirrored threads for the BB sidebar and Slack App Home, most recently active first. */
  async summaries(): Promise<{ threadId: string; title: string; projectName: string; status: CardStatus; activity: string | undefined; permalink: string | null; updatedAt: number }[]> {
    const bindings = (await this.#o.store.list()).filter((binding) => binding.mirrored);
    const rows = await Promise.all(
      bindings.map(async (binding) => {
        const thread = await this.#o.sdk.threads.get({ threadId: binding.threadId }).catch(() => undefined);
        const { status, activity } = this.#statusOf(binding.threadId, thread);
        return {
          threadId: binding.threadId,
          title: thread ? threadTitle(thread) : "Untitled thread",
          projectName: thread ? (await this.#catalog.project(thread.projectId)).name : "",
          status,
          activity,
          permalink: (await this.#o.outbox.permalink(binding.channelId, binding.rootTs)) ?? null,
          updatedAt: thread?.updatedAt ?? 0,
        };
      }),
    );
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Post a direct message to confirm the setup works. */
  async sendTest(): Promise<void> {
    const posted = await this.#o.outbox.post(
      { channel: this.#prefs.userId },
      {
        text: "Slackoff is connected",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "👋 *Slackoff is connected.*\nTurn mirroring on from a thread's header in BB, or send me a message to start a new thread." } },
        ],
      },
    );
    if (!posted) throw new Error("Slack refused the message; check the bot token, scopes and member ID");
  }

  // -------------------------------------------------------------------------
  // BB events

  onThreadEvents(thread: ThreadResponse): void {
    if (this.#mirrored.has(thread.id)) this.#queueSync(thread.id);
  }

  onThreadCreated(thread: ThreadResponse): void {
    const prefs = this.#prefs;
    if (!prefs.mirrorNewThreads || !prefs.userId) return;
    if (thread.visibility !== "visible" || thread.parentThreadId || thread.originKind === "fork") return;
    if (thread.originPluginId === this.#o.pluginId) return;
    this.#track(this.enable(thread.id, { fromStart: true }).catch((error) => this.#o.log.warn(`auto-mirror failed for ${thread.id}: ${errorText(error)}`)));
  }

  onThreadStatus(thread: ThreadResponse, event: "active" | "idle" | "failed" | "archived" | "unarchived" | "deleted", error?: string | null): void {
    if (event !== "deleted" && !this.#mirrored.has(thread.id)) return;
    void this.#serial(thread.id, async () => {
      const binding = await this.#o.store.get(thread.id);
      if (!binding) return;
      if (event === "deleted") {
        await this.#markDeleted(binding);
        return;
      }
      if (!binding.mirrored) return;
      const runtime = this.#runtime(thread.id);
      runtime.idleSeen = event === "idle";
      if (event === "idle" || event === "failed") await this.#syncOrRetry(thread.id);
      switch (event) {
        case "active":
          if (runtime.phase !== "working") runtime.phase = "working";
          break;
        case "idle":
          if (runtime.phase === "working" || runtime.phase === "starting" || runtime.phase === "stopping") runtime.phase = "idle";
          break;
        case "failed":
          runtime.phase = "error";
          if (error && runtime.lastError !== error) {
            runtime.lastError = error;
            await this.#postNotice(binding, `🔴 ${escapeMrkdwn(truncate(error, 2_800))}`, notification("🔴", threadTitle(thread), error));
          }
          break;
        case "archived":
          runtime.phase = "archived";
          break;
        case "unarchived":
          runtime.phase = phaseFromThread(thread);
          break;
      }
      const current = (await this.#o.store.get(thread.id)) ?? binding;
      await this.#syncInteractions(current);
      this.#scheduleCard(thread.id, true);
    });
  }

  onInteraction(thread: ThreadResponse, interaction: PendingInteraction): void {
    if (!this.#mirrored.has(thread.id)) return;
    void this.#serial(thread.id, async () => {
      const binding = await this.#o.store.get(thread.id);
      if (!binding?.mirrored || binding.cards[interaction.id]) return;
      await this.#postInteraction(binding, interaction, threadTitle(thread));
      this.#runtime(thread.id).waiting = cardKind(interaction) === "approval" ? "approval" : "question";
      this.#scheduleCard(thread.id, true);
    });
  }

  // -------------------------------------------------------------------------
  // Event sync

  /** One sync per thread at a time; notifications that arrive meanwhile share it. */
  #queueSync(threadId: string): void {
    const runtime = this.#runtime(threadId);
    if (runtime.syncQueued || this.#disposed) return;
    runtime.syncQueued = true;
    void this.#serial(threadId, async () => {
      runtime.syncQueued = false;
      await this.#syncOrRetry(threadId);
    });
  }

  /** Sync; when BB or Slack is unreachable, rebuild from saved state and try again later. */
  async #syncOrRetry(threadId: string): Promise<void> {
    const runtime = this.#runtime(threadId);
    try {
      await this.#sync(threadId);
      runtime.retries = 0;
    } catch (error) {
      // Effects applied after the last save are replayed from the saved cursor.
      runtime.hydrated = false;
      const delay = RETRY_DELAYS_MS[Math.min(runtime.retries, RETRY_DELAYS_MS.length - 1)] ?? 60_000;
      runtime.retries += 1;
      this.#o.log.warn(`sync for ${threadId} failed (${errorText(error)}); retrying in ${delay / 1000}s`);
      clearTimeout(runtime.retryTimer);
      if (this.#disposed) return;
      runtime.retryTimer = setTimeout(() => this.#queueSync(threadId), delay);
      runtime.retryTimer.unref?.();
    }
  }

  async #sync(threadId: string): Promise<void> {
    const binding = await this.#o.store.get(threadId);
    if (!binding?.mirrored) return;
    const runtime = this.#runtime(threadId);
    if (!runtime.hydrated) await this.#hydrate(binding, runtime);
    else runtime.tracker.mode = this.#prefs.replies;

    for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
      const rows = await this.#rows(threadId, binding.lastSeq);
      for (const row of rows) {
        const posted = await this.#apply(binding, runtime.tracker.onRow(row));
        binding.lastSeq = Math.max(binding.lastSeq, row.seq);
        // Persist after every post so a crash never mirrors a message twice.
        if (posted) await this.#saveCursor(binding, runtime);
      }
      if (rows.length > 0) await this.#saveCursor(binding, runtime);
      if (rows.length < EVENT_PAGE) break;
      if (page === MAX_PAGES_PER_SYNC - 1) this.#queueSync(threadId);
    }
    if (runtime.idleSeen && runtime.tracker.turn) {
      // The provider went idle without turn/completed; its held reply still goes out.
      const posted = await this.#apply(binding, runtime.tracker.finish(binding.lastSeq, "completed"));
      await this.#saveCursor(binding, runtime);
      if (posted) this.#o.log.info(`finished ${threadId}'s turn on idle`);
    }
    if (runtime.tracker.turn?.dirty) this.#scheduleCard(threadId);
    await this.#syncInteractions(binding);
    await this.#updateStatusLine(binding, runtime);
  }

  /** Rebuild the turn in progress from its first event, without posting. */
  async #hydrate(binding: Binding, runtime: Runtime): Promise<void> {
    runtime.hydrated = true;
    const mode = this.#prefs.replies;
    runtime.tracker = new TurnTracker(binding.turn?.mode ?? mode);
    if (binding.turn) {
      let cursor = Math.max(0, binding.turn.startSeq - 1);
      replay: for (let page = 0; page < MAX_HYDRATE_PAGES && cursor < binding.lastSeq; page += 1) {
        const rows = await this.#rows(binding.threadId, cursor);
        for (const row of rows) {
          if (row.seq > binding.lastSeq) break replay;
          runtime.tracker.onRow(row);
          cursor = row.seq;
        }
        if (rows.length < EVENT_PAGE) break;
      }
    }
    runtime.tracker.mode = mode;
  }

  async #rows(threadId: string, afterSeq: number): Promise<Row[]> {
    const rows = await this.#o.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      limit: String(EVENT_PAGE),
      types: [...TRACKED_EVENT_TYPES] as [(typeof TRACKED_EVENT_TYPES)[number], ...(typeof TRACKED_EVENT_TYPES)[number][]],
    });
    return rows as unknown as Row[];
  }

  async #saveCursor(binding: Binding, runtime: Runtime): Promise<void> {
    const turn = runtime.tracker.turn;
    const mode = binding.turn && turn && binding.turn.startSeq === turn.startSeq ? binding.turn.mode : runtime.tracker.mode;
    binding.turn = turn ? { startSeq: turn.startSeq, mode } : null;
    await this.#o.store.save(binding);
  }

  /** Apply tracker effects; true when something was posted. */
  async #apply(binding: Binding, effects: Effect[]): Promise<boolean> {
    const runtime = this.#runtime(binding.threadId);
    let posted = false;
    for (const effect of effects) {
      switch (effect.kind) {
        case "message": {
          if (effect.initiator === "user" && this.#consumeEcho(runtime, effect.text)) break;
          const label = effect.initiator === "user" ? "💬 You" : "🤖 From another thread";
          const attachments = effect.attachments > 0 ? `\n\n_📎 ${effect.attachments} attachment${effect.attachments === 1 ? "" : "s"}_` : "";
          await this.#postMarkdown(binding, `${effect.text}${attachments}`.trim(), { lead: [{ type: "text", text: label, style: { bold: true } }] });
          posted = true;
          break;
        }
        case "reply": {
          const title = await this.#title(binding.threadId);
          await this.#postMarkdown(binding, effect.text, { notify: title, prefix: effect.final ? "✅" : "💬" });
          posted = true;
          break;
        }
        case "turnStarted":
          runtime.idleSeen = false;
          runtime.phase = "working";
          runtime.override = {};
          runtime.waiting = undefined;
          for (const reaction of runtime.reactions) {
            if (reaction.state !== "queued") continue;
            reaction.state = "running";
            await this.#o.outbox.unreact(reaction.channel, reaction.ts, "hourglass_flowing_sand");
            await this.#o.outbox.react(reaction.channel, reaction.ts, "eyes");
          }
          this.#scheduleCard(binding.threadId, true);
          break;
        case "turnFinished": {
          const turn = runtime.tracker.turn;
          if (turn) runtime.lastTurn = { status: effect.status, durationMs: turn.lastAt - turn.startedAt, steps: turn.steps.length };
          runtime.tracker.clear();
          runtime.phase = effect.status === "completed" ? "done" : effect.status === "failed" ? "error" : "stopped";
          if (effect.status === "failed" && effect.error && runtime.lastError !== effect.error) {
            runtime.lastError = effect.error;
            const title = await this.#title(binding.threadId);
            await this.#postNotice(binding, `🔴 *Turn failed:* ${escapeMrkdwn(truncate(effect.error, 2_800))}`, notification("🔴", title, effect.error));
            posted = true;
          }
          await this.#settleReactions(runtime, effect.status);
          this.#scheduleCard(binding.threadId, true);
          break;
        }
        case "titleChanged":
          this.#scheduleCard(binding.threadId, true);
          this.#scheduleHome();
          break;
      }
    }
    return posted;
  }

  async #settleReactions(runtime: Runtime, status: "completed" | "failed" | "interrupted"): Promise<void> {
    const done = status === "completed" ? "white_check_mark" : status === "failed" ? "warning" : "black_square_for_stop";
    const remaining: Reaction[] = [];
    for (const reaction of runtime.reactions) {
      if (reaction.state !== "running") {
        remaining.push(reaction);
        continue;
      }
      await this.#o.outbox.unreact(reaction.channel, reaction.ts, "eyes");
      await this.#o.outbox.react(reaction.channel, reaction.ts, done);
    }
    runtime.reactions = remaining;
  }

  /** Slack's native "is working…" line under the thread, while a turn runs. */
  async #updateStatusLine(binding: Binding, runtime: Runtime): Promise<void> {
    const live = runtime.phase === "working" && !runtime.waiting && !this.#paused;
    const activity = runtime.tracker.turn?.activity ?? "Working";
    const text = live ? `is ${activity.charAt(0).toLowerCase()}${activity.slice(1)}…` : "";
    await this.#o.outbox.status(binding.channelId, binding.rootTs, truncate(text, 100), this.#now);
  }

  // -------------------------------------------------------------------------
  // Interaction cards

  async #postInteraction(binding: Binding, interaction: PendingInteraction, title: string): Promise<void> {
    const posted = await this.#o.outbox.post({ channel: binding.channelId, threadTs: binding.rootTs }, interactionCard(binding.threadId, title, interaction));
    if (!posted) return;
    binding.cards[interaction.id] = { ts: posted.ts, kind: cardKind(interaction) };
    await this.#o.store.save(binding);
  }

  /** Post cards for new pending interactions and close cards resolved elsewhere. */
  async #syncInteractions(binding: Binding): Promise<void> {
    if (!binding.mirrored) return;
    let pending: PendingInteraction[];
    try {
      pending = (await this.#o.sdk.threads.interactions.list({ threadId: binding.threadId })) as PendingInteraction[];
    } catch (error) {
      this.#o.log.warn(`could not list interactions for ${binding.threadId}: ${errorText(error)}`);
      return;
    }
    const open = pending.filter((interaction) => interaction.status === "pending");
    const openIds = new Set(open.map((interaction) => interaction.id));
    const title = await this.#title(binding.threadId);
    let changed = false;
    for (const [interactionId, card] of Object.entries(binding.cards)) {
      if (openIds.has(interactionId)) continue;
      const interaction = (await this.#o.sdk.threads.interactions.get({ threadId: binding.threadId, interactionId }).catch(() => undefined)) as PendingInteraction | undefined;
      if (interaction) await this.#o.outbox.update(binding.channelId, card.ts, interactionCard(binding.threadId, title, interaction, describeOutcome(interaction)));
      delete binding.cards[interactionId];
      changed = true;
    }
    if (changed) await this.#o.store.save(binding);
    for (const interaction of open) {
      if (!binding.cards[interaction.id]) await this.#postInteraction(binding, interaction, title);
    }
    const runtime = this.#runtime(binding.threadId);
    const waiting = open.length === 0 ? undefined : open.some((item) => cardKind(item) === "approval") ? "approval" : "question";
    if (waiting !== runtime.waiting) {
      runtime.waiting = waiting;
      this.#scheduleCard(binding.threadId, true);
    }
  }

  async #resolve(threadId: string, interactionId: string, resolution: Resolution, outcome: string): Promise<void> {
    const interaction = (await this.#o.sdk.threads.interactions.resolve({ threadId, interactionId, resolution: resolution as InteractionResolution })) as PendingInteraction;
    await this.#serial(threadId, async () => {
      const binding = await this.#o.store.get(threadId);
      const card = binding?.cards[interactionId];
      if (!binding || !card) return;
      await this.#o.outbox.update(binding.channelId, card.ts, interactionCard(threadId, await this.#title(threadId), interaction, `${outcome} · from Slack`));
      delete binding.cards[interactionId];
      await this.#o.store.save(binding);
      this.#runtime(threadId).waiting = undefined;
      this.#scheduleCard(threadId, true);
    });
  }

  // -------------------------------------------------------------------------
  // Slack inbound

  /** Socket Mode envelope handler; returns the acknowledgement payload, if any. */
  handleEnvelope(envelope: SocketEnvelope): unknown {
    if (this.#disposed) return undefined;
    if (envelope.type === "events_api") {
      const body = envelope.payload as { event_id?: string; event?: unknown } | undefined;
      if (body?.event_id && this.#isDuplicate(body.event_id)) return undefined;
      const event = body?.event as { type?: string; tab?: string } | undefined;
      if (event?.type === "message") this.#track(this.#onMessage(event).catch((error) => this.#o.log.error(`Slack message failed: ${errorText(error)}`)));
      if (event?.type === "app_home_opened" && event.tab === "home") this.#scheduleHome(0);
      return undefined;
    }
    if (envelope.type === "interactive") {
      const payload = envelope.payload as { type?: string } | undefined;
      if (payload?.type === "block_actions") {
        this.#track(this.#onAction(payload).catch((error) => this.#o.log.error(`Slack action failed: ${errorText(error)}`)));
        return undefined;
      }
      if (payload?.type === "view_submission") return this.#onViewSubmission(payload);
    }
    return undefined;
  }

  async #onMessage(raw: unknown): Promise<void> {
    const parsed = MessageEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.bot_id || (message.subtype && message.subtype !== "file_share" && message.subtype !== "thread_broadcast")) return;
    if (message.channel_type && message.channel_type !== "im") return;
    const prefs = this.#prefs;
    if (message.user !== prefs.userId) {
      this.#o.log.warn(`ignored a Slack message from unauthorised user ${message.user ?? "unknown"}`);
      return;
    }
    const text = slackMessageToMarkdown(message.text, message.blocks);
    if (!message.thread_ts) {
      await this.#startFromDm(message, text);
      return;
    }
    const binding = await this.#o.store.bySlackThread(message.channel, message.thread_ts);
    if (!binding) return;
    if (!binding.mirrored) {
      await this.#o.outbox.ephemeral(message.channel, prefs.userId, "This thread is not mirrored. Use Resume mirroring on its card first.", binding.rootTs);
      return;
    }
    await this.#inOrder(binding.threadId, async () => {
      const command = message.files.length === 0 ? parseThreadCommand(text) : undefined;
      if (command) {
        await this.#runCommand(binding, command, message);
        return;
      }
      if (message.files.length === 0 && (await this.#answerFromReply(binding, text, message))) return;
      await this.#deliver(binding, message, text);
    });
  }

  /** Handle Slack messages for one thread one at a time, so a slow upload cannot reorder them. */
  #inOrder(threadId: string, task: () => Promise<void>): Promise<void> {
    const next = (this.#inbound.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.#inbound.set(threadId, next);
    void next.finally(() => {
      if (this.#inbound.get(threadId) === next) this.#inbound.delete(threadId);
    }).catch(() => undefined);
    return next;
  }

  async #deliver(binding: Binding, message: MessageEvent, text: string): Promise<void> {
    const prompt = await this.#prompt(binding, binding.projectId, text, message);
    if (!prompt) return;
    const runtime = this.#runtime(binding.threadId);
    this.#rememberEcho(runtime, prompt.text);
    try {
      const result = await this.#o.sdk.threads.send({ threadId: binding.threadId, mode: "auto", input: prompt.input });
      const queued = result.delivery === "queued";
      await this.#o.outbox.react(message.channel, message.ts, queued ? "hourglass_flowing_sand" : "eyes");
      runtime.reactions.push({ channel: message.channel, ts: message.ts, state: queued ? "queued" : "running" });
      if (!queued && runtime.phase !== "working") {
        runtime.phase = "starting";
        this.#scheduleCard(binding.threadId, true);
      }
    } catch (error) {
      this.#consumeEcho(runtime, prompt.text);
      await this.#o.outbox.react(message.channel, message.ts, "warning");
      await this.#o.outbox.ephemeral(message.channel, this.#prefs.userId, `Could not send your message: ${errorText(error)}`, binding.rootTs);
    }
  }

  /** Build prompt input from a Slack message: text, transcribed voice memos and attachments. */
  async #prompt(binding: Pick<Binding, "channelId" | "rootTs">, projectId: string, text: string, message: Pick<MessageEvent, "files" | "channel">): Promise<{ text: string; input: PromptInput[] } | undefined> {
    const files = message.files.length > 0 ? await collectFiles({ files: message.files, projectId, slack: this.#o.outbox.slack, sdk: this.#o.sdk }) : undefined;
    const fullText = [text, ...(files?.transcripts ?? [])].filter(Boolean).join("\n\n").trim();
    if (files && files.skipped.length > 0) {
      await this.#o.outbox.ephemeral(message.channel, this.#prefs.userId, `Skipped ${files.skipped.length === 1 ? "an attachment" : "attachments"}: ${files.skipped.join(", ")}`, binding.rootTs);
    }
    if (files && files.transcripts.length > 0) {
      await this.#o.outbox.ephemeral(message.channel, this.#prefs.userId, `🎙️ Heard: ${truncate(files.transcripts.join(" "), 2_500)}`, binding.rootTs);
    }
    const input: PromptInput[] = [];
    if (fullText) input.push({ type: "text", text: fullText, mentions: [] });
    input.push(...(files?.inputs ?? []));
    return input.length > 0 ? { text: fullText, input } : undefined;
  }

  async #startFromDm(message: MessageEvent, text: string): Promise<void> {
    if (!text && message.files.length === 0) return;
    const projectId = await this.#defaultProject();
    if (projectId) {
      await this.#spawn(projectId, text, message.files, { channelId: message.channel, ts: message.ts });
      return;
    }
    this.#pendingPrompts.set(message.ts, { text, files: message.files });
    await this.#o.outbox.post(
      { channel: message.channel, threadTs: message.ts },
      {
        text: "Choose a project for this thread",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "Which project should this thread run in? Set a default project in Slackoff's settings to skip this." } },
          { type: "actions", elements: [{ type: "button", action_id: ACTION.newThread, text: { type: "plain_text", text: "Choose project" }, value: `${message.channel}|${message.ts}`, style: "primary" }] },
        ],
      },
    );
  }

  async #defaultProject(): Promise<string | undefined> {
    const projects = await this.#catalog.projects();
    const known = (id: string | undefined) => (id && projects.some((project) => project.id === id) ? id : undefined);
    return known(this.#prefs.defaultProjectId) ?? known(await this.#o.store.lastProjectId()) ?? (projects.length === 1 ? projects[0]?.id : undefined);
  }

  async #spawn(projectId: string, text: string, files: readonly SlackFile[], root?: { channelId: string; ts: string }): Promise<Binding> {
    const place = root ? { channelId: root.channelId, rootTs: root.ts } : { channelId: this.#prefs.userId, rootTs: "" };
    const prompt = await this.#prompt(place, projectId, text, { files: [...files], channel: place.channelId });
    if (!prompt) throw new Error("The message had nothing to send");
    const thread = await this.#o.sdk.threads.spawn({ projectId, environment: { type: "project-default" }, input: prompt.input });
    await this.#o.store.setLastProjectId(projectId);
    const runtime = this.#runtime(thread.id);
    // A prompt typed in Slack is already visible there; one from the form is not.
    if (root) this.#rememberEcho(runtime, prompt.text);
    const binding = await this.enable(thread.id, { fromStart: true, ...(root ? { root } : {}) });
    if (root) {
      await this.#o.outbox.react(root.channelId, root.ts, "eyes");
      runtime.reactions.push({ channel: root.channelId, ts: root.ts, state: "running" });
    }
    this.#queueSync(thread.id);
    return binding;
  }

  async #runCommand(binding: Binding, command: ThreadCommand, message: MessageEvent): Promise<void> {
    const threadId = binding.threadId;
    const tell = (text: string) => this.#o.outbox.ephemeral(message.channel, this.#prefs.userId, text, binding.rootTs);
    switch (command.kind) {
      case "stop":
        await this.#stop(threadId);
        await this.#o.outbox.react(message.channel, message.ts, "black_square_for_stop");
        return;
      case "close":
        await this.disable(threadId);
        return;
      case "compact":
        await this.#o.sdk.threads.compact({ threadId });
        await this.#o.outbox.react(message.channel, message.ts, "white_check_mark");
        return;
      case "help":
        await tell(COMMAND_HELP);
        return;
      case "status":
        this.#queueSync(threadId);
        this.#scheduleCard(threadId, true);
        await this.#o.outbox.react(message.channel, message.ts, "white_check_mark");
        return;
      case "model":
      case "effort": {
        const problem = await this.#setExecution(threadId, command.kind === "model" ? { model: command.model } : { effort: command.level });
        if (problem) await tell(problem);
        else await this.#o.outbox.react(message.channel, message.ts, "white_check_mark");
        return;
      }
    }
  }

  async #stop(threadId: string): Promise<void> {
    this.#runtime(threadId).phase = "stopping";
    this.#scheduleCard(threadId, true);
    await this.#o.sdk.threads.stop({ threadId });
  }

  async #answerFromReply(binding: Binding, text: string, message: MessageEvent): Promise<boolean> {
    const questionCard = Object.entries(binding.cards).find(([, card]) => card.kind === "question");
    if (!questionCard || !text) return false;
    const [interactionId] = questionCard;
    const interaction = (await this.#o.sdk.threads.interactions.get({ threadId: binding.threadId, interactionId }).catch(() => undefined)) as PendingInteraction | undefined;
    if (!interaction || interaction.status !== "pending") return false;
    const answer = answerFromReply(interaction, text);
    if (!answer.ok) {
      await this.#o.outbox.ephemeral(message.channel, this.#prefs.userId, answer.message, binding.rootTs);
      return true;
    }
    await this.#resolve(binding.threadId, interactionId, { kind: "user_answer", answers: answer.answers }, `Answered: ${answer.summary}`);
    await this.#o.outbox.react(message.channel, message.ts, "white_check_mark");
    return true;
  }

  async #onAction(raw: unknown): Promise<void> {
    const parsed = ActionPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    const payload = parsed.data;
    const prefs = this.#prefs;
    if (payload.user.id !== prefs.userId) return;
    const action = payload.actions[0];
    if (!action) return;
    const value = action.value ?? "";
    const cardThread = action.block_id?.startsWith("ctl:") ? action.block_id.slice(4) : value;
    // Buttons that share a block carry a unique suffix: "slackoff_approve:deny".
    switch (action.action_id.split(":")[0]) {
      case ACTION.stop:
        await this.#stop(value);
        return;
      case ACTION.resume:
        await this.enable(value);
        return;
      case ACTION.open:
        await this.#showInBb(value, payload);
        return;
      case ACTION.more: {
        const choice = action.selected_option?.value;
        if (choice === MORE.open && !prefs.appUrl) await this.#showInBb(cardThread, payload);
        if (choice === MORE.compact) await this.#o.sdk.threads.compact({ threadId: cardThread });
        if (choice === MORE.stopMirroring) await this.disable(cardThread);
        return;
      }
      case ACTION.model:
      case ACTION.effort: {
        const selected = action.selected_option?.value;
        if (!selected || !cardThread) return;
        const problem = await this.#setExecution(cardThread, action.action_id === ACTION.model ? { model: selected } : { effort: selected });
        if (problem && payload.channel) await this.#o.outbox.ephemeral(payload.channel.id, prefs.userId, problem, payload.container?.thread_ts);
        return;
      }
      case ACTION.approve: {
        const [threadId = "", interactionId = "", decision = ""] = value.split("|");
        const interaction = (await this.#o.sdk.threads.interactions.get({ threadId, interactionId })) as PendingInteraction;
        if (interaction.status !== "pending") {
          await this.#serial(threadId, async () => {
            const binding = await this.#o.store.get(threadId);
            if (binding) await this.#syncInteractions(binding);
          });
          return;
        }
        const label = decision === "deny" ? "✗ Denied" : decision === "allow_for_session" ? "✓ Allowed for this session" : "✓ Allowed";
        await this.#resolve(threadId, interactionId, approvalResolution(interaction, decision as ApprovalDecision), label);
        return;
      }
      case ACTION.answer: {
        const [threadId = "", interactionId = "", questionIndex = "0", optionIndex = "0"] = value.split("|");
        const interaction = (await this.#o.sdk.threads.interactions.get({ threadId, interactionId })) as PendingInteraction;
        const question = questionsOf(interaction)[Number.parseInt(questionIndex, 10)];
        const choice = question?.options[Number.parseInt(optionIndex, 10)];
        if (!question || !choice || interaction.status !== "pending") return;
        await this.#resolve(threadId, interactionId, { kind: "user_answer", answers: { [question.id]: { selected: [choice.value] } } }, `Answered: ${choice.label}`);
        return;
      }
      case ACTION.answerModal: {
        const [threadId = "", interactionId = ""] = value.split("|");
        const interaction = (await this.#o.sdk.threads.interactions.get({ threadId, interactionId })) as PendingInteraction;
        if (interaction.status !== "pending" || !payload.trigger_id) return;
        await this.#o.outbox.openModal(payload.trigger_id, buildAnswerModal(threadId, interactionId, questionsOf(interaction)));
        return;
      }
      case ACTION.newThread: {
        if (!payload.trigger_id) return;
        const origin = value.includes("|") ? value : undefined;
        const pending = origin ? this.#pendingPrompts.get(origin.split("|")[1] ?? "") : undefined;
        const modal = buildNewThreadModal({
          projects: await this.#catalog.projects(),
          projectId: prefs.defaultProjectId ?? (await this.#o.store.lastProjectId()),
          ...(pending?.text ? { prompt: pending.text } : {}),
          ...(origin ? { origin } : {}),
        });
        await this.#o.outbox.openModal(payload.trigger_id, modal);
        return;
      }
      case ACTION.mirrorThread: {
        if (!payload.trigger_id) return;
        await this.#o.outbox.openModal(payload.trigger_id, buildMirrorModal(await this.#catalog.recentThreads(this.#mirrored)));
        return;
      }
    }
  }

  async #showInBb(threadId: string, payload: ActionPayload): Promise<void> {
    const result = await this.#o.sdk.threads.open({ threadId, file: null });
    if (result.delivered === 0 && payload.channel) {
      await this.#o.outbox.ephemeral(payload.channel.id, payload.user.id, "No BB window is open to show this thread.", payload.container?.thread_ts);
    }
  }

  #onViewSubmission(raw: unknown): unknown {
    const parsed = ViewPayloadSchema.safeParse(raw);
    if (!parsed.success || parsed.data.user.id !== this.#prefs.userId) return undefined;
    const { view } = parsed.data;
    const values = view.state.values;

    if (view.callback_id === VIEW.newThread) {
      const projectId = values[NEW_THREAD_FIELDS.projectBlock]?.[NEW_THREAD_FIELDS.projectInput]?.selected_option?.value as string | undefined;
      const prompt = (values[NEW_THREAD_FIELDS.promptBlock]?.[NEW_THREAD_FIELDS.promptInput]?.value as string | undefined)?.trim() ?? "";
      if (!projectId) return { response_action: "errors", errors: { [NEW_THREAD_FIELDS.projectBlock]: "Choose a project." } };
      if (!prompt) return { response_action: "errors", errors: { [NEW_THREAD_FIELDS.promptBlock]: "Tell the agent what to do." } };
      const [channelId, ts] = view.private_metadata.split("|");
      const root = channelId && ts ? { channelId, ts } : undefined;
      const files = ts ? (this.#pendingPrompts.get(ts)?.files ?? []) : [];
      if (ts) this.#pendingPrompts.delete(ts);
      this.#track(
        this.#spawn(projectId, prompt, files, root).then(
          () => this.#notice("Started a new BB thread. Find it in the Messages tab."),
          (error: unknown) => this.#notice(`Could not start the thread: ${errorText(error)}`),
        ),
      );
      return undefined;
    }

    if (view.callback_id === VIEW.mirror) {
      const threadId = values[MIRROR_FIELDS.block]?.[MIRROR_FIELDS.input]?.selected_option?.value as string | undefined;
      if (!threadId) return { response_action: "errors", errors: { [MIRROR_FIELDS.block]: "Choose a thread." } };
      this.#track(
        this.enable(threadId).then(
          () => this.#notice("Mirroring started. Find the thread in the Messages tab."),
          (error: unknown) => this.#notice(`Could not mirror the thread: ${errorText(error)}`),
        ),
      );
      return undefined;
    }

    if (view.callback_id === VIEW.answer) {
      const [threadId = "", interactionId = ""] = view.private_metadata.split("|");
      return (async () => {
        const interaction = (await this.#o.sdk.threads.interactions.get({ threadId, interactionId })) as PendingInteraction;
        if (interaction.status !== "pending") return undefined;
        const result = answersFromModal(questionsOf(interaction), values);
        if (!result.ok) return { response_action: "errors", errors: result.errors };
        this.#track(
          this.#resolve(threadId, interactionId, { kind: "user_answer", answers: result.answers }, "Answered").catch((error) => this.#o.log.error(`answer failed: ${errorText(error)}`)),
        );
        return undefined;
      })();
    }
    return undefined;
  }

  async #setExecution(threadId: string, change: { model?: string; effort?: string }): Promise<string | undefined> {
    const thread = await this.#o.sdk.threads.get({ threadId });
    const catalog = await this.#catalog.models(thread);
    const options = await this.#o.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
    const runtime = this.#runtime(threadId);
    const override = { ...runtime.override };
    if (change.model) {
      const model = catalog.find((entry) => entry.model === change.model || entry.id === change.model);
      if (!model) return `Unknown model \`${change.model}\`. Pick one from the status card.`;
      await this.#o.sdk.threads.update({ threadId, model: model.model });
      override.model = model.model;
      const effort = override.effort ?? options?.reasoningLevel;
      if (effort && !model.supportedReasoningEfforts.some((level) => level.reasoningEffort === effort)) override.effort = model.defaultReasoningEffort;
    }
    if (change.effort) {
      const model = catalog.find((entry) => entry.model === (override.model ?? options?.model));
      const levels = model?.supportedReasoningEfforts.map((level) => level.reasoningEffort) ?? [];
      if (levels.length > 0 && !levels.includes(change.effort)) return `Effort \`${change.effort}\` is not available for this model.`;
      await this.#o.sdk.threads.update({ threadId, reasoningLevel: change.effort as ReasoningLevel });
      override.effort = change.effort;
    }
    runtime.override = override;
    this.#scheduleCard(threadId, true);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Status card and App Home

  /**
   * Refresh the status card. Live progress refreshes are spaced out to stay
   * inside Slack's update rate limit; status changes (`soon`) go out quickly.
   */
  #scheduleCard(threadId: string, soon = false): void {
    if (this.#disposed) return;
    const runtime = this.#runtime(threadId);
    const interval = this.#o.cardIntervalMs ?? DEFAULT_CARD_INTERVAL_MS;
    const wait = soon ? Math.min(interval, 500) : Math.max(0, runtime.lastCardAt + interval * this.#liveThreads() - this.#now);
    if (runtime.cardTimer) {
      if (!soon) return;
      clearTimeout(runtime.cardTimer);
    }
    runtime.cardTimer = setTimeout(() => {
      runtime.cardTimer = undefined;
      void this.#serial(threadId, async () => {
        const binding = await this.#o.store.get(threadId);
        if (!binding) return;
        await this.#refreshCard(binding);
        await this.#updateStatusLine(binding, runtime);
      });
      this.#scheduleHome();
    }, wait);
    runtime.cardTimer.unref?.();
  }

  /** Busy threads share Slack's update budget. */
  #liveThreads(): number {
    let live = 0;
    for (const runtime of this.#runtimes.values()) if (runtime.phase === "working") live += 1;
    return Math.max(1, Math.ceil(live / 2));
  }

  async #refreshCard(binding: Binding, known?: ThreadResponse): Promise<void> {
    if (this.#disposed) return;
    const thread = known ?? (await this.#o.sdk.threads.get({ threadId: binding.threadId }).catch(() => undefined));
    if (!thread) return;
    this.#runtime(binding.threadId).lastCardAt = this.#now;
    if (thread.title) this.#titles.set(thread.id, threadTitle(thread));
    await this.#o.outbox.update(binding.channelId, binding.cardTs, buildThreadCard(await this.#cardState(thread, binding.mirrored)));
  }

  async #title(threadId: string): Promise<string> {
    const cached = this.#titles.get(threadId);
    if (cached) return cached;
    const thread = await this.#o.sdk.threads.get({ threadId }).catch(() => undefined);
    const title = thread ? threadTitle(thread) : "BB thread";
    if (thread?.title) this.#titles.set(threadId, title);
    return title;
  }

  #statusOf(threadId: string, thread: ThreadResponse | undefined): { status: CardStatus; activity: string | undefined } {
    const runtime = this.#runtimes.get(threadId);
    if (this.#paused) return { status: "paused", activity: undefined };
    if (thread?.archivedAt) return { status: "archived", activity: undefined };
    const phase = runtime?.phase ?? (thread ? phaseFromThread(thread) : "idle");
    if (runtime?.waiting) return { status: "waiting", activity: runtime.waiting === "approval" ? "Approve or deny below" : "Answer below" };
    switch (phase) {
      case "starting":
        return { status: "starting", activity: undefined };
      case "working":
        return { status: "working", activity: runtime?.tracker.turn?.activity };
      case "stopping":
        return { status: "stopping", activity: undefined };
      case "done":
        return { status: "done", activity: undefined };
      case "error":
        return { status: "error", activity: undefined };
      case "archived":
        return { status: "archived", activity: undefined };
      default:
        return { status: "idle", activity: undefined };
    }
  }

  async #cardState(thread: ThreadResponse, mirrored: boolean): Promise<ThreadCardState> {
    const prefs = this.#prefs;
    const runtime = this.#runtime(thread.id);
    const project = await this.#catalog.project(thread.projectId);
    const catalog = await this.#catalog.models(thread);
    const options = await this.#o.sdk.threads.defaultExecutionOptions({ threadId: thread.id }).catch(() => null);
    const modelId = runtime.override.model ?? options?.model;
    const current = catalog.find((entry) => entry.model === modelId);
    const { status, activity } = this.#statusOf(thread.id, thread);
    const turn = runtime.tracker.turn;
    return {
      threadId: thread.id,
      title: threadTitle(thread),
      projectName: project.name,
      status,
      activity,
      model: current ? { id: current.model, name: current.displayName } : modelId ? { id: modelId, name: modelId } : undefined,
      effort: runtime.override.effort ?? options?.reasoningLevel,
      models: catalog.map((entry) => ({ id: entry.model, name: entry.displayName })),
      efforts: current?.supportedReasoningEfforts.map((level) => level.reasoningEffort) ?? [],
      progress: turn
        ? { startedAt: turn.startedAt, now: Math.max(turn.lastAt, this.#now), steps: turn.steps, plan: turn.plan, update: turn.update, showSteps: prefs.showActivity }
        : undefined,
      lastTurn: runtime.lastTurn,
      appLink: prefs.appUrl ? threadLink(prefs.appUrl, thread, project.kind) : undefined,
      mirrored,
    };
  }

  #scheduleHome(delay = 2_000): void {
    if (this.#disposed) return;
    clearTimeout(this.#homeTimer);
    this.#homeTimer = setTimeout(() => {
      this.#homeTimer = undefined;
      this.#track(this.#publishHome().catch((error) => this.#o.log.warn(`App Home update failed: ${errorText(error)}`)));
    }, delay);
    this.#homeTimer.unref?.();
  }

  async #publishHome(): Promise<void> {
    const userId = this.#prefs.userId;
    if (!userId) return;
    const threads = (await this.summaries()).map(({ title, projectName, status, activity, permalink }) => ({
      title,
      projectName,
      status,
      activity,
      ...(permalink ? { permalink } : {}),
    }));
    await this.#o.outbox.publishHome(userId, buildHomeView({ threads, notice: this.#homeNotice }));
  }

  #notice(message: string): void {
    this.#o.log.info(message);
    this.#homeNotice = message;
    this.#scheduleHome(0);
  }

  // -------------------------------------------------------------------------
  // Slack output helpers

  async #postMarkdown(binding: Binding, markdown: string, options: { lead?: RichTextInline[]; notify?: string; prefix?: string } = {}): Promise<void> {
    const messages = markdownToSlackMessages(markdown, options.lead ? { lead: options.lead } : {});
    for (const [index, message] of messages.entries()) {
      // The first message's text is what a phone shows; lead with the thread title.
      const text = index === 0 && options.notify ? notification(options.prefix ?? "💬", options.notify, markdownToPlainText(markdown)) : message.text;
      await this.#o.outbox.post({ channel: binding.channelId, threadTs: binding.rootTs }, { ...message, text });
    }
  }

  async #postNotice(binding: Binding, mrkdwn: string, text: string): Promise<void> {
    await this.#o.outbox.post({ channel: binding.channelId, threadTs: binding.rootTs }, { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: mrkdwn } }] });
  }

  async #latestSeq(threadId: string): Promise<number> {
    const rows = await this.#o.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
    return rows[0]?.seq ?? 0;
  }

  async #markDeleted(binding: Binding): Promise<void> {
    await this.#o.outbox.update(binding.channelId, binding.cardTs, {
      text: "Deleted in BB",
      blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: `🗑️ This BB thread was deleted. \`${escapeMrkdwn(binding.threadId)}\`` }] }],
    });
    await this.#o.store.remove(binding);
    this.#mirrored.delete(binding.threadId);
    this.#runtimes.delete(binding.threadId);
    this.#changed(binding.threadId);
  }

  // -------------------------------------------------------------------------
  // Plumbing

  #runtime(threadId: string): Runtime {
    let runtime = this.#runtimes.get(threadId);
    if (!runtime) {
      runtime = {
        tracker: new TurnTracker(this.#prefs.replies),
        hydrated: false,
        phase: "idle",
        waiting: undefined,
        lastTurn: undefined,
        echo: [],
        reactions: [],
        lastError: undefined,
        override: {},
        cardTimer: undefined,
        lastCardAt: 0,
        syncQueued: false,
        retryTimer: undefined,
        retries: 0,
        idleSeen: false,
      };
      this.#runtimes.set(threadId, runtime);
    }
    return runtime;
  }

  /** Run work for one thread after everything already queued for it. */
  #serial<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.#chains.get(threadId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(task);
    const settled = next.then(
      () => undefined,
      (error: unknown) => this.#o.log.error(`Slackoff work for ${threadId} failed: ${errorText(error)}`),
    );
    this.#chains.set(threadId, settled);
    void settled.then(() => {
      if (this.#chains.get(threadId) === settled) this.#chains.delete(threadId);
    });
    return next;
  }

  /** Keep a fire-and-forget task observable to idle(). */
  #track(task: Promise<unknown>): void {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #changed(threadId: string): void {
    this.#o.publish?.(threadId);
    this.#scheduleHome();
  }

  #rememberEcho(runtime: Runtime, text: string): void {
    runtime.echo = [...runtime.echo, normalize(text)].slice(-20);
  }

  #consumeEcho(runtime: Runtime, text: string): boolean {
    const index = runtime.echo.indexOf(normalize(text));
    if (index === -1) return false;
    runtime.echo.splice(index, 1);
    return true;
  }

  #isDuplicate(eventId: string): boolean {
    const now = this.#now;
    for (const [id, expiry] of this.#seenEvents) if (expiry <= now) this.#seenEvents.delete(id);
    if (this.#seenEvents.has(eventId)) return true;
    this.#seenEvents.set(eventId, now + 30 * 60_000);
    return false;
  }
}

function phaseFromThread(thread: ThreadResponse): Phase {
  if (thread.archivedAt !== null) return "archived";
  switch (thread.status) {
    case "active":
      return "working";
    case "starting":
    case "pending":
      return "starting";
    case "stopping":
      return "stopping";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

