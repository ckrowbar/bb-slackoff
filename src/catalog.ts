// Cached BB lookups the cards need on every refresh: project names and each
// provider's model list.
import { errorText, threadTitle, type ModelCatalogEntry, type Sdk, type ThreadResponse } from "./bb.ts";
import type { Log } from "./slack/outbox.ts";

const MODEL_CACHE_MS = 10 * 60_000;
const PROJECT_CACHE_MS = 10 * 60_000;

export interface ProjectInfo {
  name: string;
  kind: string;
}

export class Catalog {
  readonly #sdk: Sdk;
  readonly #log: Log;
  readonly #now: () => number;
  readonly #projects = new Map<string, { at: number; value: ProjectInfo }>();
  readonly #models = new Map<string, { at: number; models: ModelCatalogEntry[] }>();

  constructor(sdk: Sdk, log: Log, now: () => number) {
    this.#sdk = sdk;
    this.#log = log;
    this.#now = now;
  }

  async project(projectId: string): Promise<ProjectInfo> {
    const cached = this.#projects.get(projectId);
    if (cached && this.#now() - cached.at < PROJECT_CACHE_MS) return cached.value;
    const project = await this.#sdk.projects.get({ projectId }).catch(() => undefined);
    const value = project ? { name: project.kind === "personal" ? "Personal" : project.name, kind: project.kind } : (cached?.value ?? { name: projectId, kind: "standard" });
    this.#projects.set(projectId, { at: this.#now(), value });
    return value;
  }

  async projects(): Promise<{ id: string; name: string }[]> {
    const projects = await this.#sdk.projects.list({ includePersonal: true });
    return projects.map((project) => ({ id: project.id, name: project.kind === "personal" ? "Personal" : project.name }));
  }

  async models(thread: ThreadResponse): Promise<ModelCatalogEntry[]> {
    const key = `${thread.providerId}:${thread.environmentId ?? ""}`;
    const cached = this.#models.get(key);
    if (cached && this.#now() - cached.at < MODEL_CACHE_MS) return cached.models;
    try {
      const result = await this.#sdk.providers.models(
        thread.environmentId ? { providerId: thread.providerId, environmentId: thread.environmentId } : { providerId: thread.providerId },
      );
      const models = result.models as ModelCatalogEntry[];
      this.#models.set(key, { at: this.#now(), models });
      return models;
    } catch (error) {
      this.#log.warn(`could not load models for ${thread.providerId}: ${errorText(error)}`);
      return cached?.models ?? [];
    }
  }

  /** Projects ordered by recent thread activity, then the rest. */
  async recentProjects(): Promise<{ id: string; name: string }[]> {
    const [projects, threads] = await Promise.all([this.projects(), this.#sdk.threads.list({ archived: false, limit: 100 }).catch(() => [])]);
    const order = new Map<string, number>();
    for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) if (!order.has(thread.projectId)) order.set(thread.projectId, order.size);
    return [...projects].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }

  /** Recent visible top-level threads, newest first, for the mirror picker. */
  async recentThreads(exclude: ReadonlySet<string>): Promise<{ id: string; title: string; projectName: string }[]> {
    const threads = await this.#sdk.threads.list({ archived: false, hasParent: false, limit: 100 });
    const candidates = threads.filter((thread) => !exclude.has(thread.id) && thread.visibility === "visible").sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.all(
      candidates.slice(0, 100).map(async (thread) => ({ id: thread.id, title: threadTitle(thread), projectName: (await this.project(thread.projectId)).name })),
    );
  }
}
