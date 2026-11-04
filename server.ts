// bb-plugin-slackoff — backend entry.
//
// Wires settings, the Slack connection, BB lifecycle events, agent guidance,
// RPC for the BB UI and the `bb slackoff` CLI. The bridge (src/bridge.ts)
// does the mirroring.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";

import { errorText, threadTitle } from "./src/bb.ts";
import { Bridge } from "./src/bridge.ts";
import { CHANGED_CHANNEL, rpcContract, type Connection, type MirrorSummary, type Overview, type ThreadState } from "./src/contract.ts";
import { MIRRORED_THREAD_INSTRUCTIONS } from "./src/instructions.ts";
import { createAppUrl } from "./src/manifest.ts";
import { defineSettings, isConfigured, preferencesFrom, type SettingsValues } from "./src/settings.ts";
import { SlackApi, SlackApiError } from "./src/slack/api.ts";
import { Outbox } from "./src/slack/outbox.ts";
import { SocketModeClient } from "./src/slack/socket-mode.ts";
import { Store } from "./src/store.ts";

export { rpcContract };

const NOT_CONFIGURED = "Add your Slack tokens and member ID in Slackoff's settings.";

export default async function plugin(bb: BbPluginApi) {
  const settings = defineSettings(bb);
  // Setup state shows in Slackoff's own UI. BB's needs-configuration status
  // would stick until a manual reload, so the service waits for settings instead.
  let values: SettingsValues = await settings.get();

  const store = new Store(bb.storage.kv);
  const mirrored = new Set((await store.list()).filter((binding) => binding.mirrored).map((binding) => binding.threadId));
  const preferences = () => preferencesFrom(values, bb.server.experimental_appUrl);

  let bridge: Bridge | undefined;
  let connection: Connection = { state: values.enabled ? "connecting" : "off", error: null, team: null, botName: null };
  let restart: AbortController | undefined;
  const settingsWaiters = new Set<() => void>();

  const publish = (threadId: string | null) => bb.realtime.publish(CHANGED_CHANNEL, { threadId });
  const setConnection = (next: Partial<Connection>) => {
    connection = { ...connection, ...next };
    publish(null);
  };
  const trackMirrored = (threadId: string | null) => {
    if (threadId) {
      void store.get(threadId).then((binding) => (binding?.mirrored ? mirrored.add(threadId) : mirrored.delete(threadId)));
    }
    publish(threadId);
  };

  settings.onChange((next, previous) => {
    values = next;
    for (const wake of settingsWaiters) wake();
    const credentialsChanged = next.botToken !== previous.botToken || next.appToken !== previous.appToken || next.userId !== previous.userId;
    if (next.enabled !== previous.enabled || credentialsChanged) {
      const current = bridge;
      const connection = restart;
      // Mark cards paused before the connection drops, so Slack shows why updates stopped.
      void (async () => {
        if (current && !next.enabled) await current.pauseAll().catch(() => undefined);
        connection?.abort();
      })();
    }
    publish(null);
  });

  const waitForSettings = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        settingsWaiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      settingsWaiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });

  bb.background.service("slack", {
    async start(signal) {
      while (!signal.aborted) {
        if (!isConfigured(values)) {
          setConnection({ state: "unconfigured", error: null });
          await waitForSettings(signal);
          continue;
        }
        if (!values.enabled) {
          setConnection({ state: "off", error: null });
          await waitForSettings(signal);
          continue;
        }
        restart = new AbortController();
        const run = AbortSignal.any([signal, restart.signal]);
        const slack = new SlackApi({ token: String(values.botToken) });
        const app = new SlackApi({ token: String(values.appToken) });
        setConnection({ state: "connecting", error: null });

        try {
          const identity = await slack.call<{ ok: boolean; team?: string; user?: string }>("auth.test");
          setConnection({ team: identity.team ?? null, botName: identity.user ?? null });
        } catch (error) {
          setConnection({ state: "error", error: describeSlackError(error, "bot token") });
          // A rejected token will not fix itself; wait for new settings. Anything else is retried.
          if (error instanceof SlackApiError && AUTH_ERRORS.has(error.code)) await waitForSettings(run);
          else await sleep(15_000, run);
          continue;
        }

        const current = new Bridge({ pluginId: bb.pluginId, sdk: bb.sdk, outbox: new Outbox(slack, bb.log), store, preferences, log: bb.log, publish: trackMirrored });
        await current.start();
        bridge = current;
        const socket = new SocketModeClient({
          openConnection: async () => {
            try {
              const result = await app.call<{ ok: boolean; url?: string }>("apps.connections.open");
              if (!result.url) throw new Error("Slack returned no Socket Mode address");
              return result.url;
            } catch (error) {
              setConnection({ state: "error", error: describeSlackError(error, "app-level token") });
              throw error;
            }
          },
          onEnvelope: (envelope) => current.handleEnvelope(envelope),
          log: bb.log,
          onConnectionChange: (up) => {
            if (up) {
              setConnection({ state: "connected", error: null });
              void current.reconcileAll().catch((error) => bb.log.error(`reconcile failed: ${errorText(error)}`));
            } else if (connection.state === "connected") {
              setConnection({ state: "connecting" });
            }
          },
        });
        try {
          await socket.run(run);
        } finally {
          current.dispose();
          // Let queued Slack work finish so the next connection never mirrors the same events.
          await current.idle();
          if (bridge === current) bridge = undefined;
        }
      }
    },
  });

  // BB lifecycle → Slack. Handlers are fire-and-forget; the bridge queues work per thread.
  bb.events.on("experimental_thread.events", ({ thread }) => bridge?.onThreadEvents(thread));
  bb.events.on("thread.created", ({ thread }) => bridge?.onThreadCreated(thread));
  bb.events.on("thread.active", ({ thread }) => bridge?.onThreadStatus(thread, "active"));
  bb.events.on("thread.idle", ({ thread }) => bridge?.onThreadStatus(thread, "idle"));
  bb.events.on("thread.failed", ({ thread, error }) => bridge?.onThreadStatus(thread, "failed", error));
  bb.events.on("thread.archived", ({ thread }) => bridge?.onThreadStatus(thread, "archived"));
  bb.events.on("thread.unarchived", ({ thread }) => bridge?.onThreadStatus(thread, "unarchived"));
  bb.events.on("thread.deleted", ({ thread }) => bridge?.onThreadStatus(thread, "deleted"));
  bb.events.on("interaction.pending", ({ thread, interaction }) => bridge?.onInteraction(thread, interaction));

  // Mirrored threads are read on a phone; ask the agent to write for that.
  bb.agents.contributeInstructions(({ threadId }) => (mirrored.has(threadId) ? MIRRORED_THREAD_INSTRUCTIONS : null));

  const connectedBridge = (): Bridge => {
    if (!isConfigured(values)) throw new PluginCliError("Slackoff is not set up.", { code: "not_configured", hint: NOT_CONFIGURED });
    if (!values.enabled) throw new PluginCliError("Slackoff is turned off.", { code: "disabled", hint: "Turn Slackoff on from the BB sidebar or its settings." });
    if (!bridge || connection.state !== "connected") {
      throw new PluginCliError("Slackoff is not connected to Slack yet.", {
        code: "not_connected",
        hint: connection.error ?? "Check `bb plugin logs slackoff` for connection errors.",
      });
    }
    return bridge;
  };

  const threadState = async (threadId: string): Promise<ThreadState> => {
    if (bridge) return { connection, ...(await bridge.threadState(threadId)) };
    return { connection, mirrored: (await store.get(threadId))?.mirrored ?? false, permalink: null };
  };

  const summaries = async (): Promise<MirrorSummary[]> => {
    if (bridge) {
      return (await bridge.summaries()).map(({ threadId, title, projectName, status, permalink }) => ({ threadId, title, projectName, status, permalink }));
    }
    const bindings = (await store.list()).filter((binding) => binding.mirrored);
    return Promise.all(
      bindings.map(async (binding) => {
        const thread = await bb.sdk.threads.get({ threadId: binding.threadId }).catch(() => undefined);
        return { threadId: binding.threadId, title: thread ? threadTitle(thread) : binding.threadId, projectName: "", status: "paused", permalink: null };
      }),
    );
  };

  const overview = async (): Promise<Overview> => {
    const missing: Overview["missing"] = [];
    if (!values.botToken) missing.push("botToken");
    if (!values.appToken) missing.push("appToken");
    if (!values.userId.trim()) missing.push("userId");
    const prefs = preferencesFrom(values, null);
    return {
      configured: missing.length === 0,
      missing,
      connection,
      preferences: { enabled: values.enabled, replies: prefs.replies, showActivity: prefs.showActivity, mirrorNewThreads: prefs.mirrorNewThreads },
      threads: await summaries(),
      createAppUrl: createAppUrl(),
    };
  };

  bb.rpc.register(rpcContract, {
    overview: () => overview(),
    threadState: ({ threadId }) => threadState(threadId),
    async setMirrored({ threadId, mirrored: on }) {
      const current = connectedBridge();
      if (on) await current.enable(threadId);
      else await current.disable(threadId);
      return threadState(threadId);
    },
    async updatePreferences(change) {
      const patch: Parameters<typeof settings.experimental_set>[0] = {};
      if (change.enabled !== undefined) patch.enabled = change.enabled;
      if (change.replies !== undefined) patch.replies = change.replies;
      if (change.showActivity !== undefined) patch.showActivity = change.showActivity;
      if (change.mirrorNewThreads !== undefined) patch.mirrorNewThreads = change.mirrorNewThreads;
      values = await settings.experimental_set(patch);
      return overview();
    },
    async sendTestMessage() {
      try {
        await connectedBridge().sendTest();
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
  });

  const threadOption = {
    thread: { type: "string" as const, aliases: ["thread-id", "id"], description: "BB thread ID. Defaults to the thread running the command." },
  };
  const resolveThread = (option: string | undefined, ctx: { threadId?: string }): string => {
    const threadId = option ?? ctx.threadId;
    if (!threadId) throw new PluginCliError("No thread given.", { code: "thread_required", hint: "Pass --thread <thr_…>, or run the command inside a BB thread." });
    return threadId;
  };

  bb.cli.register(
    defineCli({
      name: "slackoff",
      summary: "Mirror BB threads into Slack",
      commands: {
        on: cliCommand({
          summary: "Start mirroring a thread to Slack",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThread(input.options.thread, ctx);
            await connectedBridge().enable(threadId);
            const state = await threadState(threadId);
            return { exitCode: 0, stdout: `Mirroring ${threadId} to Slack${state.permalink ? `: ${state.permalink}` : "."}\n` };
          },
        }),
        off: cliCommand({
          summary: "Stop mirroring a thread to Slack",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThread(input.options.thread, ctx);
            await connectedBridge().disable(threadId);
            return { exitCode: 0, stdout: `Stopped mirroring ${threadId}.\n` };
          },
        }),
        status: cliCommand({
          summary: "Show the Slack connection and a thread's mirror state",
          options: { ...threadOption, json: { type: "boolean" as const, description: "Print JSON" } },
          async run(input, ctx) {
            const threadId = input.options.thread ?? ctx.threadId;
            const state = threadId ? await threadState(threadId) : { connection, mirrored: false, permalink: null };
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify({ threadId: threadId ?? null, ...state })}\n` };
            const where = state.connection.team ? ` to ${state.connection.team}` : "";
            const lines = [
              `Slack: ${state.connection.state === "connected" ? `connected${where}` : state.connection.state}${state.connection.error ? ` (${state.connection.error})` : ""}`,
              ...(threadId ? [`Thread ${threadId}: ${state.mirrored ? `mirrored${state.permalink ? ` (${state.permalink})` : ""}` : "not mirrored"}`] : []),
            ];
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        list: cliCommand({
          summary: "List mirrored threads",
          options: { json: { type: "boolean" as const, description: "Print JSON" } },
          async run(input) {
            const rows = await summaries();
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(rows)}\n` };
            if (rows.length === 0) return { exitCode: 0, stdout: "No threads are mirrored.\n" };
            return { exitCode: 0, stdout: `${rows.map((row) => `${row.threadId}  ${row.status.padEnd(8)}  ${row.title}`).join("\n")}\n` };
          },
        }),
        test: cliCommand({
          summary: "Send yourself a test message in Slack",
          async run() {
            await connectedBridge().sendTest();
            return { exitCode: 0, stdout: "Sent a test message to your Slack DMs.\n" };
          },
        }),
      },
    }),
  );
}

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "not_allowed_token_type", "missing_scope"]);

function describeSlackError(error: unknown, token: string): string {
  if (error instanceof SlackApiError) {
    if (error.code === "missing_scope") return `The ${token} is missing a scope; reinstall the app from the manifest.`;
    if (["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"].includes(error.code)) return `Slack rejected the ${token}.`;
    if (error.code === "not_allowed_token_type") return `The ${token} is the wrong kind of token.`;
    return `Slack error: ${error.code}`;
  }
  return `Could not reach Slack: ${errorText(error)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
