// The Slackoff panel in the sidebar footer: the on/off switch, connection
// status, mirrored threads and the everyday options.
import { useState, type ReactNode } from "react";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import { SETTINGS_ROUTE } from "../src/channel.ts";
import type { Overview, UiPreferences } from "../src/contract.ts";
import { errorMessage, useOverview } from "./hooks.ts";
import { ConnectionLine } from "./status.tsx";
import { Switch } from "./switch.tsx";

const STATUS_LABEL: Record<string, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Needs you",
  stopping: "Stopping",
  idle: "Ready",
  done: "Done",
  error: "Error",
  archived: "Archived",
  paused: "Paused",
};

export function SidebarPanel({ dismiss }: { dismiss: () => void }) {
  const { overview, setOverview, error, setError, rpc } = useOverview();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (overview === null) {
    return <div className="p-3 text-sm text-muted-foreground">{error ?? "Loading Slackoff…"}</div>;
  }

  const run = async (key: string, task: () => Promise<Overview | void>) => {
    setBusy(key);
    setNotice(null);
    try {
      const next = await task();
      if (next) setOverview(next);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };
  const update = (change: Partial<UiPreferences>) => run(Object.keys(change)[0] ?? "pref", () => rpc.call("updatePreferences", change));
  const { preferences, connection } = overview;
  const connected = connection.state === "connected";

  return (
    <div className="flex max-h-[70vh] w-full flex-col gap-3 overflow-y-auto p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">Slackoff</p>
          <ConnectionLine connection={connection} />
        </div>
        {overview.configured ? (
          <Switch label="Slackoff on" checked={preferences.enabled} disabled={busy !== null} onCheckedChange={(enabled) => void update({ enabled })} />
        ) : null}
      </div>

      {!overview.configured ? (
        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          Connect a Slack app to follow and steer threads from your phone.{" "}
          <UrlLink href={SETTINGS_ROUTE} className="font-medium text-foreground underline underline-offset-2" onClick={dismiss}>
            Set up Slackoff
          </UrlLink>
        </div>
      ) : null}

      {overview.configured ? (
        <Section title={`Mirrored threads${overview.threads.length > 0 ? ` (${overview.threads.length})` : ""}`}>
          {overview.threads.length === 0 ? (
            <p className="text-xs text-muted-foreground">Use the message icon in a thread's header to mirror it, or send the Slack app a message to start one.</p>
          ) : (
            <ul className="flex flex-col">
              {overview.threads.map((thread) => (
                <li key={thread.threadId} className="group flex items-center gap-1.5 rounded-md py-1 pr-0.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer text-left"
                    onClick={() => {
                      navigate.toThread(thread.threadId);
                      dismiss();
                    }}
                  >
                    <span className="block truncate">{thread.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {STATUS_LABEL[thread.status] ?? thread.status}
                      {thread.projectName ? ` · ${thread.projectName}` : ""}
                    </span>
                  </button>
                  {thread.permalink ? (
                    <IconButton label={`Open ${thread.title} in Slack`} icon="ExternalLink" onClick={() => navigate.openUrl(thread.permalink ?? "")} />
                  ) : null}
                  <IconButton
                    label={`Stop mirroring ${thread.title}`}
                    icon="X"
                    disabled={!connected || busy !== null}
                    onClick={() =>
                      void run(`stop:${thread.threadId}`, async () => {
                        await rpc.call("setMirrored", { threadId: thread.threadId, mirrored: false });
                        return rpc.call("overview");
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {overview.configured ? (
        <Section title="Options">
          <Row label="Mirror new threads" hint="Every new top-level thread">
            <Switch label="Mirror new threads automatically" checked={preferences.mirrorNewThreads} disabled={busy !== null} onCheckedChange={(mirrorNewThreads) => void update({ mirrorNewThreads })} />
          </Row>
          <Row label="Live progress" hint="Steps and plan on the status card">
            <Switch label="Show live progress" checked={preferences.showActivity} disabled={busy !== null} onCheckedChange={(showActivity) => void update({ showActivity })} />
          </Row>
          <Row label="Notify for" hint={preferences.replies === "final" ? "Once per turn" : "Each message"}>
            <Segmented
              value={preferences.replies}
              disabled={busy !== null}
              options={[
                { value: "final", label: "Final reply" },
                { value: "every", label: "Every message" },
              ]}
              onChange={(replies) => void update({ replies: replies as UiPreferences["replies"] })}
            />
          </Row>
        </Section>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
        <UrlLink href={SETTINGS_ROUTE} className="text-xs text-muted-foreground hover:text-foreground" onClick={dismiss}>
          Settings
        </UrlLink>
        {connected ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={busy !== null}
            onClick={() =>
              void run("test", async () => {
                const result = await rpc.call("sendTestMessage");
                setNotice(result.ok ? "Sent. Check your Slack messages." : (result.error ?? "Could not send"));
              })
            }
          >
            Send test message
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Segmented({ value, options, onChange, disabled }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" className="inline-flex shrink-0 rounded-md border border-border p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "cursor-pointer rounded px-2 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            option.value === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function IconButton({ label, icon, onClick, disabled }: { label: string; icon: string; onClick: () => void; disabled?: boolean }) {
  return (
    <span title={label} className="inline-flex">
      <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-foreground" aria-label={label} disabled={disabled} onClick={onClick}>
        <Icon name={icon} className="size-3.5" />
      </Button>
    </span>
  );
}
