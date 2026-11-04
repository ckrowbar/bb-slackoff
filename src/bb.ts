// BB SDK types this plugin uses. The SDK exports the areas, not every DTO,
// so the shapes are derived from the method signatures.
import type { PluginBbSdk, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";

export type Sdk = PluginBbSdk;
export type ThreadResponse = PluginThreadEventPayloads["thread.created"]["thread"];
export type PendingInteraction = PluginThreadEventPayloads["interaction.pending"]["interaction"];
export type EventRow = Awaited<ReturnType<Sdk["threads"]["events"]["list"]>>[number];
export type PromptInput = Parameters<Sdk["threads"]["send"]>[0]["input"][number];
export type ReasoningLevel = NonNullable<Parameters<Sdk["threads"]["update"]>[0]["reasoningLevel"]>;
export type InteractionResolution = Parameters<Sdk["threads"]["interactions"]["resolve"]>[0]["resolution"];

export interface ModelCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
}

export function threadTitle(thread: Pick<ThreadResponse, "title" | "titleFallback">): string {
  return (thread.title ?? thread.titleFallback ?? "").trim() || "Untitled thread";
}

/** Web link to a thread in the BB app, matching the app's own routes. */
export function threadLink(appUrl: string, thread: { id: string; projectId: string }, projectKind: string): string {
  const base = appUrl.replace(/\/+$/u, "");
  return projectKind === "personal" ? `${base}/threads/${thread.id}` : `${base}/projects/${thread.projectId}/threads/${thread.id}`;
}

export function isNotFound(error: unknown): boolean {
  const record = error as { status?: unknown; statusCode?: unknown } | null;
  const status = record?.status ?? record?.statusCode;
  return status === 404 || /\b404\b|not[ _-]?found/iu.test(errorText(error));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
