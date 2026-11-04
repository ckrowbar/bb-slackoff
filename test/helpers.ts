// Shared fakes: an in-memory kv store, a recording Slack client and a BB SDK
// whose thread event log tests append to.
import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import type { Sdk } from "../src/bb.ts";
import { Bridge } from "../src/bridge.ts";
import type { Preferences } from "../src/settings.ts";
import { SlackApiError, type SlackResponse } from "../src/slack/api.ts";
import { Outbox, type SlackClient } from "../src/slack/outbox.ts";
import { Store, type KvStore } from "../src/store.ts";
import type { Row } from "../src/turn.ts";

export const USER = "U0USER";
export const DM = "D0DM";
export const THREAD = "thr_one";
export const PROJECT = "proj_one";

export class MemoryKv implements KvStore {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async set(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async list(prefix = "") {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

export interface Call {
  method: string;
  body: Record<string, unknown>;
  ts?: string;
}

export class FakeSlack implements SlackClient {
  readonly calls: Call[] = [];
  reject: ((method: string, body: Record<string, unknown>) => string | undefined) | undefined;
  #ts = 100;

  async call<T extends SlackResponse>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const call: Call = { method, body };
    this.calls.push(call);
    const error = this.reject?.(method, body);
    if (error) throw new SlackApiError(method, error);
    if (method === "chat.postMessage") {
      call.ts = `${(this.#ts += 1)}.000`;
      return { ok: true, channel: DM, ts: call.ts } as unknown as T;
    }
    if (method === "chat.getPermalink") return { ok: true, permalink: `https://slack.test/${String(body.message_ts)}` } as unknown as T;
    return { ok: true } as unknown as T;
  }

  downloadDelayMs = 0;

  async download(): Promise<Uint8Array> {
    if (this.downloadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.downloadDelayMs));
    return new Uint8Array([1, 2, 3]);
  }

  of(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  posts(): Call[] {
    return this.of("chat.postMessage");
  }

  /** Thread replies: everything posted under a thread_ts. */
  replies(): Call[] {
    return this.posts().filter((call) => call.body.thread_ts);
  }

  updatesOf(ts: string | undefined): Call[] {
    return this.of("chat.update").filter((call) => call.body.ts === ts);
  }

  reactions(): string[] {
    return this.calls.filter((call) => call.method === "reactions.add" || call.method === "reactions.remove").map((call) => `${call.method === "reactions.add" ? "+" : "-"}${String(call.body.name)}`);
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export interface SetupOptions {
  preferences?: Partial<Preferences>;
  rows?: Row[];
  interactions?: unknown[];
  output?: string | null;
  kv?: MemoryKv;
  slack?: FakeSlack;
}

export function setup(options: SetupOptions = {}) {
  const rows: Row[] = options.rows ?? [];
  const interactions: unknown[] = options.interactions ?? [];
  const thread = makeThreadResponse({ id: THREAD, projectId: PROJECT, title: "Fix the parser", providerId: "claude-code", environmentId: "env_one" });
  const { sdk, harness } = createFakeSdk({
    pluginId: "slackoff",
    overrides: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ ...thread, id: threadId }),
        output: async () => ({ output: options.output ?? null }),
        send: async () => ({ ok: true, delivery: "sent" }),
        stop: async () => ({ ok: true }),
        compact: async () => ({ ok: true }),
        open: async () => ({ delivered: 1 }),
        spawn: async () => ({ ...thread, id: "thr_new" }),
        update: async () => thread,
        list: async () => [thread],
        defaultExecutionOptions: async () => ({ model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" }),
        events: {
          list: async (args: { afterSeq?: string; order?: string; limit?: string; types?: readonly string[] }) => {
            if (args.order === "desc") return rows.slice(-1);
            const after = Number(args.afterSeq ?? 0);
            return rows
              .filter((row) => row.seq > after && (!args.types || args.types.includes(row.type)))
              .slice(0, Number(args.limit ?? 100))
              .map((row) => ({ ...row, id: `evt_${row.seq}`, threadId: THREAD }));
          },
        },
        interactions: {
          list: async () => interactions,
          get: async ({ interactionId }: { interactionId: string }) => interactions.find((item) => (item as { id: string }).id === interactionId),
          resolve: async ({ interactionId, resolution }: { interactionId: string; resolution: unknown }) => {
            const item = interactions.find((candidate) => (candidate as { id: string }).id === interactionId) as Record<string, unknown>;
            item.status = "resolved";
            item.resolution = resolution;
            return item;
          },
        },
      },
      projects: {
        get: async () => ({ id: PROJECT, name: "parser", kind: "standard" }),
        list: async () => [{ id: PROJECT, name: "parser", kind: "standard" }],
        attachments: { upload: async () => ({ type: "localImage", path: "attachments/a.png", name: "a.png", sizeBytes: 3 }) },
      },
      providers: {
        models: async () => ({
          models: [
            { id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus 5.5", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
            { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
          ],
        }),
      },
      system: { transcribeVoice: async () => ({ text: "please run the tests" }) },
    } as never,
  });
  const slack = options.slack ?? new FakeSlack();
  const kv = options.kv ?? new MemoryKv();
  const store = new Store(kv);
  const preferences: Preferences = {
    userId: USER,
    replies: "final",
    showActivity: true,
    mirrorNewThreads: false,
    defaultProjectId: undefined,
    appUrl: undefined,
    ...options.preferences,
  };
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const makeBridge = () =>
    new Bridge({
      pluginId: "slackoff",
      sdk: sdk as unknown as Sdk,
      outbox: new Outbox(slack, log),
      store,
      preferences: () => preferences,
      log,
      cardIntervalMs: 0,
    });
  const bridge = makeBridge();
  let current = bridge;
  const settle = async () => {
    for (let round = 0; round < 4; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await current.idle();
    }
  };
  let seq = rows.at(-1)?.seq ?? 0;
  const push = (type: string, data: Record<string, unknown>, turnId = "t1") => {
    seq += 1;
    rows.push({ seq, type, data, scope: { kind: "turn", turnId }, createdAt: 1_000 * seq });
  };
  const notify = () => current.onThreadEvents(makeThreadResponse({ id: THREAD }));
  /** Simulate a plugin restart: a new bridge over the same store and Slack. */
  const restart = async () => {
    current.dispose();
    await current.idle();
    current = makeBridge();
    await current.start();
    return current;
  };
  return { bridge, current: () => current, restart, slack, store, kv, harness, rows, push, notify, settle, thread, interactions, logs, preferences };
}

export function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "events_api",
    envelope_id: "env",
    payload: { event_id: `ev_${Math.random()}`, event: { type: "message", channel: DM, channel_type: "im", user: USER, text, ts: "200.000", ...extra } },
  };
}

export function action(actionId: string, value: string, extra: Record<string, unknown> = {}) {
  return { type: "interactive", envelope_id: "e", payload: { type: "block_actions", user: { id: USER }, channel: { id: DM }, actions: [{ action_id: actionId, value, ...extra }] } };
}

export const approval = () => ({
  id: "int_1",
  threadId: THREAD,
  turnId: "t1",
  status: "pending",
  statusReason: null,
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
  payload: {
    kind: "approval",
    reason: "Needs network",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
    subject: { kind: "command", command: "curl https://x.dev", cwd: "/repo", itemId: "c1", actions: [], sessionGrant: null as unknown },
  },
});

export const question = () => ({
  ...approval(),
  id: "int_q",
  payload: {
    kind: "user_question",
    questions: [
      {
        id: "q1",
        prompt: "Which **database**?",
        multiSelect: false,
        allowFreeText: false,
        options: [
          { label: "Postgres", value: "pg" },
          { label: "SQLite", value: "sqlite" },
        ],
      },
    ],
  },
});
