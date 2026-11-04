import assert from "node:assert/strict";
import { test } from "node:test";

import { mrkdwnToMarkdown, toMrkdwnFallback } from "../src/format/mrkdwn.ts";

test("the mrkdwn fallback keeps card controls", () => {
  const actions = { type: "actions" as const, elements: [{ type: "button" as const, action_id: "a", text: { type: "plain_text" as const, text: "Go" } }] };
  const fallback = toMrkdwnFallback({
    text: "t",
    blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "a < b", style: { bold: true } }] }] }, actions],
  });
  assert.deepEqual(fallback.blocks, [{ type: "section", text: { type: "mrkdwn", text: "*a &lt; b*" } }, actions]);
});

test("Slack links and entities become Markdown", () => {
  assert.equal(mrkdwnToMarkdown("see <https://x.dev|docs>, <https://y.dev> &amp; <@U1> <!here>"), "see [docs](https://x.dev), https://y.dev & <@U1> @here");
});
