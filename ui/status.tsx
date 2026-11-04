// Connection status shared by the sidebar panel and the setup section.
import type { Connection } from "../src/contract.ts";
import { cn } from "@/lib/utils";

const DOT: Record<Connection["state"], string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  error: "bg-destructive",
  off: "bg-muted-foreground/50",
  unconfigured: "bg-muted-foreground/50",
};

export function connectionText(connection: Connection): string {
  switch (connection.state) {
    case "connected":
      return connection.team ? `Connected to ${connection.team}` : "Connected to Slack";
    case "connecting":
      return "Connecting to Slack…";
    case "error":
      return connection.error ?? "Not connected";
    case "off":
      return "Off. Mirrored threads are paused.";
    case "unconfigured":
      return "Not set up yet";
  }
}

export function ConnectionLine({ connection, className }: { connection: Connection; className?: string }) {
  return (
    <p className={cn("flex min-w-0 items-center gap-2 text-xs text-muted-foreground", connection.state === "error" && "text-destructive", className)} role="status">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[connection.state])} />
      <span className="truncate">{connectionText(connection)}</span>
    </p>
  );
}
