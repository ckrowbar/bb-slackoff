// Markdown → Slack Block Kit.
//
// Agents write GitHub-flavoured Markdown. Slack's legacy mrkdwn renders only a
// fraction of it, so Slackoff converts the Markdown structure into native
// blocks: rich_text sections, lists, quotes and preformatted code, table blocks
// and dividers. Long output is packed into several messages at block
// boundaries so nothing is cut mid-structure.
import { Lexer, type Token, type Tokens } from "marked";

import type {
  KnownBlock,
  RichTextBlock,
  RichTextElement,
  RichTextInline,
  RichTextList,
  RichTextSection,
  SlackMessage,
  TableBlock,
  TableCell,
  TextStyle,
} from "../slack/types.ts";

/** Visible characters per message. Slack's section limit is 3,000; staying near it keeps every message valid. */
export const MESSAGE_CHAR_BUDGET = 3_000;
/** Slack accepts at most 50 blocks per message. */
const MAX_BLOCKS_PER_MESSAGE = 50;
/** Keep each rich_text block reasonably small so one bad element is easy to spot in Slack's errors. */
const MAX_ELEMENTS_PER_RICH_TEXT = 40;
/** Slack's aggregate limit for all table cells in one message. */
const TABLE_CHAR_LIMIT = 10_000;
const TABLE_MAX_ROWS = 100;
const TABLE_MAX_COLUMNS = 20;
const MAX_LIST_INDENT = 6;
const SAFE_URL = /^(?:https?:|mailto:)/i;

type Unit =
  | { kind: "rich"; element: RichTextElement; size: number }
  | { kind: "table"; block: TableBlock; size: number }
  | { kind: "divider"; size: number };

export interface MarkdownMessageOptions {
  /** Visible characters per message; defaults to MESSAGE_CHAR_BUDGET. */
  maxChars?: number;
  /** Inline elements placed before the first paragraph, such as a bold label. */
  lead?: RichTextInline[];
}

/** Convert Markdown into one or more Slack messages, each within Slack's limits. */
export function markdownToSlackMessages(markdown: string, options: MarkdownMessageOptions = {}): SlackMessage[] {
  const maxChars = options.maxChars ?? MESSAGE_CHAR_BUDGET;
  const units = blockUnits(Lexer.lex(markdown.trim(), { gfm: true }), 0);
  if (options.lead && options.lead.length > 0) prependLead(units, options.lead);
  return pack(units.flatMap((unit) => splitUnit(unit, maxChars)), maxChars);
}

/** Plain text for Slack's notification `text` field and screen readers. */
export function markdownToPlainText(markdown: string): string {
  return blockUnits(Lexer.lex(markdown.trim(), { gfm: true }), 0)
    .map(unitPlainText)
    .join("\n")
    .trim();
}

/** Inline Markdown → rich text elements, for short strings embedded in cards. */
export function inlineMarkdown(markdown: string, style: TextStyle = {}): RichTextInline[] {
  const tokens = Lexer.lexInline(markdown);
  return mergeText(inline(tokens, style));
}

// ---------------------------------------------------------------------------
// Block tokens → units

function blockUnits(tokens: readonly Token[], depth: number): Unit[] {
  const units: Unit[] = [];
  for (const token of tokens) units.push(...blockUnit(token, depth));
  return units;
}

function blockUnit(token: Token, depth: number): Unit[] {
  switch (token.type) {
    case "paragraph":
    case "text": {
      const elements = inline(childTokens(token), {});
      return elements.length > 0 ? [rich(section(elements))] : [];
    }
    case "heading": {
      const elements = inline((token as Tokens.Heading).tokens, { bold: true });
      return elements.length > 0 ? [rich(section(elements))] : [];
    }
    case "code": {
      const text = (token as Tokens.Code).text.replace(/\s+$/u, "");
      return text ? [rich({ type: "rich_text_preformatted", elements: [{ type: "text", text }] })] : [];
    }
    case "blockquote": {
      const elements = quoteInline((token as Tokens.Blockquote).tokens);
      return elements.length > 0 ? [rich({ type: "rich_text_quote", elements })] : [];
    }
    case "list":
      return listUnits(token as Tokens.List, depth);
    case "table":
      return [tableUnit(token as Tokens.Table)];
    case "hr":
      return [{ kind: "divider", size: 0 }];
    case "html": {
      const text = (token as Tokens.HTML).text.trim();
      return text ? [rich(section([{ type: "text", text }]))] : [];
    }
    case "space":
    case "def":
      return [];
    default: {
      const text = "text" in token && typeof token.text === "string" ? token.text.trim() : token.raw.trim();
      return text ? [rich(section([{ type: "text", text }]))] : [];
    }
  }
}

