import assert from "node:assert/strict";
import { test } from "node:test";

import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import { ACTION, MORE } from "../src/blocks/common.ts";
import { DM, MemoryKv, FakeSlack, PROJECT, THREAD, USER, action, approval, json, message, question, setup } from "./helpers.ts";

test("enabling posts a status card and the latest reply", async () => {
  const { bridge, slack, store, settle } = setup({ output: "Done: **parser** fixed." });
  await bridge.enable(THREAD);
  await settle();
  const [card, latest] = slack.posts();
  assert.equal(card?.body.channel, USER);
  assert.match(json(card?.body.blocks), /Fix the parser/);
  assert.match(json(card?.body.blocks), /parser · Opus 5.5 · high/);
  assert.equal(latest?.body.thread_ts, card?.ts);
  assert.match(json(latest?.body.blocks), /"text":"parser","style":\{"bold":true\}/);
  const binding = await store.get(THREAD);
  assert.equal(binding?.rootTs, card?.ts);
  assert.equal(binding?.cardTs, card?.ts);
  assert.ok(bridge.isMirrored(THREAD));
});

test("final mode posts one reply per turn and shows earlier messages on the card", async () => {
  const { bridge, slack, push, notify, settle } = setup();
  await bridge.enable(THREAD);
  const cardTs = slack.posts()[0]?.ts;
  push("client/turn/requested", { initiator: "user", input: [{ type: "text", text: "Run the tests", mentions: [] }] });
  push("turn/started", {});
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "Looking at the **parser** first." } });
  push("item/started", { item: { type: "commandExecution", id: "c1", command: "npm test", status: "pending" } });
  notify();
  await settle();

  const live = slack.updatesOf(cardTs).at(-1);
  assert.match(json(live?.body.blocks), /🔵 Working · Running command · `npm test`/);
  assert.match(json(live?.body.blocks), /Looking at the /);
  assert.match(json(live?.body.blocks), /⏳ Running command/);
  assert.equal(slack.replies().length, 1, "only the BB prompt so far");
  assert.match(json(slack.replies()[0]?.body.blocks), /💬 You/);

  push("item/completed", { item: { type: "commandExecution", id: "c1", command: "npm test", status: "completed" } });
  push("item/completed", { item: { type: "agentMessage", id: "m2", text: "All green:\n\n- `npm test`" } });
  push("turn/completed", { status: "completed" });
  notify();
  await settle();

  const replies = slack.replies();
  assert.equal(replies.length, 2);
  assert.match(json(replies[1]?.body.blocks), /rich_text_list/);
  assert.equal(replies[1]?.body.text, "✅ Fix the parser: All green: • npm test");
  const done = slack.updatesOf(cardTs).at(-1);
  assert.match(json(done?.body.blocks), /🟢 Done/);
  assert.match(json(done?.body.blocks), /1 step/);
  assert.doesNotMatch(json(done?.body.blocks), /Looking at the/, "the finished card drops live progress");
});

test("every mode posts each agent message", async () => {
  const { bridge, slack, push, notify, settle } = setup({ preferences: { replies: "every" } });
  await bridge.enable(THREAD);
  push("turn/started", {});
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "First." } });
  push("item/completed", { item: { type: "agentMessage", id: "m2", text: "Second." } });
  push("turn/completed", { status: "completed" });
  notify();
  await settle();
  assert.deepEqual(
    slack.replies().map((reply) => reply.body.text),
    ["💬 Fix the parser: First.", "💬 Fix the parser: Second."],
  );
});

test("a reply held across a restart is posted once", async () => {
  const kv = new MemoryKv();
  const slack = new FakeSlack();
  const harness = setup({ kv, slack });
  await harness.bridge.enable(THREAD);
  harness.push("turn/started", {});
  harness.push("item/completed", { item: { type: "agentMessage", id: "m1", text: "Final answer." } });
  harness.notify();
  await harness.settle();
  assert.equal(slack.replies().length, 0, "held until the turn ends");

  const next = await harness.restart();
  harness.push("turn/completed", { status: "completed" });
  next.onThreadEvents(makeThreadResponse({ id: THREAD }));
  await harness.settle();
  assert.deepEqual(
    slack.replies().map((reply) => reply.body.text),
    ["✅ Fix the parser: Final answer."],
  );
});

