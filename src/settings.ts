// Plugin settings. Tokens are secret settings: BB stores them in 0600 files
// and never sends them to the browser.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const REPLY_MODES = ["final", "every"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Slackoff on",
      description: "Turn off to pause all mirroring and disconnect from Slack. Mirrored threads resume when you turn it back on.",
      default: true,
    },
    botToken: {
      type: "string",
      label: "Slack bot token",
      description: "The xoxb- token from your Slack app's OAuth & Permissions page.",
      secret: true,
    },
    appToken: {
      type: "string",
      label: "Slack app-level token",
      description: "An xapp- token with the connections:write scope, from Basic Information → App-Level Tokens.",
      secret: true,
    },
    userId: {
      type: "string",
      label: "Your Slack member ID",
      description: "Only this Slack user can control threads. In Slack, open your profile, choose ⋯ and Copy member ID.",
      default: "",
      experimental_schema: z.string().trim().regex(/^$|^[UW][A-Z0-9]{2,}$/u, "A Slack member ID looks like U0123456789"),
    },
    replies: {
      type: "select",
      label: "Agent messages",
      description:
        "final: post only the agent's last message of each turn, so you get one notification per turn; earlier messages show on the status card. every: post each agent message.",
      options: [...REPLY_MODES],
      default: "final",
    },
    showActivity: {
      type: "boolean",
      label: "Show live progress",
      description: "List the agent's recent steps and plan on each thread's status card while it works. The card updates in place without notifying you.",
      default: true,
    },
    mirrorNewThreads: {
      type: "boolean",
      label: "Mirror new threads automatically",
      description: "Mirror every new visible top-level thread, not only the ones you turn on.",
      default: false,
    },
    defaultProjectId: {
      type: "project",
      label: "Project for threads started from Slack",
      description: "A direct message to the app starts a thread here. Without one, Slackoff uses the last project you chose.",
    },
    appUrl: {
      type: "string",
      label: "BB web address",
      description: "Optional. Adds an Open in BB link to each Slack card, for example https://bb.example.com.",
      default: "",
      experimental_schema: z.string().trim().regex(/^$|^https?:\/\/\S+$/u, "Use an http or https address"),
    },
  });
}

export type SettingsHandle = ReturnType<typeof defineSettings>;
export type SettingsValues = Awaited<ReturnType<SettingsHandle["get"]>>;

/** Settings the bridge reads, with secrets removed. */
export interface Preferences {
  userId: string;
  replies: ReplyMode;
  showActivity: boolean;
  mirrorNewThreads: boolean;
  defaultProjectId: string | undefined;
  appUrl: string | undefined;
}

export function preferencesFrom(values: SettingsValues, fallbackAppUrl: string | null): Preferences {
  const projectId = typeof values.defaultProjectId === "string" && values.defaultProjectId ? values.defaultProjectId : undefined;
  return {
    userId: values.userId.trim(),
    replies: (REPLY_MODES as readonly string[]).includes(values.replies) ? (values.replies as ReplyMode) : "final",
    showActivity: values.showActivity,
    mirrorNewThreads: values.mirrorNewThreads,
    defaultProjectId: projectId,
    appUrl: values.appUrl.trim() || fallbackAppUrl || undefined,
  };
}

export function isConfigured(values: SettingsValues): boolean {
  return Boolean(values.botToken && values.appToken && values.userId.trim());
}
