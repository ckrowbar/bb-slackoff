import assert from "node:assert/strict";
import { test } from "node:test";

import { TurnTracker, type Row } from "../src/turn.ts";

let seq = 0;
function row(type: string, data: Record<string, unknown> = {}): Row {
  seq += 1;
  return { seq, type, data, scope: { kind: "turn", turnId: "t1" }, createdAt: seq * 1_000 };
}
const agent = (text: string, extra: Record<string, unknown> = {}) => row("item/completed", { item: { type: "agentMessage", id: `m${seq}`, text, ...extra } });
const command = (id: string, done: boolean, status = "completed") =>
  row(done ? "item/completed" : "item/started", { item: { type: "commandExecution", id, command: "npm test", status: done ? status : "pending" } });

test("final mode holds the last agent message and folds earlier ones into the card", () => {
  const tracker = new TurnTracker("final");
  assert.deepEqual(tracker.onRow(row("turn/started")).map((effect) => effect.kind), ["turnStarted"]);
  assert.deepEqual(tracker.onRow(agent("Looking at the parser.")), []);
  assert.deepEqual(tracker.onRow(command("c1", false)), []);
  assert.equal(tracker.turn?.update, "Looking at the parser.", "work after a message makes it an update");
  assert.equal(tracker.turn?.activity, "Running command · `npm test`");
  tracker.onRow(command("c1", true));
  assert.deepEqual(tracker.onRow(agent("Fixed: tests pass.")), []);
  const effects = tracker.onRow(row("turn/completed", { status: "completed" }));
  assert.deepEqual(
    effects.map((effect) => effect.kind),
    ["reply", "turnFinished"],
  );
  assert.deepEqual(effects[0], { kind: "reply", seq: effects[0]?.kind === "reply" ? effects[0].seq : 0, text: "Fixed: tests pass.", final: true });
});

test("every mode posts each agent message", () => {
  const tracker = new TurnTracker("every");
  tracker.onRow(row("turn/started"));
  assert.equal(tracker.onRow(agent("First.")).at(0)?.kind, "reply");
  tracker.onRow(command("c2", false));
  assert.equal(tracker.onRow(agent("Second.")).at(0)?.kind, "reply");
  assert.deepEqual(
    tracker.onRow(row("turn/completed", { status: "completed" })).map((effect) => effect.kind),
    ["turnFinished"],
  );
});

test("finishing settles running steps and reports failures", () => {
  const tracker = new TurnTracker("final");
  tracker.onRow(row("turn/started"));
  tracker.onRow(command("c3", false));
  const [finished] = tracker.onRow(row("turn/completed", { status: "failed", error: { message: "boom" } }));
  assert.deepEqual(finished && { kind: finished.kind, ...(finished.kind === "turnFinished" ? { status: finished.status, error: finished.error } : {}) }, {
    kind: "turnFinished",
    status: "failed",
    error: "boom",
  });
  assert.equal(tracker.turn?.steps[0]?.state, "failed");
  assert.equal(tracker.turn?.steps[0]?.label, "Ran command · `npm test`");
});

test("user and agent prompts become messages; system prompts do not", () => {
  const tracker = new TurnTracker("final");
  assert.deepEqual(tracker.onRow(row("client/turn/requested", { initiator: "user", input: [{ type: "text", text: "Hi" }, { type: "localImage", path: "a.png" }] })), [
    { kind: "message", seq, initiator: "user", text: "Hi", attachments: 1 },
  ]);
  assert.deepEqual(tracker.onRow(row("client/turn/requested", { initiator: "system", input: [{ type: "text", text: "child done" }] })), []);
});

test("subagent messages and steps are ignored", () => {
  const tracker = new TurnTracker("final");
  tracker.onRow(row("turn/started"));
  tracker.onRow(agent("inner", { parentToolCallId: "tool" }));
  tracker.onRow(row("item/started", { item: { type: "commandExecution", id: "c9", command: "ls", status: "pending", parentToolCallId: "tool" } }));
  assert.equal(tracker.turn?.pendingReply, undefined);
  assert.equal(tracker.turn?.steps.length, 0);
});

test("a turn can start mid-way when mirroring begins during it", () => {
  const tracker = new TurnTracker("final");
  tracker.onRow(command("c4", false));
  assert.equal(tracker.turn?.steps.length, 1);
  tracker.onRow(agent("Done."));
  assert.equal(tracker.finish(seq, "completed").at(0)?.kind, "reply");
});

test("plans come from planSteps items and turn plan updates", () => {
  const tracker = new TurnTracker("final");
  tracker.onRow(row("turn/started"));
  tracker.onRow(row("item/completed", { item: { type: "planSteps", id: "p1", steps: [{ step: "Read", status: "completed" }] } }));
  assert.deepEqual(tracker.turn?.plan, [{ step: "Read", status: "completed" }]);
  tracker.onRow(row("turn/plan/updated", { plan: [{ step: "Write", status: "active" }] }));
  assert.deepEqual(tracker.turn?.plan, [{ step: "Write", status: "active" }]);
});

test("switching to every mode mid-turn posts the held message first", () => {
  const tracker = new TurnTracker("final");
  tracker.onRow(row("turn/started"));
  tracker.onRow(agent("A"));
  tracker.mode = "every";
  const effects = tracker.onRow(agent("B"));
  assert.deepEqual(
    effects.map((effect) => (effect.kind === "reply" ? effect.text : effect.kind)),
    ["A", "B"],
  );
});

test("subagent turn rows do not reset the parent turn", () => {
  const tracker = new TurnTracker("final");
  tracker.onRow(row("turn/started"));
  tracker.onRow(command("c5", false));
  assert.deepEqual(tracker.onRow(row("turn/started", { parentToolCallId: "tool" })), []);
  assert.deepEqual(tracker.onRow(row("turn/completed", { status: "completed", parentToolCallId: "tool" })), []);
  assert.equal(tracker.turn?.steps.length, 1);
});