test("a Slack reply goes to BB, is not mirrored back, and is marked done", async () => {
  const { bridge, slack, harness, push, notify, settle } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(message("Please use <https://example.com|the docs> &amp; retry", { thread_ts: binding.rootTs }));
  await settle();
  const [send] = harness.callsTo("threads.send");
  assert.deepEqual((send?.[0] as { input: unknown }).input, [{ type: "text", text: "Please use [the docs](https://example.com) & retry", mentions: [] }]);
  assert.deepEqual(slack.reactions(), ["+eyes"]);

  push("client/turn/requested", { initiator: "user", input: [{ type: "text", text: "Please use [the docs](https://example.com) & retry", mentions: [] }] });
  push("turn/started", {});
  push("turn/completed", { status: "completed" });
  notify();
  await settle();
  assert.equal(slack.replies().length, 0, "the echo is suppressed");
  assert.deepEqual(slack.reactions(), ["+eyes", "-eyes", "+white_check_mark"]);
});

test("Slack rich text keeps code blocks for the agent", async () => {
  const { bridge, harness, settle } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(
    message("ignored", {
      thread_ts: binding.rootTs,
      blocks: [
        {
          type: "rich_text",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "Run " }, { type: "text", text: "this", style: { bold: true } }] },
            { type: "rich_text_preformatted", elements: [{ type: "text", text: "npm test" }] },
          ],
        },
      ],
    }),
  );
  await settle();
  const [send] = harness.callsTo("threads.send");
  assert.equal((send?.[0] as { input: { text: string }[] }).input[0]?.text, "Run **this**\n```\nnpm test\n```");
});

test("a voice memo is transcribed and sent as text", async () => {
  const { bridge, slack, harness, settle } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(
    message("", {
      thread_ts: binding.rootTs,
      subtype: "file_share",
      files: [{ id: "F1", name: "audio.webm", mimetype: "audio/webm", subtype: "slack_audio", size: 3, url_private_download: "https://files.slack.com/a.webm" }],
    }),
  );
  await settle();
  const [send] = harness.callsTo("threads.send");
  assert.deepEqual((send?.[0] as { input: unknown }).input, [{ type: "text", text: "please run the tests", mentions: [] }]);
  assert.match(String(slack.of("chat.postEphemeral")[0]?.body.text), /🎙️ Heard: please run the tests/);
});

test("commands control the thread", async () => {
  const { bridge, harness, slack, settle } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(message("!stop", { thread_ts: binding.rootTs }));
  bridge.handleEnvelope(message("!model claude-sonnet-5-5", { thread_ts: binding.rootTs }));
  bridge.handleEnvelope(message("!help", { thread_ts: binding.rootTs }));
  await settle();
  assert.equal(harness.callsTo("threads.stop").length, 1);
  assert.deepEqual(harness.callsTo("threads.update")[0]?.[0], { threadId: THREAD, model: "claude-sonnet-5-5" });
  assert.equal(harness.callsTo("threads.send").length, 0);
  assert.match(String(slack.of("chat.postEphemeral")[0]?.body.text), /!stop/);
});

test("the card's menu compacts and stops mirroring", async () => {
  const { bridge, harness, slack, settle } = setup();
  await bridge.enable(THREAD);
  bridge.handleEnvelope(action(ACTION.more, "", { block_id: `ctl:${THREAD}`, selected_option: { value: MORE.compact } }));
  bridge.handleEnvelope(action(ACTION.more, "", { block_id: `ctl:${THREAD}`, selected_option: { value: MORE.stopMirroring } }));
  await settle();
  assert.equal(harness.callsTo("threads.compact").length, 1);
  assert.match(json(slack.of("chat.update").at(-1)?.body.blocks), /Resume mirroring/);
  assert.equal(bridge.isMirrored(THREAD), false);
});

test("messages and clicks from other Slack users are ignored", async () => {
  const { bridge, harness, settle, logs } = setup();
  const binding = await bridge.enable(THREAD);
  bridge.handleEnvelope(message("hi", { thread_ts: binding.rootTs, user: "U0OTHER" }));
  bridge.handleEnvelope({ type: "interactive", envelope_id: "e", payload: { type: "block_actions", user: { id: "U0OTHER" }, actions: [{ action_id: ACTION.stop, value: THREAD }] } });
  await settle();
  assert.equal(harness.callsTo("threads.send").length, 0);
  assert.equal(harness.callsTo("threads.stop").length, 0);
  assert.ok(logs.some((line) => /unauthorised/.test(line)));
});