function listUnits(list: Tokens.List, depth: number): Unit[] {
  const indent = Math.min(depth, MAX_LIST_INDENT);
  const ordered = list.ordered;
  const start = ordered && typeof list.start === "number" ? list.start : 1;
  const units: Unit[] = [];
  let emitted = 0;
  let current = newList(ordered, indent, start - 1);

  const flush = () => {
    if (current.elements.length === 0) return;
    units.push(rich(current));
    current = newList(ordered, indent, start - 1 + emitted);
  };

  for (const item of list.items) {
    const lead: RichTextInline[] = [];
    if (item.task) lead.push({ type: "text", text: item.checked ? "☑ " : "☐ " });
    const itemInline: RichTextInline[] = [];
    const trailing: Token[] = [];
    for (const child of item.tokens) {
      if (child.type === "checkbox") continue;
      if (trailing.length === 0 && (child.type === "text" || child.type === "paragraph")) {
        if (itemInline.length > 0) itemInline.push({ type: "text", text: "\n" });
        itemInline.push(...inline(childTokens(child), {}));
        continue;
      }
      if (child.type === "space") continue;
      trailing.push(child);
    }
    const elements = mergeText([...lead, ...itemInline]);
    current.elements.push(section(elements.length > 0 ? elements : [{ type: "text", text: " " }]));
    emitted += 1;
    if (trailing.length > 0) {
      flush();
      units.push(...blockUnits(trailing, depth + 1));
    }
  }
  flush();
  return units;
}

function newList(ordered: boolean, indent: number, offset: number): RichTextList {
  return {
    type: "rich_text_list",
    style: ordered ? "ordered" : "bullet",
    ...(indent > 0 ? { indent } : {}),
    ...(ordered && offset > 0 ? { offset } : {}),
    elements: [],
  };
}

/** Slack quotes hold inline content only, so nested structure is flattened into lines. */
function quoteInline(tokens: readonly Token[]): RichTextInline[] {
  const out: RichTextInline[] = [];
  const newline = () => {
    if (out.length > 0) out.push({ type: "text", text: "\n" });
  };
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "list": {
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          newline();
          const marker = list.ordered ? `${(typeof list.start === "number" ? list.start : 1) + index}. ` : "• ";
          out.push({ type: "text", text: marker });
          out.push(...quoteInline(item.tokens.filter((child) => child.type !== "checkbox")));
        });
        break;
      }
      case "code":
        newline();
        out.push({ type: "text", text: (token as Tokens.Code).text, style: { code: true } });
        break;
      case "blockquote":
        newline();
        out.push(...quoteInline((token as Tokens.Blockquote).tokens));
        break;
      case "heading":
        newline();
        out.push(...inline((token as Tokens.Heading).tokens, { bold: true }));
        break;
      case "table": {
        const table = token as Tokens.Table;
        const rows = [table.header, ...table.rows].map((row) => row.map((cell) => plainInline(cell.tokens)));
        newline();
        out.push({ type: "text", text: asciiTable(rows, table.align), style: { code: true } });
        break;
      }
      case "hr":
        newline();
        out.push({ type: "text", text: "———" });
        break;
      default:
        newline();
        out.push(...inline(childTokens(token), {}));
    }
  }
  return mergeText(out);
}

