// The Block Kit subset Slackoff sends. Kept local so the plugin has no Slack
// SDK dependency; field names follow https://docs.slack.dev/reference/block-kit.

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

export type RichTextInline =
  | { type: "text"; text: string; style?: TextStyle }
  | { type: "link"; url: string; text?: string; style?: TextStyle }
  | { type: "emoji"; name: string }
  | { type: "user"; user_id: string }
  | { type: "channel"; channel_id: string };

export interface RichTextSection {
  type: "rich_text_section";
  elements: RichTextInline[];
}

export interface RichTextList {
  type: "rich_text_list";
  style: "bullet" | "ordered";
  indent?: number;
  offset?: number;
  border?: 0 | 1;
  elements: RichTextSection[];
}

export interface RichTextPreformatted {
  type: "rich_text_preformatted";
  border?: 0 | 1;
  elements: RichTextInline[];
}

export interface RichTextQuote {
  type: "rich_text_quote";
  border?: 0 | 1;
  elements: RichTextInline[];
}

export type RichTextElement = RichTextSection | RichTextList | RichTextPreformatted | RichTextQuote;

export interface RichTextBlock {
  type: "rich_text";
  block_id?: string;
  elements: RichTextElement[];
}

export interface PlainText {
  type: "plain_text";
  text: string;
  emoji?: boolean;
}

export interface MrkdwnText {
  type: "mrkdwn";
  text: string;
  verbatim?: boolean;
}

export type TextObject = PlainText | MrkdwnText;

export type TableCell =
  | { type: "raw_text"; text: string }
  | { type: "rich_text"; elements: RichTextElement[] };

export interface TableBlock {
  type: "table";
  block_id?: string;
  rows: TableCell[][];
  column_settings?: Array<{ align?: "left" | "center" | "right"; is_wrapped?: boolean } | null>;
}

export interface Option {
  text: PlainText;
  value: string;
  description?: PlainText;
  /** Overflow menu options only: open this URL instead of sending an action. */
  url?: string;
}

export interface ConfirmDialog {
  title: PlainText;
  text: TextObject;
  confirm: PlainText;
  deny: PlainText;
  style?: "primary" | "danger";
}

export interface ButtonElement {
  type: "button";
  action_id: string;
  text: PlainText;
  value?: string;
  url?: string;
  style?: "primary" | "danger";
  confirm?: ConfirmDialog;
}

export interface OverflowElement {
  type: "overflow";
  action_id: string;
  options: Option[];
}

export interface StaticSelectElement {
  type: "static_select";
  action_id: string;
  placeholder?: PlainText;
  options: Option[];
  initial_option?: Option;
}

export interface CheckboxesElement {
  type: "checkboxes";
  action_id: string;
  options: Option[];
  initial_options?: Option[];
}

export interface RadioButtonsElement {
  type: "radio_buttons";
  action_id: string;
  options: Option[];
  initial_option?: Option;
}

export interface PlainTextInputElement {
  type: "plain_text_input";
  action_id: string;
  multiline?: boolean;
  placeholder?: PlainText;
  initial_value?: string;
  max_length?: number;
}

export type ActionElement = ButtonElement | StaticSelectElement | CheckboxesElement | OverflowElement;

export type InputElement = PlainTextInputElement | StaticSelectElement | RadioButtonsElement | CheckboxesElement;

export type KnownBlock =
  | RichTextBlock
  | TableBlock
  | { type: "divider"; block_id?: string }
  | { type: "header"; block_id?: string; text: PlainText }
  | {
      type: "section";
      block_id?: string;
      text?: TextObject;
      fields?: TextObject[];
      accessory?: ButtonElement | StaticSelectElement;
    }
  | { type: "context"; block_id?: string; elements: TextObject[] }
  | { type: "actions"; block_id?: string; elements: ActionElement[] }
  | {
      type: "input";
      block_id: string;
      label: PlainText;
      element: InputElement;
      optional?: boolean;
      hint?: PlainText;
      dispatch_action?: boolean;
    };

export interface ModalView {
  type: "modal";
  callback_id: string;
  title: PlainText;
  submit?: PlainText;
  close?: PlainText;
  private_metadata?: string;
  blocks: KnownBlock[];
}

export interface HomeView {
  type: "home";
  blocks: KnownBlock[];
}

/** One Slack message: Block Kit content plus the plain notification text. */
export interface SlackMessage {
  text: string;
  blocks: KnownBlock[];
}
