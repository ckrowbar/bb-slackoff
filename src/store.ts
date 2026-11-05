// Durable mirror state in the plugin's kv store.
//
// binding:<threadId>          → Binding
// slack:<channelId>:<rootTs>  → threadId (reverse lookup for replies)
// state:lastProjectId         → project used for the last thread started from Slack
// state:lastSectionId         → sidebar section used for the last thread started or moved from Slack
import { z } from "zod";

const CardSchema = z.object({
  ts: z.string().min(1),
  kind: z.enum(["approval", "question", "other"]),
});

const TurnSchema = z.object({
  /** Sequence of the turn's first event; a restart replays from here to rebuild its progress. */
  startSeq: z.number().int().nonnegative(),
  /** Reply mode the turn was mirrored in, so a replay rebuilds the same held reply. */
  mode: z.enum(["final", "every"]).default("final"),
});

export const BindingSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  channelId: z.string().min(1),
  /** Slack thread root: the status card, or the DM that started the thread. */
  rootTs: z.string().min(1),
  /** The status card, updated in place. Equals rootTs unless the thread started from a DM. */
  cardTs: z.string().min(1),
  mirrored: z.boolean(),
  /** Every event up to here has been mirrored. */
  lastSeq: z.number().int().nonnegative(),
  createdAt: z.number(),
  /** Open interaction cards by interaction id. */
  cards: z.record(z.string(), CardSchema).default({}),
  turn: TurnSchema.nullable().default(null),
});
export type Binding = z.infer<typeof BindingSchema>;
export type InteractionCard = z.infer<typeof CardSchema>;

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

const BINDING_PREFIX = "binding:";
const bindingKey = (threadId: string) => `${BINDING_PREFIX}${threadId}`;
const slackKey = (channelId: string, rootTs: string) => `slack:${channelId}:${rootTs}`;
const LAST_PROJECT_KEY = "state:lastProjectId";
const LAST_SECTION_KEY = "state:lastSectionId";

export class Store {
  readonly #kv: KvStore;

  constructor(kv: KvStore) {
    this.#kv = kv;
  }

  async get(threadId: string): Promise<Binding | undefined> {
    const parsed = BindingSchema.safeParse(await this.#kv.get<unknown>(bindingKey(threadId)));
    return parsed.success ? parsed.data : undefined;
  }

  async bySlackThread(channelId: string, rootTs: string): Promise<Binding | undefined> {
    const threadId = await this.#kv.get<string>(slackKey(channelId, rootTs));
    return typeof threadId === "string" ? this.get(threadId) : undefined;
  }

  async save(binding: Binding): Promise<void> {
    await this.#kv.set(bindingKey(binding.threadId), binding);
    await this.#kv.set(slackKey(binding.channelId, binding.rootTs), binding.threadId);
  }

  async remove(binding: Binding): Promise<void> {
    await this.#kv.delete(bindingKey(binding.threadId));
    await this.#kv.delete(slackKey(binding.channelId, binding.rootTs));
  }

  async list(): Promise<Binding[]> {
    const keys = await this.#kv.list(BINDING_PREFIX);
    const ids = keys.map((key) => (key.startsWith(BINDING_PREFIX) ? key.slice(BINDING_PREFIX.length) : key));
    const bindings = await Promise.all(ids.map((threadId) => this.get(threadId)));
    return bindings.filter((binding): binding is Binding => binding !== undefined);
  }

  async lastProjectId(): Promise<string | undefined> {
    const value = await this.#kv.get<unknown>(LAST_PROJECT_KEY);
    return typeof value === "string" ? value : undefined;
  }

  async setLastProjectId(projectId: string): Promise<void> {
    await this.#kv.set(LAST_PROJECT_KEY, projectId);
  }

  /** Sidebar section for the last thread started or moved from Slack; null means no section. */
  async lastSectionId(): Promise<string | null> {
    const value = await this.#kv.get<unknown>(LAST_SECTION_KEY);
    return typeof value === "string" ? value : null;
  }

  async setLastSectionId(sectionId: string | null): Promise<void> {
    if (sectionId) await this.#kv.set(LAST_SECTION_KEY, sectionId);
    else await this.#kv.delete(LAST_SECTION_KEY);
  }
}
