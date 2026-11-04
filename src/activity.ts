// Turn activity: thread items → progress steps and the root card's activity line.
import type { PlanStep, Step } from "./turn.ts";
import { truncate } from "./format/mrkdwn.ts";

/** The subset of a BB thread item that activity tracking reads. */
export interface ActivityItem {
  type: string;
  id: string;
  parentToolCallId?: string | undefined;
  status?: string | undefined;
  presentation?: { label?: { pending?: string; completed?: string }; title?: string } | undefined;
  command?: string;
  tool?: string;
  path?: string | null;
  url?: string;
  query?: string;
  queries?: string[];
  label?: string;
  description?: string;
  changes?: { path: string }[];
  steps?: PlanStep[];
}

/** Items that are conversation, not work. */
const NOT_STEPS = new Set(["agentMessage", "userMessage", "reasoning", "plan", "planSteps"]);

const FALLBACK: Record<string, [pending: string, completed: string]> = {
  commandExecution: ["Running command", "Ran command"],
  fileChange: ["Editing files", "Edited files"],
  webSearch: ["Searching the web", "Searched the web"],
  webFetch: ["Fetching", "Fetched"],
  fileRead: ["Reading", "Read"],
  search: ["Searching", "Searched"],
  imageView: ["Viewing image", "Viewed image"],
  imageGeneration: ["Generating image", "Generated image"],
  contextCompaction: ["Compacting context", "Compacted context"],
  backgroundTask: ["Running background task", "Ran background task"],
  delegation: ["Running subagent", "Ran subagent"],
};

export function isStep(item: ActivityItem): boolean {
  return !item.parentToolCallId && !NOT_STEPS.has(item.type);
}

export function stepVerb(item: ActivityItem, done: boolean): string {
  const label = done ? item.presentation?.label?.completed : item.presentation?.label?.pending;
  if (label) return label;
  const fallback = FALLBACK[item.type];
  if (fallback) return done ? fallback[1] : fallback[0];
  if (item.type === "toolCall" && item.tool) return done ? `Used ${item.tool}` : `Using ${item.tool}`;
  return done ? "Finished step" : "Working";
}

export function stepSubject(item: ActivityItem): string {
  if (item.type === "commandExecution" && item.command) return `\`${oneLine(item.command).replaceAll("`", "ʼ")}\``;
  const title = item.presentation?.title;
  if (title) return oneLine(title);
  if (item.type === "fileChange" && item.changes?.length) return item.changes.map((change) => change.path.split("/").pop()).join(", ");
  if (item.path) return item.path.split("/").pop() ?? item.path;
  if (item.url) return item.url;
  if (item.query) return item.query;
  if (item.queries?.length) return item.queries.join(", ");
  return item.label ?? item.description ?? "";
}

export function stepLabel(item: ActivityItem, done: boolean): string {
  const subject = stepSubject(item);
  return truncate(subject ? `${stepVerb(item, done)} · ${subject}` : stepVerb(item, done), 160);
}

export function stepState(item: ActivityItem, done: boolean): Step["state"] {
  if (!done) return "running";
  return item.status === "failed" ? "failed" : "done";
}

/** The plan a provider reports through a planSteps item, if any. */
export function planFromItem(item: ActivityItem): PlanStep[] | undefined {
  return item.type === "planSteps" && Array.isArray(item.steps) ? item.steps : undefined;
}

function oneLine(text: string): string {
  return truncate(text.replace(/\s+/gu, " ").trim(), 120);
}
