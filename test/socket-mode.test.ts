import assert from "node:assert/strict";
import { test } from "node:test";

import { SocketModeClient, type SocketLike } from "../src/slack/socket-mode.ts";

class FakeSocket implements SocketLike {
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  closed = false;

  on(event: string, listener: (...args: never[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener as (...args: unknown[]) => void]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  receive(value: unknown) {
    this.emit("message", JSON.stringify(value));
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  ping() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", 1000);
  }
  terminate() {
    this.close();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("acknowledges envelopes, reports the connection and reconnects on refresh", async () => {
  const sockets: FakeSocket[] = [];
  const states: boolean[] = [];
  const controller = new AbortController();
  let opened = 0;
  const client = new SocketModeClient({
    openConnection: async () => `wss://slack.test/${(opened += 1)}`,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEnvelope: (envelope) => (envelope.type === "interactive" ? { response_action: "errors" } : undefined),
    onConnectionChange: (up) => states.push(up),
    log: { info() {}, warn() {} },
    sleep: async () => {},
  });
  const done = client.run(controller.signal);
  await tick();

  const first = sockets[0]!;
  first.emit("open");
  first.receive({ type: "hello" });
  first.receive({ type: "events_api", envelope_id: "e1", payload: {} });
  first.receive({ type: "interactive", envelope_id: "e2", payload: {} });
  await tick();
  assert.deepEqual(first.sent, [{ envelope_id: "e1" }, { envelope_id: "e2", payload: { response_action: "errors" } }]);

  first.receive({ type: "disconnect", reason: "refresh_requested" });
  await tick();
  await tick();
  assert.equal(first.closed, true);
  assert.equal(opened, 2, "a refresh opens a new connection");
  assert.deepEqual(states, [true, false]);

  controller.abort();
  await done;
  assert.equal(sockets[1]?.closed, true);
});