test("approvals get buttons that resolve the interaction", async () => {
  const pending = approval();
  const { bridge, slack, harness, settle, interactions } = setup();
  await bridge.enable(THREAD);
  interactions.push(pending);
  bridge.onInteraction(makeThreadResponse({ id: THREAD, title: "Fix the parser" }), pending as never);
  await settle();
  const card = slack.posts().find((post) => /Approve command/.test(json(post.body.blocks)))!;
  assert.match(String(card.body.text), /^🔐 Fix the parser: Approve command\? curl/);
  const actions = (card.body.blocks as { type: string; elements?: { action_id: string }[] }[]).find((block) => block.type === "actions")!;
  assert.equal(new Set(actions.elements!.map((element) => element.action_id)).size, 3, "each button in a block needs its own action_id");

  bridge.handleEnvelope(action(`${ACTION.approve}:allow_once`, `${THREAD}|int_1|allow_once`));
  await settle();
  assert.deepEqual(harness.callsTo("threads.interactions.resolve")[0]?.[0], {
    threadId: THREAD,
    interactionId: "int_1",
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  assert.ok(slack.updatesOf(card.ts).some((update) => /✓ Allowed · from Slack/.test(json(update.body.blocks))));
});

test("a session approval passes the provider's session grant", async () => {
  const pending = approval();
  const grant = { fileSystem: null, network: { enabled: true } };
  pending.payload.subject.sessionGrant = grant;
  const { bridge, harness, settle } = setup({ interactions: [pending] });
  await bridge.enable(THREAD);
  await settle();
  bridge.handleEnvelope(action(`${ACTION.approve}:allow_for_session`, `${THREAD}|int_1|allow_for_session`));
  await settle();
  assert.deepEqual((harness.callsTo("threads.interactions.resolve")[0]?.[0] as { resolution: unknown }).resolution, { decision: "allow_for_session", grantedPermissions: grant });
});

test("commands are shown verbatim and long ones must be approved in BB", async () => {
  const fenced = approval();
  fenced.payload.subject.command = "echo '```'\n**not bold**";
  const long = { ...approval(), id: "int_2" };
  long.payload = { ...long.payload, subject: { ...long.payload.subject, command: `curl ${"x".repeat(3_000)}` } };
  const { bridge, slack, settle } = setup({ interactions: [fenced, long] });
  await bridge.enable(THREAD);
  await settle();
  const [first, second] = slack.posts().filter((post) => /Approve command/.test(json(post.body.blocks)));
  assert.match(json(first?.body.blocks), /rich_text_preformatted","elements":\[\{"type":"text","text":"echo '```'\\n\*\*not bold\*\*"/);
  assert.doesNotMatch(json(second?.body.blocks), /slackoff_approve/);
  assert.match(json(second?.body.blocks), /Review it in BB/);
});

test("a reply answers a pending question by option number", async () => {
  const { bridge, slack, harness, settle } = setup({ interactions: [question()] });
  const binding = await bridge.enable(THREAD);
  await settle();
  const card = slack.posts().find((post) => /The agent has a question/.test(json(post.body.blocks)));
  assert.match(String(card?.body.text), /^❓ Fix the parser: Which \*\*database\*\*\?/);
  bridge.handleEnvelope(message("2", { thread_ts: binding.rootTs }));
  await settle();
  assert.deepEqual((harness.callsTo("threads.interactions.resolve")[0]?.[0] as { resolution: unknown }).resolution, {
    kind: "user_answer",
    answers: { q1: { selected: ["sqlite"] } },
  });
  assert.equal(harness.callsTo("threads.send").length, 0);
});

test("a top-level DM starts a thread and remembers the project", async () => {
  const { bridge, slack, harness, store, settle } = setup({ preferences: { defaultProjectId: PROJECT } });
  bridge.handleEnvelope(message("Fix the flaky test", { files: [{ id: "F1", name: "a.png", mimetype: "image/png", size: 3, url_private_download: "https://files.slack.com/a.png" }] }));
  await settle();
  const spawn = harness.callsTo("threads.spawn")[0]?.[0] as { projectId: string; input: unknown[] };
  assert.equal(spawn.projectId, PROJECT);
  assert.deepEqual(spawn.input, [
    { type: "text", text: "Fix the flaky test", mentions: [] },
    { type: "localImage", path: "attachments/a.png" },
  ]);
  const binding = await store.get("thr_new");
  assert.equal(binding?.rootTs, "200.000");
  assert.notEqual(binding?.cardTs, binding?.rootTs);
  assert.equal(slack.posts()[0]?.body.thread_ts, "200.000");
  assert.equal(await store.lastProjectId(), PROJECT);
});

test("a top-level DM with no known project offers one-tap project buttons", async () => {
  const { bridge, slack, harness, store, settle } = setup();
  harness.stub("projects.list", async () => [
    { id: "proj_a", name: "alpha", kind: "standard" },
    { id: "proj_b", name: "beta", kind: "standard" },
  ]);
  harness.stub("threads.list", async () => [{ id: "thr_x", projectId: "proj_b", updatedAt: 5 }]);
  bridge.handleEnvelope(message("Do the thing"));
  await settle();
  assert.equal(harness.callsTo("threads.spawn").length, 0);
  const chooser = slack.posts()[0]!;
  assert.equal(chooser.body.channel, DM);
  assert.equal(chooser.body.thread_ts, "200.000");
  const buttons = (chooser.body.blocks as { type: string; elements?: { text: { text: string }; value: string; action_id: string }[] }[]).filter((block) => block.type === "actions").at(-1)!.elements!;
  assert.deepEqual(
    buttons.map((button) => button.text.text),
    ["beta", "alpha"],
    "the most recently used project comes first",
  );

  bridge.handleEnvelope(action(buttons[1]!.action_id, buttons[1]!.value, {}));
  await settle();
  const spawn = harness.callsTo("threads.spawn")[0]?.[0] as { projectId: string; input: unknown[] };
  assert.equal(spawn.projectId, "proj_a");
  assert.deepEqual(spawn.input, [{ type: "text", text: "Do the thing", mentions: [] }]);
  assert.equal((await store.get("thr_new"))?.rootTs, "200.000");
  assert.equal(await store.lastProjectId(), "proj_a");
});

test("a form that is slow to build opens as Loading and fills in", async () => {
  const { bridge, slack, harness, settle } = setup();
  harness.stub("projects.list", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return [{ id: PROJECT, name: "parser", kind: "standard" }];
  });
  slack.respond = (method) => (method === "views.open" ? { view: { id: "V1" } } : undefined);
  bridge.handleEnvelope({ type: "interactive", envelope_id: "e", payload: { type: "block_actions", user: { id: USER }, trigger_id: "T1", actions: [{ action_id: ACTION.newThread, value: "home" }] } });
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 450));
  await settle();
  assert.match(json(slack.of("views.open")[0]?.body.view), /Loading/);
  assert.equal(slack.of("views.update")[0]?.body.view_id, "V1");
  assert.match(json(slack.of("views.update")[0]?.body.view), /What should the agent do/);
});