function tableUnit(table: Tokens.Table): Unit {
  const columns = table.header.length;
  const rows = [table.header, ...table.rows];
  const size = rows.reduce((total, row) => total + row.reduce((sum, cell) => sum + plainInline(cell.tokens).length, 0), 0);
  if (columns > TABLE_MAX_COLUMNS || rows.length > TABLE_MAX_ROWS || size > TABLE_CHAR_LIMIT) {
    const text = asciiTable(rows.map((row) => row.map((cell) => plainInline(cell.tokens))), table.align);
    return rich({ type: "rich_text_preformatted", elements: [{ type: "text", text }] });
  }
  const block: TableBlock = {
    type: "table",
    rows: rows.map((row, rowIndex) =>
      Array.from({ length: columns }, (_, column) => tableCell(row[column]?.tokens ?? [], rowIndex === 0)),
    ),
    column_settings: table.align.map((align) => ({ ...(align ? { align } : {}), is_wrapped: true })),
  };
  return { kind: "table", block, size };
}

function tableCell(tokens: readonly Token[], header: boolean): TableCell {
  const elements = mergeText(inline(tokens, header ? { bold: true } : {}));
  if (elements.length === 0) return { type: "raw_text", text: " " };
  const plain = elements.every((element) => element.type === "text" && !element.style);
  if (plain) return { type: "raw_text", text: elements.map((element) => (element as { text: string }).text).join("") };
  return { type: "rich_text", elements: [section(elements)] };
}

/** Monospace fallback for tables beyond Slack's table block limits. */
export function asciiTable(rows: readonly (readonly string[])[], align: readonly (string | null)[] = []): string {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const clean = rows.map((row) => Array.from({ length: columns }, (_, index) => (row[index] ?? "").replace(/\s+/gu, " ").trim()));
  const widths = Array.from({ length: columns }, (_, index) => Math.max(1, ...clean.map((row) => [...(row[index] ?? "")].length)));
  const pad = (text: string, index: number) => {
    const width = widths[index] ?? 1;
    const gap = width - [...text].length;
    if (align[index] === "right") return " ".repeat(gap) + text;
    if (align[index] === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
    return text + " ".repeat(gap);
  };
  const line = (row: readonly string[]) => row.map(pad).join(" | ").replace(/\s+$/u, "");
  const [header, ...body] = clean;
  if (!header) return "";
  return [line(header), widths.map((width) => "-".repeat(width)).join("-+-"), ...body.map(line)].join("\n");
}

// ---------------------------------------------------------------------------
// Inline tokens → rich text elements

function childTokens(token: Token): Token[] {
  if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) return token.tokens;
  const text = "text" in token && typeof token.text === "string" ? token.text : "";
  return text ? [{ type: "text", raw: text, text } as Tokens.Text] : [];
}

