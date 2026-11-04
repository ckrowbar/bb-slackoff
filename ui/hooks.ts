// Data hooks over the server's RPC, refreshed by its change signal.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";

import { CHANGED_CHANNEL } from "../src/channel.ts";
import type { Overview, RpcContract, ThreadState } from "../src/contract.ts";

export function useSlackoffRpc() {
  return useRpc<RpcContract>();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useOverview() {
  const rpc = useSlackoffRpc();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("overview").then(
      (next) => {
        setOverview(next);
        setError(null);
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);
  return { overview, setOverview, error, setError, refetch, rpc };
}

export function useThreadState(threadId: string) {
  const rpc = useSlackoffRpc();
  const [state, setState] = useState<ThreadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("threadState", { threadId }).then(
      (next) => {
        setState(next);
        setError(null);
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED_CHANNEL, (payload) => {
    const changed = (payload as { threadId?: string | null } | null)?.threadId;
    if (changed === undefined || changed === null || changed === threadId) refetch();
  });
  return { state, setState, error, setError, refetch, rpc };
}

export { errorMessage };
