// Setup steps on Slackoff's settings page, below BB's settings form.
import { useState, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import { errorMessage, useOverview } from "./hooks.ts";
import { ConnectionLine } from "./status.tsx";

export function SetupSection() {
  const { overview, error, rpc } = useOverview();
  const navigate = useBbNavigate();
  const [test, setTest] = useState<string | null>(null);
  if (overview === null) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;

  const missing = new Set(overview.missing);
  const connected = overview.connection.state === "connected";

  return (
    <div className="flex flex-col gap-4 text-sm">
      <ConnectionLine connection={overview.connection} />
      <ol className="flex flex-col gap-3">
        <Step done={!missing.has("botToken")} number={1} title="Create the Slack app">
          Slackoff needs its own Slack app.{" "}
          <Button variant="outline" size="sm" className="ml-1 h-7 text-xs" onClick={() => navigate.openUrl(overview.createAppUrl)}>
            <Icon name="ExternalLink" className="size-3.5" />
            Create app from manifest
          </Button>
          <span className="mt-1 block">Pick your workspace, create the app, then choose Install to Workspace.</span>
        </Step>
        <Step done={!missing.has("botToken")} number={2} title="Bot token">
          In the app, open <b>OAuth &amp; Permissions</b> and copy the <b>Bot User OAuth Token</b> (xoxb-…) into <i>Slack bot token</i> above.
        </Step>
        <Step done={!missing.has("appToken")} number={3} title="App-level token">
          Open <b>Basic Information → App-Level Tokens</b>, generate a token with the <code>connections:write</code> scope, and paste it (xapp-…) into{" "}
          <i>Slack app-level token</i> above.
        </Step>
        <Step done={!missing.has("userId")} number={4} title="Your member ID">
          In Slack, open your profile, choose <b>⋯</b> then <b>Copy member ID</b>, and paste it into <i>Your Slack member ID</i> above.
        </Step>
        <Step done={connected} number={5} title="Check it works">
          {connected ? "Slackoff is connected. " : "Slackoff connects as soon as the three values are saved. "}
          <Button
            variant="outline"
            size="sm"
            className="ml-1 h-7 text-xs"
            disabled={!connected}
            onClick={() =>
              rpc.call("sendTestMessage").then(
                (result) => setTest(result.ok ? "Sent. Check your Slack messages." : (result.error ?? "Could not send")),
                (cause: unknown) => setTest(errorMessage(cause)),
              )
            }
          >
            Send test message
          </Button>
          {test ? <span className="mt-1 block">{test}</span> : null}
        </Step>
      </ol>
      <p className="text-xs text-muted-foreground">
        Then mirror a thread from the message icon in its header, or send the Slack app a message to start a new thread. The Slackoff icon in the sidebar
        footer turns mirroring on and off.
      </p>
    </div>
  );
}

function Step({ number, title, done, children }: { number: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs",
          done ? "border-transparent bg-primary text-primary-foreground" : "border-border text-muted-foreground",
        )}
      >
        {done ? "✓" : number}
      </span>
      <div className="min-w-0 text-muted-foreground">
        <p className="font-medium text-foreground">
          {title}
          {done ? <span className="sr-only"> (done)</span> : null}
        </p>
        <div className="mt-0.5">{children}</div>
      </div>
    </li>
  );
}
