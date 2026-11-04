// Thread header control: mirror this thread to Slack, and jump to it there.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import { errorMessage, useThreadState } from "./hooks.ts";

export function ThreadToggle({ threadId }: { threadId: string }) {
  const { state, setState, error, setError, rpc } = useThreadState(threadId);
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);

  // Nothing to toggle until Slackoff is set up and switched on.
  if (state === null || state.connection.state === "unconfigured" || state.connection.state === "off") return null;

  const connected = state.connection.state === "connected";
  const toggle = async () => {
    setPending(true);
    try {
      setState(await rpc.call("setMirrored", { threadId, mirrored: !state.mirrored }));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const label = !connected
    ? `Slackoff is ${state.connection.state === "error" ? "not connected" : "connecting"}${state.connection.error ? `: ${state.connection.error}` : ""}`
    : state.mirrored
      ? "Mirrored to Slack. Click to stop."
      : "Mirror this thread to Slack";

  return (
    <span className="inline-flex items-center gap-0.5">
      <span title={error ?? label} className="inline-flex">
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7", state.mirrored ? "text-primary" : "text-muted-foreground hover:text-foreground", error && "text-destructive")}
          aria-label={label}
          aria-pressed={state.mirrored}
          disabled={pending || !connected}
          onClick={() => void toggle()}
        >
          <Icon name={state.mirrored ? "slackoff/mirror" : "MessageSquarePlus"} className="size-4" />
        </Button>
      </span>
      {state.mirrored && state.permalink ? (
        <span title="Open in Slack" className="inline-flex">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            aria-label="Open this thread in Slack"
            onClick={() => navigate.openUrl(state.permalink ?? "")}
          >
            <Icon name="ExternalLink" className="size-3.5" />
          </Button>
        </span>
      ) : null}
    </span>
  );
}