test("a tap that arrives too late for a form explains itself", async () => {
  const { bridge, slack, settle, logs } = setup();
  slack.reject = (method) => (method === "views.open" ? "expired_trigger_id" : undefined);
  bridge.handleEnvelope({
    type: "interactive",
    envelope_id: "e",
    payload: { type: "block_actions", user: { id: USER }, trigger_id: "T1", channel: { id: DM }, actions: [{ action_id: ACTION.newThread, value: "home", action_ts: String(Date.now() / 1000 - 5) }] },
  });
  await settle();
  assert.match(String(slack.of("chat.postEphemeral")[0]?.body.text), /took too long/);
  assert.ok(logs.some((line) => /delivered a tap \d+ ms after/.test(line)));
});

test("rejected rich blocks fall back to mrkdwn", async () => {
  const { bridge, slack, push, notify, settle } = setup({ preferences: { replies: "every" } });
  await bridge.enable(THREAD);
  slack.reject = (method, body) => (method === "chat.postMessage" && json(body.blocks).includes("rich_text") ? "invalid_blocks" : undefined);
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "**Bold** and `code`" } });
  notify();
  await settle();
  assert.deepEqual(slack.posts().at(-1)?.body.blocks, [{ type: "section", text: { type: "mrkdwn", text: "*Bold* and `code`" } }]);
});

