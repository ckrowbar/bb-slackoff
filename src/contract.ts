// RPC contract between server.ts and the BB UI (app.tsx imports it as a type).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { REPLY_MODES } from "./settings.ts";

export { CHANGED_CHANNEL } from "./channel.ts";

export const CONNECTION_STATES = ["off", "unconfigured", "connecting", "connected", "error"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

const ConnectionSchema = z.object({
  state: z.enum(CONNECTION_STATES),
  /** Last connection error, shown in setup. */
  error: z.string().nullable(),
  /** Slack workspace and bot name from auth.test, once connected. */
  team: z.string().nullable(),
  botName: z.string().nullable(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

const ThreadStateSchema = z.object({
  connection: ConnectionSchema,
  mirrored: z.boolean(),
  permalink: z.string().nullable(),
});
export type ThreadState = z.infer<typeof ThreadStateSchema>;

const MirrorSummarySchema = z.object({
  threadId: z.string(),
  title: z.string(),
  projectName: z.string(),
  status: z.string(),
  permalink: z.string().nullable(),
});
export type MirrorSummary = z.infer<typeof MirrorSummarySchema>;

const PreferencesSchema = z.object({
  enabled: z.boolean(),
  replies: z.enum(REPLY_MODES),
  showActivity: z.boolean(),
  mirrorNewThreads: z.boolean(),
});
export type UiPreferences = z.infer<typeof PreferencesSchema>;

const OverviewSchema = z.object({
  configured: z.boolean(),
  missing: z.array(z.enum(["botToken", "appToken", "userId"])),
  connection: ConnectionSchema,
  preferences: PreferencesSchema,
  threads: z.array(MirrorSummarySchema),
  createAppUrl: z.string(),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const rpcContract = defineRpcContract({
  overview: { input: z.null(), output: OverviewSchema },
  threadState: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: ThreadStateSchema,
  },
  setMirrored: {
    input: z.object({ threadId: z.string().min(1), mirrored: z.boolean() }).strict(),
    output: ThreadStateSchema,
  },
  updatePreferences: {
    input: PreferencesSchema.partial().strict(),
    output: OverviewSchema,
  },
  sendTestMessage: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
});
export type RpcContract = typeof rpcContract;
