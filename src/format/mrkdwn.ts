// Slack mrkdwn helpers: escaping for card text, a degraded rendering used when
// Slack rejects rich blocks, and conversion of user messages back to Markdown.
import type {
  KnownBlock,
  RichTextElement,
  RichTextInline,
  SlackMessage,
  TableCell,
  TextStyle,
} from "../slack/types.ts";
import { asciiTable, splitText } from "./markdown.ts";

const SECTION_TEXT_MAX = 3_000;

/** Escape the three characters Slack treats as control sequences in mrkdwn. */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Reverse Slack's entity escaping. `&amp;` is decoded last so `&amp;lt;` stays literal. */
export function unescapeMrkdwn(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** Truncate to `maximum` UTF-16 units with an ellipsis. */
export function truncate(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1)}…`;
}

// ---------------------------------------------------------------------------
// Rich blocks → mrkdwn sections (fallback when Slack rejects a block payload)

export function toMrkdwnFallback(message: SlackMessage): SlackMessage {
  // Only rich_text and table blocks are converted; cards' sections, context
  // and action buttons pass through unchanged.
  const blocks: KnownBlock[] = [];
  for (const block of message.blocks) {
    if (block.type !== "rich_text" && block.type !== "table") {
      blocks.push(block);
      continue;
    }
    for (const chunk of splitText(blockMrkdwn(block), SECTION_TEXT_MAX)) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }
  }
  return { text: message.text, blocks: blocks.slice(0, 50) };
}

function blockMrkdwn(block: KnownBlock): string {
  switch (block.type) {
    case "rich_text":
      return block.elements.map(richElementMrkdwn).join("\n");
    case "table": {
      const rows = block.rows.map((row) => row.map(cellText));
      const align = (block.column_settings ?? []).map((setting) => setting?.align ?? null);
      return "```\n" + escapeMrkdwn(asciiTable(rows, align)) + "\n```";
    }
    case "divider":
      return "———";
    case "section":
      return block.text?.text ?? "";
    case "header":
      return `*${escapeMrkdwn(block.text.text)}*`;
    case "context":
      return block.elements.map((element) => element.text).join(" ");
    default:
      return "";
  }
}

function richElementMrkdwn(element: RichTextElement): string {
  switch (element.type) {
    case "rich_text_section":
      return element.elements.map(inlineMrkdwn).join("");
    case "rich_text_list":
      return element.elements
        .map((item, index) => {
          const indent = "    ".repeat(element.indent ?? 0);
          const marker = element.style === "ordered" ? `${(element.offset ?? 0) + index + 1}.` : "•";
          return `${indent}${marker} ${item.elements.map(inlineMrkdwn).join("")}`;
        })
        .join("\n");
    case "rich_text_preformatted":
      return "```\n" + element.elements.map((inline) => escapeMrkdwn(inlineText(inline))).join("") + "\n```";
    case "rich_text_quote":
      return element.elements
        .map(inlineMrkdwn)
        .join("")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
  }
}

function inlineMrkdwn(element: RichTextInline): string {
  switch (element.type) {
    case "text":
      return wrapStyle(escapeMrkdwn(element.text), element.style);
    case "link": {
      const label = element.text ? `|${escapeMrkdwn(element.text).replaceAll("|", "¦")}` : "";
      return wrapStyle(`<${element.url.replaceAll(">", "%3E").replaceAll("|", "%7C")}${label}>`, element.style);
    }
    case "emoji":
      return `:${element.name}:`;
    case "user":
      return `<@${element.user_id}>`;
    case "channel":
      return `<#${element.channel_id}>`;
  }
}

function wrapStyle(text: string, style: TextStyle | undefined): string {
  if (!style || !text.trim()) return text;
  // mrkdwn markers must hug the text, so keep surrounding whitespace outside them.
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(text);
  const [, before = "", core = text, after = ""] = match ?? [];
  let out = core;
  if (style.code) out = `\`${out}\``;
  if (style.strike) out = `~${out}~`;
  if (style.italic) out = `_${out}_`;
  if (style.bold) out = `*${out}*`;
  return before + out + after;
}

function inlineText(element: RichTextInline): string {
  switch (element.type) {
    case "text":
      return element.text;
    case "link":
      return element.text ?? element.url;
    case "emoji":
      return `:${element.name}:`;
    case "user":
      return `<@${element.user_id}>`;
    case "channel":
      return `<#${element.channel_id}>`;
  }
}

function cellText(cell: TableCell): string {
  if (cell.type === "raw_text") return cell.text;
  return cell.elements
    .map((element) => (element.type === "rich_text_list" ? "" : element.elements.map(inlineText).join("")))
    .join("");
}

// ---------------------------------------------------------------------------
// Slack user messages → Markdown for the agent

