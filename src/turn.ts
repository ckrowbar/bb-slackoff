// Turn tracking: BB thread event rows → Slack effects.
//
// Pure state, no I/O, so the mirroring rules are easy to test. The bridge
// feeds rows in sequence order and applies the effects.
//
// Reply modes:
// - "final" (default, built for phones): the agent's last message in a turn is
//   posted as a new Slack message, which notifies once. Earlier messages show
//   as the latest update on the status card, which updates silently.
// - "every": each agent message is posted as it completes.
import { isStep, planFromItem, stepLabel, stepState, type ActivityItem } from "./activity.ts";
import type { ReplyMode } from "./settings.ts";

export interface Row {
  seq: number;
  type: string;
  data: unknown;
  scope: { kind: "thread" } | { kind: "turn"; turnId: string };
  createdAt: number;
}

export interface Step {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
}

export interface PlanStep {
  step: string;
  status?: "pending" | "active" | "completed" | "failed" | undefined;
}

export type TurnStatus = "completed" | "failed" | "interrupted";

export type Effect =
  | { kind: "message"; seq: number; initiator: "user" | "agent"; text: string; attachments: number }
  | { kind: "reply"; seq: number; text: string; final: boolean }
  | { kind: "turnStarted"; seq: number }
  | { kind: "turnFinished"; seq: number; status: TurnStatus; error: string | undefined }
  | { kind: "titleChanged" };

export interface TurnState {
  turnId: string | undefined;
  startSeq: number;
  startedAt: number;
  /** Event time of the latest row; durations use event time so catch-up stays accurate. */
  lastAt: number;
  steps: Step[];
  plan: PlanStep[];
  /** The agent's latest message that was not its last ("final" mode). */
  update: string | undefined;
  /** The latest agent message, held until we know whether it is the turn's last. */
  pendingReply: { seq: number; text: string } | undefined;
  activity: string | undefined;
  /** The card needs re-rendering. */
  dirty: boolean;
}

export const TRACKED_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "turn/plan/updated",
  "thread/name/updated",
] as const;

interface InputPart {
  type: string;
  text?: string;
}

export class TurnTracker {
  mode: ReplyMode;
  turn: TurnState | undefined;
  readonly #items = new Map<string, ActivityItem>();

  constructor(mode: ReplyMode) {
    this.mode = mode;
  }

  onRow(row: Row): Effect[] {
    const data = (row.data ?? {}) as Record<string, unknown>;
    if (this.turn) this.turn.lastAt = Math.max(this.turn.lastAt, row.createdAt);
    switch (row.type) {
      case "client/turn/requested":
        return this.#request(row, data);
      case "turn/started": {
        if (data.parentToolCallId) return [];
        const turnId = row.scope.kind === "turn" ? row.scope.turnId : undefined;
        if (this.turn && turnId !== undefined && this.turn.turnId === turnId) return [];
        // A turn that never reported turn/completed still gets its reply out.
        const effects = this.turn ? this.finish(row.seq, "completed") : [];
        this.turn = newTurn(turnId, row.seq, row.createdAt);
        this.#items.clear();
        this.turn.activity = "Thinking";
        return [...effects, { kind: "turnStarted", seq: row.seq }];
      }
      case "item/started":
      case "item/completed":
        return this.#item(row, data, row.type === "item/completed");
      case "turn/plan/updated": {
        const turn = this.#ensure(row);
        turn.plan = Array.isArray(data.plan) ? (data.plan as PlanStep[]) : [];
        turn.dirty = true;
        return [];
      }
      case "turn/completed": {
        if (data.parentToolCallId) return [];
        const status = (data.status as TurnStatus | undefined) ?? "completed";
        const error = (data.error as { message?: string } | undefined)?.message;
        return this.finish(row.seq, status, error);
      }
      case "thread/name/updated":
        return [{ kind: "titleChanged" }];
      default:
        return [];
    }
  }

