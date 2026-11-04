// Shared Block Kit pieces: action ids, element helpers and status labels.
import { markdownToSlackMessages } from "../format/markdown.ts";
import { truncate } from "../format/mrkdwn.ts";
import type { ButtonElement, KnownBlock, Option, PlainText, StaticSelectElement } from "../slack/types.ts";

/**
 * Action ids. Buttons that share a block get a unique suffix
 * (`slackoff_approve:deny`); handlers match on the part before the colon.
 */
export const ACTION = {
  model: "slackoff_model",
  effort: "slackoff_effort",
  stop: "slackoff_stop",
  more: "slackoff_more",
  resume: "slackoff_resume",
  approve: "slackoff_approve",
  answer: "slackoff_answer",
  answerModal: "slackoff_answer_modal",
  open: "slackoff_open",
  link: "slackoff_link",
  newThread: "slackoff_new_thread",
  mirrorThread: "slackoff_mirror_thread",
} as const;

/** Values of the status card's overflow menu. */
export const MORE = {
  open: "open",
  compact: "compact",
  stopMirroring: "stop_mirroring",
} as const;

export const VIEW = {
  answer: "slackoff_answer_view",
  newThread: "slackoff_new_view",
  mirror: "slackoff_mirror_view",
} as const;

export type CardStatus =
  | "starting"
  | "working"
  | "waiting"
  | "stopping"
  | "idle"
  | "done"
  | "error"
  | "archived"
  | "paused"
  | "closed";

export const STATUS_EMOJI: Record<CardStatus, string> = {
  starting: "🔵",
  working: "🔵",
  waiting: "🟡",
  stopping: "🟠",
  idle: "⚪",
  done: "🟢",
  error: "🔴",
  archived: "🗄️",
  paused: "⏸️",
  closed: "⚫",
};

export const STATUS_NAME: Record<CardStatus, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Needs you",
  stopping: "Stopping",
  idle: "Ready",
  done: "Done",
  error: "Error",
  archived: "Archived",
  paused: "Paused",
  closed: "Not mirrored",
};

export function statusText(status: CardStatus, activity?: string): string {
  const base = `${STATUS_EMOJI[status]} ${STATUS_NAME[status]}`;
  return activity && isLive(status) ? `${base} · ${activity}` : base;
}

export function isLive(status: CardStatus): boolean {
  return status === "working" || status === "waiting" || status === "starting" || status === "stopping";
}

export function plain(text: string, maximum = 75): PlainText {
  return { type: "plain_text", text: truncate(text, maximum) || " ", emoji: true };
}

export function option(text: string, value: string): Option {
  return { text: plain(text), value };
}

export function button(actionId: string, text: string, value: string, style?: "primary" | "danger"): ButtonElement {
  return { type: "button", action_id: actionId, text: plain(text), value, ...(style ? { style } : {}) };
}

/** A static select with unique values; undefined when there is nothing to choose between. */
export function select(actionId: string, placeholder: string, options: Option[], current: string | undefined): StaticSelectElement | undefined {
  const unique = new Map<string, Option>();
  for (const candidate of options) {
    if (candidate.value.length <= 150 && !unique.has(candidate.value)) unique.set(candidate.value, candidate);
  }
  const list = [...unique.values()].slice(0, 100);
  if (list.length < 2) return undefined;
  const initial = list.find((candidate) => candidate.value === current);
  return {
    type: "static_select",
    action_id: actionId,
    placeholder: plain(placeholder),
    options: list,
    ...(initial ? { initial_option: initial } : {}),
  };
}

export function context(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(text, 3_000) }] };
}

export function section(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text, 3_000) } };
}

/** Markdown as card blocks, cut to one message. `complete` is false when text was dropped. */
export function markdownBlocks(markdown: string, maxChars = 2_500): { blocks: KnownBlock[]; complete: boolean } {
  if (!markdown.trim()) return { blocks: [], complete: true };
  const [first, ...rest] = markdownToSlackMessages(markdown, { maxChars });
  const blocks = first?.blocks ?? [];
  if (rest.length > 0) blocks.push(context("_Truncated. The full text is in BB._"));
  return { blocks, complete: rest.length === 0 };
}

/** Push-notification text: the thread title first so a phone shows which thread spoke. */
export function notification(prefix: string, title: string, body: string): string {
  const line = body.replace(/\s+/gu, " ").trim();
  return truncate(`${prefix} ${title}${line ? `: ${line}` : ""}`.trim(), 300);
}