test("disabling collapses the card and stops mirroring", async () => {
  const { bridge, slack, push, notify, settle } = setup({ preferences: { replies: "every" } });
  await bridge.enable(THREAD);
  await bridge.disable(THREAD);
  await settle();
  assert.match(json(slack.of("chat.update").at(-1)?.body.blocks), /Resume mirroring/);
  const before = slack.posts().length;
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "hidden" } });
  notify();
  await settle();
  assert.equal(slack.posts().length, before);
});

test("pausing marks every card paused", async () => {
  const { bridge, slack, settle } = setup();
  await bridge.enable(THREAD);
  await bridge.pauseAll();
  await settle();
  assert.match(json(slack.of("chat.update").at(-1)?.body.blocks), /⏸️ Paused/);
});

test("a transient BB error during reconcile keeps the mirror", async () => {
  const { bridge, store, harness, settle } = setup();
  await bridge.enable(THREAD);
  harness.stub("threads.get", async () => {
    throw new Error("socket hang up");
  });
  await bridge.reconcileAll();
  await settle();
  assert.ok(await store.get(THREAD));
});

test("the native status line follows the agent's activity", async () => {
  const { bridge, slack, push, notify, settle } = setup();
  await bridge.enable(THREAD);
  push("turn/started", {});
  push("item/started", { item: { type: "commandExecution", id: "c1", command: "npm test", status: "pending" } });
  notify();
  await settle();
  const statuses = slack.of("assistant.threads.setStatus").map((call) => call.body.status);
  assert.ok(statuses.includes("is running command · `npm test`…"), String(statuses));
  push("turn/completed", { status: "completed" });
  notify();
  await settle();
  assert.equal(slack.of("assistant.threads.setStatus").at(-1)?.body.status, "");
});

test("a Slack outage while posting the final reply retries it", async () => {
  const { bridge, slack, push, notify, settle } = setup();
  await bridge.enable(THREAD);
  push("turn/started", {});
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "Final answer." } });
  push("turn/completed", { status: "completed" });
  slack.reject = (method, body) => (method === "chat.postMessage" && body.thread_ts ? "internal_error" : undefined);
  notify();
  await settle();
  assert.equal(slack.replies().filter((call) => call.ts).length, 0);
  slack.reject = undefined;
  notify();
  await settle();
  assert.deepEqual(
    slack.replies().filter((call) => call.ts).map((call) => call.body.text),
    ["✅ Fix the parser: Final answer."],
  );
});

test("a provider that only goes idle still gets one reply, even across a restart", async () => {
  const harness = setup();
  await harness.bridge.enable(THREAD);
  harness.push("turn/started", {});
  harness.push("item/completed", { item: { type: "agentMessage", id: "m1", text: "Done without turn/completed." } });
  harness.notify();
  await harness.settle();
  harness.bridge.onThreadStatus(harness.thread, "idle");
  await harness.settle();
  assert.equal(harness.slack.replies().length, 1);
  const next = await harness.restart();
  next.onThreadStatus(harness.thread, "idle");
  await harness.settle();
  assert.equal(harness.slack.replies().length, 1, "no second post after a restart");
});

test("a reply held while Slackoff was down goes out on reconnect", async () => {
  const harness = setup();
  await harness.bridge.enable(THREAD);
  harness.push("turn/started", {});
  harness.push("item/completed", { item: { type: "agentMessage", id: "m1", text: "Finished while you were away." } });
  harness.notify();
  await harness.settle();
  const next = await harness.restart();
  await next.reconcileAll();
  await harness.settle();
  assert.deepEqual(
    harness.slack.replies().map((call) => call.body.text),
    ["✅ Fix the parser: Finished while you were away."],
  );
});

test("a new turn releases the previous turn's held reply", async () => {
  const { bridge, slack, push, notify, settle } = setup();
  await bridge.enable(THREAD);
  push("turn/started", {}, "t1");
  push("item/completed", { item: { type: "agentMessage", id: "m1", text: "First turn done." } }, "t1");
  push("turn/started", {}, "t2");
  notify();
  await settle();
  assert.deepEqual(
    slack.replies().map((call) => call.body.text),
    ["✅ Fix the parser: First turn done."],
  );
});

