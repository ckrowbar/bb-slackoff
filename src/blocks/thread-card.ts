// The status card: one per mirrored thread, updated in place so it never
// notifies. While the agent works it shows live progress (activity, plan,
// recent steps and the agent's latest update), so the Slack thread itself
// stays a clean conversation and the DM list doubles as a live dashboard.
//
// Laid out for a phone: title, one status line, one detail line, progress,
// then a single row of controls with secondary actions in the ⋯ menu.
import { markdownToSlackMessages } from "../format/markdown.ts";
import { escapeMrkdwn, truncate } from "../format/mrkdwn.ts";
import type { ActionElement, KnownBlock, Option, SlackMessage } from "../slack/types.ts";
import type { PlanStep, Step, TurnStatus } from "../turn.ts";
import { ACTION, MORE, NO_SECTION, STATUS_EMOJI, button, context, isLive, option, plain, section, select, statusText, type CardStatus } from "./common.ts";

export interface ModelChoice {
  id: string;
  name: string;
}

export interface Progress {
  startedAt: number;
  now: number;
  steps: readonly Step[];
  plan: readonly PlanStep[];
  /** The agent's latest update ("final" reply mode). */
  update: string | undefined;
  showSteps: boolean;
}

export interface LastTurn {
  status: TurnStatus;
  durationMs: number;
  steps: number;
}

export interface ThreadCardState {
  threadId: string;
  title: string;
  projectName: string;
  status: CardStatus;
  activity?: string | undefined;
  model?: ModelChoice | undefined;
  effort?: string | undefined;
  models: readonly ModelChoice[];
  efforts: readonly string[];
  /** BB sidebar sections the thread can move to, and the one it is in. */
  sections: readonly { id: string; name: string }[];
  sectionId: string | null;
  /** Live progress while a turn runs. */
  progress?: Progress | undefined;
  /** Summary of the last finished turn. */
  lastTurn?: LastTurn | undefined;
  /** Web link to the thread when BB has a public app address. */
  appLink?: string | undefined;
  /** False once mirroring stops; the card collapses to a resume button. */
  mirrored: boolean;
}

const LIVE_STEPS = 4;
const PLAN_LINES = 8;
const UPDATE_CHARS = 600;
const STEP_ICON: Record<Step["state"], string> = { running: "⏳", done: "✓", failed: "✗" };
const PLAN_ICON: Record<NonNullable<PlanStep["status"]>, string> = { pending: "☐", active: "▶", completed: "☑", failed: "✗" };

export function buildThreadCard(state: ThreadCardState): SlackMessage {
  const title = truncate(state.title || "Untitled thread", 150);
  if (!state.mirrored) {
    return {
      text: `${STATUS_EMOJI.closed} ${title}`,
      blocks: [
        context(`${STATUS_EMOJI.closed} *${escapeMrkdwn(title)}* · Not mirrored · ${escapeMrkdwn(state.projectName)}`),
        { type: "actions", block_id: `ctl:${state.threadId}`, elements: [button(ACTION.resume, "Resume mirroring", state.threadId)] },
      ],
    };
  }

  const progress = isLive(state.status) ? state.progress : undefined;
  const sectionName = state.sections.find((candidate) => candidate.id === state.sectionId)?.name;
  const details = [state.projectName, sectionName, state.model?.name, state.effort].filter(Boolean).map((part) => escapeMrkdwn(String(part)));
  if (progress) details.push(progressSummary(progress.now - progress.startedAt, progress.steps.length));
  else if (state.lastTurn && (state.status === "done" || state.status === "error" || state.status === "idle")) {
    details.push(progressSummary(state.lastTurn.durationMs, state.lastTurn.steps));
  }

  const blocks: KnownBlock[] = [
    { type: "header", text: plain(title, 150) },
    // One short line reads well on a phone; the steps below carry the detail.
    section(`*${escapeMrkdwn(statusText(state.status, state.activity ? truncate(state.activity, 70) : undefined))}*`),
    context(details.join(" · ")),
  ];
  if (progress) blocks.push(...progressBlocks(progress));

  const elements: ActionElement[] = [];
  const controllable = state.status !== "archived" && state.status !== "paused";
  if (controllable && isLive(state.status)) {
    elements.push({
      ...button(ACTION.stop, "Stop", state.threadId, "danger"),
      confirm: {
        title: plain("Stop the running turn?"),
        text: { type: "mrkdwn", text: "The thread stays mirrored for your next message." },
        confirm: plain("Stop"),
        deny: plain("Keep going"),
      },
    });
  }
  if (controllable) {
    const models = select(ACTION.model, "Model", state.models.map((choice) => option(choice.name, choice.id)), state.model?.id);
    if (models) elements.push(models);
    const efforts = select(ACTION.effort, "Effort", state.efforts.map((level) => option(level, level)), state.effort);
    if (efforts) elements.push(efforts);
    if (state.sections.length > 0) {
      const sections = select(
        ACTION.section,
        "Section",
        [option("No section", NO_SECTION), ...state.sections.map((candidate) => option(candidate.name, candidate.id))],
        state.sectionId ?? NO_SECTION,
      );
      if (sections) elements.push(sections);
    }
  }
  const more: Option[] = [
    state.appLink ? { ...option("Open in BB", MORE.open), url: state.appLink } : option("Show in BB", MORE.open),
    ...(controllable ? [option("Compact conversation", MORE.compact)] : []),
    option("Stop mirroring", MORE.stopMirroring),
  ];
  elements.push({ type: "overflow", action_id: ACTION.more, options: more });
  blocks.push({ type: "actions", block_id: `ctl:${state.threadId}`, elements });

  return { text: `${STATUS_EMOJI[state.status]} ${title}`, blocks: blocks.slice(0, 50) };
}

function progressBlocks(progress: Progress): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  if (progress.showSteps && progress.plan.length > 0) {
    const lines = progress.plan.slice(0, PLAN_LINES).map((step) => `${PLAN_ICON[step.status ?? "pending"]} ${escapeMrkdwn(truncate(step.step, 100))}`);
    if (progress.plan.length > PLAN_LINES) lines.push(`_+${progress.plan.length - PLAN_LINES} more_`);
    blocks.push(context(lines.join("\n")));
  }
  if (progress.update) {
    const [first] = markdownToSlackMessages(truncate(progress.update, UPDATE_CHARS), { maxChars: UPDATE_CHARS + 50 });
    blocks.push(...(first?.blocks ?? []));
  }
  const visible = progress.showSteps ? progress.steps.slice(-LIVE_STEPS) : [];
  if (visible.length > 0) blocks.push(context(visible.map((step) => `${STEP_ICON[step.state]} ${escapeMrkdwn(truncate(step.label, 90))}`).join("\n")));
  return blocks;
}

function progressSummary(durationMs: number, steps: number): string {
  return `${formatDuration(durationMs)}${steps > 0 ? ` · ${steps} step${steps === 1 ? "" : "s"}` : ""}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