function inline(tokens: readonly Token[], style: TextStyle): RichTextInline[] {
  const out: RichTextInline[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape": {
        const text = token as Tokens.Text;
        if (text.tokens && text.tokens.length > 0) out.push(...inline(text.tokens, style));
        else if (text.text) out.push(styledText(text.text, style));
        break;
      }
      case "strong":
        out.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inline((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "del":
        out.push(...inline((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan": {
        const text = (token as Tokens.Codespan).text;
        if (text) out.push(styledText(text, { ...style, code: true }));
        break;
      }
      case "br":
        out.push({ type: "text", text: "\n" });
        break;
      case "link": {
        const link = token as Tokens.Link;
        const label = plainInline(link.tokens) || link.text;
        if (!SAFE_URL.test(link.href)) {
          out.push(...inline(link.tokens, style));
          break;
        }
        const linkStyle = compactStyle(style);
        out.push({
          type: "link",
          url: link.href,
          ...(label && label !== link.href ? { text: label } : {}),
          ...(linkStyle ? { style: linkStyle } : {}),
        });
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        if (SAFE_URL.test(image.href)) out.push({ type: "link", url: image.href, text: image.text || image.href });
        else if (image.text) out.push(styledText(image.text, style));
        break;
      }
      case "html": {
        const html = (token as Tokens.Tag).text;
        out.push(/^<br\s*\/?>$/i.test(html.trim()) ? { type: "text", text: "\n" } : styledText(html, style));
        break;
      }
      case "checkbox":
        out.push({ type: "text", text: (token as Tokens.Checkbox).checked ? "☑ " : "☐ " });
        break;
      default: {
        const text = "text" in token && typeof token.text === "string" ? token.text : token.raw;
        if (text) out.push(styledText(text, style));
      }
    }
  }
  return mergeText(out);
}

function styledText(text: string, style: TextStyle): RichTextInline {
  const compact = compactStyle(style);
  return compact ? { type: "text", text, style: compact } : { type: "text", text };
}

function compactStyle(style: TextStyle): TextStyle | undefined {
  const out: TextStyle = {};
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.strike) out.strike = true;
  if (style.code) out.code = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sameStyle(a: TextStyle | undefined, b: TextStyle | undefined): boolean {
  return !!a?.bold === !!b?.bold && !!a?.italic === !!b?.italic && !!a?.strike === !!b?.strike && !!a?.code === !!b?.code;
}

/** Join adjacent text runs with the same style so Slack receives compact element lists. */
function mergeText(elements: readonly RichTextInline[]): RichTextInline[] {
  const out: RichTextInline[] = [];
  for (const element of elements) {
    const previous = out.at(-1);
    if (element.type === "text" && previous?.type === "text" && sameStyle(previous.style, element.style)) {
      out[out.length - 1] = { ...previous, text: previous.text + element.text };
      continue;
    }
    if (element.type === "text" && element.text === "") continue;
    out.push(element);
  }
  return out;
}

function plainInline(tokens: readonly Token[]): string {
  return inline(tokens, {}).map(inlinePlainText).join("");
}

// ---------------------------------------------------------------------------
// Sizing, splitting and packing

function section(elements: RichTextInline[]): RichTextSection {
  return { type: "rich_text_section", elements };
}

function rich(element: RichTextElement): Unit {
  return { kind: "rich", element, size: elementSize(element) };
}

function inlinePlainText(element: RichTextInline): string {
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

function elementSize(element: RichTextElement): number {
  if (element.type === "rich_text_list") return element.elements.reduce((total, item) => total + elementSize(item) + 3, 0);
  return element.elements.reduce((total, inlineElement) => total + inlinePlainText(inlineElement).length, 0);
}

export function richElementPlainText(element: RichTextElement): string {
  switch (element.type) {
    case "rich_text_list":
      return element.elements
        .map((item, index) => {
          const indent = "  ".repeat(element.indent ?? 0);
          const marker = element.style === "ordered" ? `${(element.offset ?? 0) + index + 1}. ` : "• ";
          return indent + marker + richElementPlainText(item);
        })
        .join("\n");
    default:
      return element.elements.map(inlinePlainText).join("");
  }
}

function unitPlainText(unit: Unit): string {
  if (unit.kind === "divider") return "—";
  if (unit.kind === "rich") return richElementPlainText(unit.element);
  return unit.block.rows.map((row) => row.map(cellPlainText).join(" | ")).join("\n");
}

function cellPlainText(cell: TableCell): string {
  return cell.type === "raw_text" ? cell.text : cell.elements.map(richElementPlainText).join("");
}

function prependLead(units: Unit[], lead: RichTextInline[]): void {
  const first = units[0];
  if (first?.kind === "rich" && first.element.type === "rich_text_section") {
    first.element.elements = mergeText([...lead, { type: "text", text: "\n" }, ...first.element.elements]);
    first.size = elementSize(first.element);
    return;
  }
  units.unshift(rich(section(mergeText(lead))));
}

/** Split a unit that alone exceeds the message budget. */
function splitUnit(unit: Unit, maxChars: number): Unit[] {
  if (unit.size <= maxChars || unit.kind !== "rich") return [unit];
  const element = unit.element;
  switch (element.type) {
    case "rich_text_preformatted": {
      const text = element.elements.map(inlinePlainText).join("");
      return splitLines(text, maxChars).map((chunk) =>
        rich({ type: "rich_text_preformatted", elements: [{ type: "text", text: chunk }] }),
      );
    }
    case "rich_text_list": {
      const units: Unit[] = [];
      let current: RichTextList = { ...element, elements: [] };
      let size = 0;
      let offset = element.offset ?? 0;
      for (const item of element.elements) {
        const itemSize = elementSize(item) + 3;
        if (current.elements.length > 0 && size + itemSize > maxChars) {
          units.push(rich(current));
          offset += current.elements.length;
          current = { ...element, ...(element.style === "ordered" ? { offset } : {}), elements: [] };
          size = 0;
        }
        if (itemSize > maxChars) {
          const [first, ...rest] = splitInline(item.elements, maxChars - 3);
          current.elements.push(section(first ?? []));
          units.push(rich(current));
          offset += current.elements.length;
          current = { ...element, ...(element.style === "ordered" ? { offset } : {}), elements: [] };
          size = 0;
          for (const chunk of rest) units.push(rich(section(chunk)));
          continue;
        }
        current.elements.push(item);
        size += itemSize;
      }
      if (current.elements.length > 0) units.push(rich(current));
      return units;
    }
    case "rich_text_quote":
      return splitInline(element.elements, maxChars).map((elements) => rich({ type: "rich_text_quote", elements }));
    case "rich_text_section":
      return splitInline(element.elements, maxChars).map((elements) => rich(section(elements)));
  }
}

function splitInline(elements: readonly RichTextInline[], maxChars: number): RichTextInline[][] {
  const chunks: RichTextInline[][] = [];
  let current: RichTextInline[] = [];
  let size = 0;
  const push = (element: RichTextInline, length: number) => {
    if (current.length > 0 && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(element);
    size += length;
  };
  for (const element of elements) {
    const text = inlinePlainText(element);
    if (element.type === "text" && text.length > maxChars) {
      for (const piece of splitText(text, maxChars)) push({ ...element, text: piece }, piece.length);
    } else {
      push(element, text.length);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitLines(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const pieces = line.length > maxChars ? splitText(line, maxChars) : [line];
    for (const piece of pieces) {
      const next = current ? `${current}\n${piece}` : piece;
      if (current && next.length > maxChars) {
        chunks.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Split text at whitespace near the budget, never inside a surrogate pair. */
export function splitText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let end = maxChars;
    const space = rest.lastIndexOf(" ", maxChars);
    const newline = rest.lastIndexOf("\n", maxChars);
    const boundary = Math.max(space, newline);
    if (boundary >= maxChars * 0.6) end = boundary + 1;
    else if (/[\uD800-\uDBFF]/u.test(rest[end - 1] ?? "")) end -= 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function pack(units: readonly Unit[], maxChars: number): SlackMessage[] {
  const messages: SlackMessage[] = [];
  let blocks: KnownBlock[] = [];
  let plain: string[] = [];
  let chars = 0;
  let tableChars = 0;

  const flush = () => {
    if (blocks.length === 0) return;
    messages.push({ text: notificationText(plain.join("\n")), blocks });
    blocks = [];
    plain = [];
    chars = 0;
    tableChars = 0;
  };

  for (const unit of units) {
    // Slack renders one table block per message, so a second table starts a new message.
    const tableOverflow = unit.kind === "table" && (tableChars > 0 || unit.size > TABLE_CHAR_LIMIT);
    if (blocks.length > 0 && (chars + unit.size > maxChars || tableOverflow)) flush();
    const last = blocks.at(-1);
    if (unit.kind === "rich") {
      if (last?.type === "rich_text" && last.elements.length < MAX_ELEMENTS_PER_RICH_TEXT) {
        appendRich(last, unit.element);
      } else {
        if (blocks.length >= MAX_BLOCKS_PER_MESSAGE) flush();
        blocks.push({ type: "rich_text", elements: [unit.element] });
      }
    } else {
      if (blocks.length >= MAX_BLOCKS_PER_MESSAGE) flush();
      blocks.push(unit.kind === "table" ? unit.block : { type: "divider" });
      if (unit.kind === "table") tableChars += unit.size;
    }
    chars += unit.size;
    plain.push(unitPlainText(unit));
  }
  flush();
  return messages;
}

/** Consecutive paragraphs get a blank line between them, as in Markdown. */
function appendRich(block: RichTextBlock, element: RichTextElement): void {
  const previous = block.elements.at(-1);
  if (previous?.type === "rich_text_section" && element.type === "rich_text_section") {
    const tail = previous.elements.at(-1);
    if (tail?.type === "text" && !tail.style) tail.text += "\n";
    else previous.elements.push({ type: "text", text: "\n" });
  }
  block.elements.push(element);
}

const NOTIFICATION_MAX = 2_000;

function notificationText(text: string): string {
  const trimmed = text.trim() || " ";
  return trimmed.length <= NOTIFICATION_MAX ? trimmed : `${trimmed.slice(0, NOTIFICATION_MAX - 1)}…`;
}
