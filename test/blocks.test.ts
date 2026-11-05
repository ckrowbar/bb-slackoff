import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildHomeView, buildNewThreadModal } from "../src/blocks/home.ts";
import { buildQuestionCard } from "../src/blocks/interaction-cards.ts";
import { buildThreadCard, type ThreadCardState } from "../src/blocks/thread-card.ts";
import { createAppUrl, SLACK_MANIFEST } from "../src/manifest.ts";

const base: ThreadCardState = {
  threadId: "thr_1",
  title: "x".repeat(400),
  projectName: "parser",
  status: "working",
  activity: "Running command · `npm test`",
  model: { id: "a", name: "Opus" },
  effort: "high",
  models: Array.from({ length: 150 }, (_, index) => ({ id: `m${index % 120}`, name: `Model ${index}` })),
  efforts: ["low", "high"],
  sections: Array.from({ length: 120 }, (_, index) => ({ id: `sec_${index}`, name: `Section ${index}` })),
  sectionId: "sec_3",
  progress: {
    startedAt: 0,
    now: 75_000,
    steps: Array.from({ length: 30 }, (_, index) => ({ id: `s${index}`, label: "y".repeat(300), state: "done" as const })),
    plan: Array.from({ length: 20 }, (_, index) => ({ step: `Step ${index}`, status: "pending" as const })),
    update: "z".repeat(5_000),
    showSteps: true,
  },
  mirrored: true,
};

/** Every limit Slack enforces on the elements we use. */
function assertWithinLimits(blocks: unknown[]): void {
  assert.ok(blocks.length <= 50, "at most 50 blocks");
  for (const block of blocks as Record<string, any>[]) {
    if (block.type === "header") assert.ok(block.text.text.length <= 150, "header ≤150");
    if (block.type === "section" && block.text) assert.ok(block.text.text.length <= 3_000, "section ≤3000");
    if (block.type === "context") {
      assert.ok(block.elements.length <= 10);
      for (const element of block.elements) assert.ok(element.text.length <= 3_000);
    }
    if (block.type === "actions") {
      assert.ok(block.elements.length <= 25, "≤25 elements per actions block");
      const ids = block.elements.map((element: { action_id: string }) => element.action_id);
      assert.equal(new Set(ids).size, ids.length, "unique action ids");
      for (const element of block.elements) {
        if (element.type === "button") assert.ok(element.text.text.length <= 75 && (element.value ?? "").length <= 2_000);
        if (element.type === "static_select") {
          assert.ok(element.options.length <= 100);
          assert.equal(new Set(element.options.map((option: { value: string }) => option.value)).size, element.options.length, "unique option values");
          for (const option of element.options) assert.ok(option.text.text.length <= 75);
        }
        if (element.type === "overflow") assert.ok(element.options.length >= 1 && element.options.length <= 5);
      }
    }
  }
}

test("the status card stays within Slack's limits under extreme input", () => {
  const card = buildThreadCard(base);
  assertWithinLimits(card.blocks);
  assert.match(JSON.stringify(card.blocks), /1m 15s · 30 steps/);
  assert.ok(card.text.length < 200);
});

test("the status card hides live controls once archived and collapses when not mirrored", () => {
  const archived = buildThreadCard({ ...base, status: "archived" });
  assert.doesNotMatch(JSON.stringify(archived.blocks), /slackoff_model|slackoff_stop/);
  const closed = buildThreadCard({ ...base, mirrored: false });
  assert.match(JSON.stringify(closed.blocks), /Resume mirroring/);
  assertWithinLimits(closed.blocks);
});

test("question and home views stay within limits", () => {
  const options = Array.from({ length: 5 }, (_, index) => ({ label: "o".repeat(200), value: `v${index}` }));
  const card = buildQuestionCard({
    threadId: "thr_1",
    threadTitle: "t",
    interactionId: "i",
    questions: [{ id: "q", prompt: "p".repeat(10_000), multiSelect: false, allowFreeText: true, options }],
  });
  assertWithinLimits(card.blocks);
  const home = buildHomeView({ threads: Array.from({ length: 80 }, () => ({ title: "t".repeat(300), projectName: "p", status: "done" as const })) });
  assertWithinLimits(home.blocks);
  const modal = buildNewThreadModal({ projects: [{ id: "p", name: "n".repeat(200) }], projectId: "p", prompt: "x".repeat(9_000) });
  assert.ok(modal.title.text.length <= 24);
});

test("slack-manifest.json matches the manifest the setup link uses", () => {
  const file = JSON.parse(readFileSync(new URL("../slack-manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(file, SLACK_MANIFEST);
  const url = new URL(createAppUrl());
  assert.equal(url.searchParams.get("new_app"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("manifest_json") ?? "{}"), SLACK_MANIFEST);
});