test("Slack messages reach the agent in the order they were sent", async () => {
  const { bridge, slack, harness, settle } = setup();
  const binding = await bridge.enable(THREAD);
  slack.downloadDelayMs = 30;
  bridge.handleEnvelope(message("", { thread_ts: binding.rootTs, subtype: "file_share", files: [{ id: "F1", name: "a.png", mimetype: "image/png", size: 3, url_private_download: "https://files.slack.com/a.png" }] }));
  bridge.handleEnvelope(message("and here is the context", { thread_ts: binding.rootTs, ts: "201.000" }));
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  const sends = harness.callsTo("threads.send").map((call) => (call[0] as { input: { type: string }[] }).input[0]?.type);
  assert.deepEqual(sends, ["localImage", "text"]);
});

test("App Home rows open the Slack thread view", async () => {
  const { bridge, slack, settle } = setup();
  await bridge.enable(THREAD);
  bridge.handleEnvelope({ type: "events_api", envelope_id: "e", payload: { event_id: "home1", event: { type: "app_home_opened", tab: "home", user: USER } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  const view = slack.of("views.publish").at(-1)?.body.view as { blocks: { accessory?: { url?: string; text: { text: string } } }[] };
  const row = view.blocks.find((block) => block.accessory?.url);
  const cardTs = slack.posts()[0]?.ts;
  assert.equal(row?.accessory?.text.text, "Open");
  assert.equal(row?.accessory?.url, `https://slack.test/${cardTs}?thread_ts=${cardTs}&cid=${DM}`);
});

test("a DM thread can be put in a sidebar section before it starts", async () => {
  const { bridge, slack, harness, store, settle } = setup();
  harness.stub("projects.list", async () => [
    { id: "proj_a", name: "alpha", kind: "standard" },
    { id: "proj_b", name: "beta", kind: "standard" },
  ]);
  bridge.handleEnvelope(message("Review the PR"));
  await settle();
  const blocks = slack.posts()[0]?.body.blocks as { type: string; block_id?: string; elements?: { action_id: string; value?: string; options?: { value: string }[] }[] }[];
  const sectionRow = blocks.find((block) => block.block_id?.startsWith("origin:"))!;
  assert.deepEqual(
    sectionRow.elements![0]!.options!.map((choice) => choice.value),
    ["none", "sec_reviews", "sec_misc"],
  );
  bridge.handleEnvelope(action(ACTION.pickSection, "", { block_id: sectionRow.block_id, selected_option: { value: "sec_reviews" } }));
  const projectButton = blocks.filter((block) => block.type === "actions").at(-1)!.elements![0]!;
  bridge.handleEnvelope(action(projectButton.action_id, projectButton.value ?? ""));
  await settle();
  assert.equal((harness.callsTo("threads.spawn")[0]?.[0] as { sectionId?: string }).sectionId, "sec_reviews");
  assert.equal(await store.lastSectionId(), "sec_reviews");

  // The next DM in a known project reuses the section without asking.
  bridge.handleEnvelope(message("Another one", { ts: "300.000" }));
  await settle();
  assert.equal((harness.callsTo("threads.spawn")[1]?.[0] as { sectionId?: string }).sectionId, "sec_reviews");
});

test("the status card moves a thread between sidebar sections", async () => {
  const { bridge, slack, harness, store, settle } = setup();
  await bridge.enable(THREAD);
  assert.match(json(slack.posts()[0]?.body.blocks), /slackoff_section/);
  bridge.handleEnvelope(action(ACTION.section, "", { block_id: `ctl:${THREAD}`, selected_option: { value: "sec_misc" } }));
  await settle();
  assert.deepEqual(harness.callsTo("threads.update")[0]?.[0], { threadId: THREAD, sectionId: "sec_misc" });
  assert.equal(await store.lastSectionId(), "sec_misc");
  bridge.handleEnvelope(action(ACTION.section, "", { block_id: `ctl:${THREAD}`, selected_option: { value: "none" } }));
  await settle();
  assert.deepEqual(harness.callsTo("threads.update")[1]?.[0], { threadId: THREAD, sectionId: null });
});
