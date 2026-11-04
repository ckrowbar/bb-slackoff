import assert from "node:assert/strict";
import { test } from "node:test";

import type { KnownBlock, RichTextBlock } from "../src/slack/types.ts";
import { asciiTable, markdownToPlainText, markdownToSlackMessages } from "../src/format/markdown.ts";

function only(markdown: string): KnownBlock[] {
  const messages = markdownToSlackMessages(markdown);
  assert.equal(messages.length, 1);
  return messages[0]!.blocks;
}

function richElements(markdown: string) {
  const [block] = only(markdown);
  assert.equal(block?.type, "rich_text");
  return (block as RichTextBlock).elements;
}

test("inline styles become rich text styles", () => {
  assert.deepEqual(richElements("Use **bold**, *italic*, ~~gone~~ and `code` with [docs](https://x.dev)."), [
    {
      type: "rich_text_section",
      elements: [
        { type: "text", text: "Use " },
        { type: "text", text: "bold", style: { bold: true } },
        { type: "text", text: ", " },
        { type: "text", text: "italic", style: { italic: true } },
        { type: "text", text: ", " },
        { type: "text", text: "gone", style: { strike: true } },
        { type: "text", text: " and " },
        { type: "text", text: "code", style: { code: true } },
        { type: "text", text: " with " },
        { type: "link", url: "https://x.dev", text: "docs" },
        { type: "text", text: "." },
      ],
    },
  ]);
});

test("Slack control characters stay literal text", () => {
  assert.deepEqual(richElements("a < b && c > d <@U123>"), [
    { type: "rich_text_section", elements: [{ type: "text", text: "a < b && c > d <@U123>" }] },
  ]);
});

test("paragraphs and headings are separated by a blank line", () => {
  assert.deepEqual(richElements("## Result\n\nIt works.\n\nSecond."), [
    { type: "rich_text_section", elements: [{ type: "text", text: "Result", style: { bold: true } }, { type: "text", text: "\n" }] },
    { type: "rich_text_section", elements: [{ type: "text", text: "It works.\n" }] },
    { type: "rich_text_section", elements: [{ type: "text", text: "Second." }] },
  ]);
});

test("nested and ordered lists keep indentation and numbering", () => {
  const elements = richElements("3. three\n   - child **a**\n   - child b\n4. four\n- [x] done\n- [ ] todo");
  assert.deepEqual(elements, [
    { type: "rich_text_list", style: "ordered", offset: 2, elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "three" }] }] },
    {
      type: "rich_text_list",
      style: "bullet",
      indent: 1,
      elements: [
        { type: "rich_text_section", elements: [{ type: "text", text: "child " }, { type: "text", text: "a", style: { bold: true } }] },
        { type: "rich_text_section", elements: [{ type: "text", text: "child b" }] },
      ],
    },
    { type: "rich_text_list", style: "ordered", offset: 3, elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "four" }] }] },
    {
      type: "rich_text_list",
      style: "bullet",
      elements: [
        { type: "rich_text_section", elements: [{ type: "text", text: "☑ done" }] },
        { type: "rich_text_section", elements: [{ type: "text", text: "☐ todo" }] },
      ],
    },
  ]);
});

test("code blocks and quotes use native elements", () => {
  assert.deepEqual(richElements("```ts\nconst a = 1 < 2;\n```\n\n> quoted **text**\n> - item"), [
    { type: "rich_text_preformatted", elements: [{ type: "text", text: "const a = 1 < 2;" }] },
    {
      type: "rich_text_quote",
      elements: [
        { type: "text", text: "quoted " },
        { type: "text", text: "text", style: { bold: true } },
        { type: "text", text: "\n• item" },
      ],
    },
  ]);
});

test("tables become table blocks with alignment", () => {
  const blocks = only("Before\n\n| Name | Count |\n|:--|--:|\n| **a** | 1 |\n| b |  |\n\nAfter");
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["rich_text", "table", "rich_text"],
  );
  assert.deepEqual(blocks[1], {
    type: "table",
    rows: [
      [
        { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Name", style: { bold: true } }] }] },
        { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Count", style: { bold: true } }] }] },
      ],
      [
        { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "a", style: { bold: true } }] }] },
        { type: "raw_text", text: "1" },
      ],
      [{ type: "raw_text", text: "b" }, { type: "raw_text", text: " " }],
    ],
    column_settings: [
      { align: "left", is_wrapped: true },
      { align: "right", is_wrapped: true },
    ],
  });
});

test("oversized tables fall back to monospace", () => {
  const header = `| ${Array.from({ length: 21 }, (_, index) => `c${index}`).join(" | ")} |`;
  const rule = `|${Array.from({ length: 21 }, () => "--").join("|")}|`;
  const [block] = only(`${header}\n${rule}\n| ${Array.from({ length: 21 }, () => "x").join(" | ")} |`);
  assert.equal(block?.type, "rich_text");
  assert.equal((block as RichTextBlock).elements[0]?.type, "rich_text_preformatted");
});

test("ascii tables align columns", () => {
  assert.equal(asciiTable([["a", "num"], ["long", "1"]], [null, "right"]), "a    | num\n-----+----\nlong |   1");
});

test("horizontal rules become dividers", () => {
  assert.deepEqual(
    only("one\n\n---\n\ntwo").map((block) => block.type),
    ["rich_text", "divider", "rich_text"],
  );
});

test("unsafe link schemes render as text", () => {
  assert.deepEqual(richElements("[x](javascript:alert(1))"), [
    { type: "rich_text_section", elements: [{ type: "text", text: "x" }] },
  ]);
});

test("long output is split across messages within the budget", () => {
  const paragraph = "word ".repeat(400).trim();
  const messages = markdownToSlackMessages(`${paragraph}\n\n${paragraph}\n\n\`\`\`\n${"line\n".repeat(900)}\`\`\``, { maxChars: 3_000 });
  assert.ok(messages.length >= 3);
  for (const message of messages) {
    const visible = markdownToPlainTextFromBlocks(message.blocks);
    assert.ok(visible <= 3_000, `message has ${visible} characters`);
    assert.ok(message.text.length > 0);
  }
});

test("a lead label is prepended to the first paragraph", () => {
  const [message] = markdownToSlackMessages("hello", { lead: [{ type: "text", text: "From BB", style: { bold: true } }] });
  assert.deepEqual((message!.blocks[0] as RichTextBlock).elements[0], {
    type: "rich_text_section",
    elements: [
      { type: "text", text: "From BB", style: { bold: true } },
      { type: "text", text: "\nhello" },
    ],
  });
});

test("plain text strips Markdown syntax", () => {
  assert.equal(markdownToPlainText("# Title\n\n- **a**\n- b"), "Title\n• a\n• b");
});

test("empty input produces no messages", () => {
  assert.deepEqual(markdownToSlackMessages("   "), []);
});

function markdownToPlainTextFromBlocks(blocks: KnownBlock[]): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.text === "string" && (record.type === "text" || record.type === "raw_text")) total += record.text.length;
      Object.values(record).forEach(visit);
    }
  };
  visit(blocks);
  return total;
}

test("each table gets its own message", () => {
  const messages = markdownToSlackMessages("| a | b |\n|--|--|\n| 1 | 2 |\n\ntext\n\n| c | d |\n|--|--|\n| 3 | 4 |");
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.blocks.filter((block) => block.type === "table").length === 1));
});

test("tables inside quotes render as monospace text", () => {
  const [block] = only("> intro\n>\n> | a | b |\n> |--|--|\n> | 1 | 2 |");
  assert.match(JSON.stringify(block), /a \| b/);
});