  /**
   * End the current turn. Called for turn/completed, and by the bridge when a
   * thread goes idle without one. Running steps are settled and a held reply
   * becomes the final message.
   */
  finish(seq: number, status: TurnStatus, error?: string): Effect[] {
    const turn = this.turn;
    const effects: Effect[] = [];
    if (turn) {
      for (const step of turn.steps) {
        if (step.state !== "running") continue;
        step.state = status === "completed" ? "done" : "failed";
        const item = this.#items.get(step.id);
        if (item) step.label = stepLabel(item, true);
      }
      if (turn.pendingReply) {
        effects.push({ kind: "reply", seq: turn.pendingReply.seq, text: turn.pendingReply.text, final: true });
        turn.pendingReply = undefined;
      }
      turn.activity = undefined;
      turn.dirty = true;
    }
    effects.push({ kind: "turnFinished", seq, status, error });
    return effects;
  }

  /** Forget the finished turn once the bridge has rendered its final card. */
  clear(): void {
    this.turn = undefined;
    this.#items.clear();
  }

  #request(row: Row, data: Record<string, unknown>): Effect[] {
    const initiator = data.initiator;
    if (initiator !== "user" && initiator !== "agent") return [];
    const input = Array.isArray(data.input) ? (data.input as InputPart[]) : [];
    const text = input
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n\n")
      .trim();
    const attachments = input.filter((part) => part.type !== "text").length;
    if (!text && attachments === 0) return [];
    return [{ kind: "message", seq: row.seq, initiator, text, attachments }];
  }

  #item(row: Row, data: Record<string, unknown>, done: boolean): Effect[] {
    const item = data.item as (ActivityItem & { text?: string }) | undefined;
    if (!item || item.parentToolCallId) return [];

    if (item.type === "agentMessage") {
      if (!done) {
        this.#setActivity(row, "Writing");
        return [];
      }
      const text = item.text?.trim();
      if (!text) return [];
      const turn = this.#ensure(row);
      if (this.mode === "every") {
        // A message held before a switch to "every" goes out first, in order.
        const held: Effect[] = turn.pendingReply ? [{ kind: "reply", seq: turn.pendingReply.seq, text: turn.pendingReply.text, final: false }] : [];
        turn.pendingReply = undefined;
        return [...held, { kind: "reply", seq: row.seq, text, final: false }];
      }
      this.#foldPendingReply(turn);
      turn.pendingReply = { seq: row.seq, text };
      return [];
    }

    const plan = planFromItem(item);
    if (plan) {
      const turn = this.#ensure(row);
      turn.plan = plan;
      turn.dirty = true;
      return [];
    }
    if (item.type === "reasoning") {
      if (!done) this.#setActivity(row, "Thinking");
      return [];
    }
    if (!isStep(item)) return [];

    const turn = this.#ensure(row);
    // Work after an agent message means that message was not the last one.
    this.#foldPendingReply(turn);
    this.#items.set(item.id, item);
    const step: Step = { id: item.id, label: stepLabel(item, done), state: stepState(item, done) };
    const index = turn.steps.findIndex((existing) => existing.id === item.id);
    if (index === -1) turn.steps.push(step);
    else turn.steps[index] = step;
    turn.dirty = true;
    if (!done) turn.activity = stepLabel(item, false);
    else if (turn.activity === stepLabel(item, false)) turn.activity = "Thinking";
    return [];
  }

  #foldPendingReply(turn: TurnState): void {
    if (!turn.pendingReply) return;
    turn.update = turn.pendingReply.text;
    turn.pendingReply = undefined;
    turn.dirty = true;
  }

  #setActivity(row: Row, activity: string): void {
    const turn = this.#ensure(row);
    turn.activity = activity;
  }

  /** Mirroring can start mid-turn, so a turn may begin without turn/started. */
  #ensure(row: Row): TurnState {
    if (!this.turn) this.turn = newTurn(row.scope.kind === "turn" ? row.scope.turnId : undefined, row.seq, row.createdAt);
    return this.turn;
  }
}

function newTurn(turnId: string | undefined, seq: number, at: number): TurnState {
  return {
    turnId,
    startSeq: seq,
    startedAt: at,
    lastAt: at,
    steps: [],
    plan: [],
    update: undefined,
    pendingReply: undefined,
    activity: undefined,
    dirty: false,
  };
}