interface RawRichText {
  type?: unknown;
  elements?: unknown;
  style?: unknown;
  indent?: unknown;
  offset?: unknown;
  text?: unknown;
  url?: unknown;
  name?: unknown;
  unicode?: unknown;
  user_id?: unknown;
  channel_id?: unknown;
  range?: unknown;
  usergroup_id?: unknown;
}

/**
 * Convert a Slack message to Markdown. Slack's composer sends rich_text
 * blocks, which keep code blocks, lists and quotes; the mrkdwn `text` field is
 * the fallback for clients and bots that send none.
 */
export function slackMessageToMarkdown(text: string, blocks: unknown): string {
  if (Array.isArray(blocks)) {
    const richBlocks = blocks.filter((block): block is RawRichText => isObject(block) && block.type === "rich_text");
    if (richBlocks.length > 0) {
      const markdown = richBlocks
        .map((block) => (Array.isArray(block.elements) ? block.elements : []).map(richToMarkdown).filter(Boolean).join("\n"))
        .join("\n")
        .trim();
      if (markdown) return markdown;
    }
  }
  return mrkdwnToMarkdown(text);
}

function richToMarkdown(raw: unknown): string {
  if (!isObject(raw)) return "";
  const elements = Array.isArray(raw.elements) ? raw.elements : [];
  switch (raw.type) {
    case "rich_text_section":
      return elements.map(inlineToMarkdown).join("");
    case "rich_text_preformatted":
      return "```\n" + elements.map((element) => plainOf(element)).join("").replace(/\n+$/u, "") + "\n```";
    case "rich_text_quote":
      return elements
        .map(inlineToMarkdown)
        .join("")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rich_text_list": {
      const indent = "  ".repeat(typeof raw.indent === "number" ? raw.indent : 0);
      const offset = typeof raw.offset === "number" ? raw.offset : 0;
      return elements
        .map((item, index) => {
          const marker = raw.style === "ordered" ? `${offset + index + 1}.` : "-";
          return `${indent}${marker} ${richToMarkdown(item)}`;
        })
        .join("\n");
    }
    default:
      return "";
  }
}

function inlineToMarkdown(raw: unknown): string {
  if (!isObject(raw)) return "";
  const style = isObject(raw.style) ? (raw.style as TextStyle) : {};
  switch (raw.type) {
    case "text":
      return styleMarkdown(typeof raw.text === "string" ? raw.text : "", style);
    case "link": {
      const url = typeof raw.url === "string" ? raw.url : "";
      const label = typeof raw.text === "string" && raw.text ? raw.text : "";
      return styleMarkdown(label && label !== url ? `[${label}](${url})` : url, style);
    }
    case "emoji":
      if (typeof raw.unicode === "string" && /^[0-9a-f-]+$/iu.test(raw.unicode)) {
        try {
          return String.fromCodePoint(...raw.unicode.split("-").map((hex) => Number.parseInt(hex, 16)));
        } catch {
          // Fall through to the shortcode.
        }
      }
      return typeof raw.name === "string" ? `:${raw.name}:` : "";
    case "user":
      return typeof raw.user_id === "string" ? `<@${raw.user_id}>` : "";
    case "channel":
      return typeof raw.channel_id === "string" ? `<#${raw.channel_id}>` : "";
    case "usergroup":
      return typeof raw.usergroup_id === "string" ? `<!subteam^${raw.usergroup_id}>` : "";
    case "broadcast":
      return typeof raw.range === "string" ? `@${raw.range}` : "";
    default:
      return plainOf(raw);
  }
}

function styleMarkdown(text: string, style: TextStyle): string {
  if (!text.trim()) return text;
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(text);
  const [, before = "", core = text, after = ""] = match ?? [];
  let out = core;
  if (style.code) out = `\`${out}\``;
  if (style.strike) out = `~~${out}~~`;
  if (style.italic) out = `*${out}*`;
  if (style.bold) out = `**${out}**`;
  return before + out + after;
}

function plainOf(raw: unknown): string {
  if (!isObject(raw)) return "";
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.url === "string") return raw.url;
  return "";
}

/** mrkdwn → Markdown: links become Markdown links, entities are decoded and styles translated. */
export function mrkdwnToMarkdown(text: string): string {
  const linked = text.replace(/<([^<>]*)>/gu, (_match, body: string) => {
    const pipe = body.indexOf("|");
    const target = pipe === -1 ? body : body.slice(0, pipe);
    const label = pipe === -1 ? "" : body.slice(pipe + 1);
    if (target.startsWith("@") || target.startsWith("#")) return `<${target}>`;
    if (target.startsWith("!")) return `@${(label || target.slice(1)).replace(/^@/u, "")}`;
    return label && label !== target && !target.endsWith(label) ? `[${label}](${target})` : target;
  });
  return unescapeMrkdwn(linked).trim();
}

function isObject(value: unknown): value is RawRichText {
  return typeof value === "object" && value !== null;
}
