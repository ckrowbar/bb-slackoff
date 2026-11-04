// Approval and question cards, and the answer form.
import { escapeMrkdwn, truncate } from "../format/mrkdwn.ts";
import type { ActionElement, KnownBlock, ModalView, SlackMessage } from "../slack/types.ts";
import { ACTION, VIEW, button, context, markdownBlocks, notification, plain, section } from "./common.ts";

export type ApprovalDecision = "allow_once" | "allow_for_session" | "deny";

export interface ApprovalCardInput {
  threadId: string;
  threadTitle: string;
  interactionId: string;
  title: string;
  /** Markdown body: a plan, file scope or tool description. */
  body: string;
  /** Raw command text, shown verbatim. */
  code?: string | undefined;
  reason: string | null;
  decisions: readonly ApprovalDecision[];
  /** Set once resolved: the outcome shown instead of buttons. */
  outcome?: string | undefined;
}

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  allow_once: "Allow",
  allow_for_session: "Allow for session",
  deny: "Deny",
};

/** Longest command shown in full; anything longer must be approved in BB. */
const MAX_APPROVAL_CODE = 2_800;

export function buildApprovalCard(input: ApprovalCardInput): SlackMessage {
  const blocks: KnownBlock[] = [section(`${input.outcome ? "🔐" : "🟡"} *${escapeMrkdwn(truncate(input.title, 200))}*`)];
  let complete = true;
  if (input.code !== undefined) {
    complete = input.code.length <= MAX_APPROVAL_CODE;
    blocks.push({
      type: "rich_text",
      elements: [{ type: "rich_text_preformatted", elements: [{ type: "text", text: truncate(input.code, MAX_APPROVAL_CODE) || " " }] }],
    });
  }
  const body = markdownBlocks(input.body);
  complete &&= body.complete;
  blocks.push(...body.blocks);
  if (input.reason) blocks.push(context(escapeMrkdwn(truncate(input.reason, 1_000))));
  if (input.outcome) {
    blocks.push(context(escapeMrkdwn(input.outcome)));
  } else if (!complete) {
    // Never ask for approval of something the card cannot show in full.
    blocks.push(context("This request is too long to show here. Review it in BB."));
    blocks.push({ type: "actions", elements: [button(ACTION.open, "Show in BB", input.threadId)] });
  } else {
    const elements: ActionElement[] = input.decisions.map((decision) =>
      button(
        `${ACTION.approve}:${decision}`,
        DECISION_LABEL[decision],
        `${input.threadId}|${input.interactionId}|${decision}`,
        decision === "allow_once" ? "primary" : decision === "deny" ? "danger" : undefined,
      ),
    );
    if (elements.length > 0) blocks.push({ type: "actions", elements });
  }
  const summary = input.code ?? input.body;
  return { text: input.outcome ? `${input.title} ${input.outcome}` : notification("🔐", input.threadTitle, `${input.title} ${summary}`), blocks };
}

export interface QuestionInput {
  id: string;
  prompt: string;
  shortLabel?: string | undefined;
  multiSelect: boolean;
  allowFreeText: boolean;
  options: readonly { label: string; description?: string | undefined; value: string }[];
}

export interface QuestionCardInput {
  threadId: string;
  threadTitle: string;
  interactionId: string;
  questions: readonly QuestionInput[];
  outcome?: string | undefined;
}

const MAX_OPTION_BUTTONS = 5;

export function buildQuestionCard(input: QuestionCardInput): SlackMessage {
  const blocks: KnownBlock[] = [section(input.outcome ? "💬 *Question answered*" : "🟡 *The agent has a question*")];
  input.questions.forEach((question, index) => {
    if (input.questions.length > 1) blocks.push(section(`*${index + 1}. ${escapeMrkdwn(truncate(question.shortLabel ?? "Question", 150))}*`));
    blocks.push(...markdownBlocks(question.prompt).blocks);
    if (question.options.length > 0) {
      const lines = question.options.map((choice, optionIndex) => {
        const description = choice.description ? ` — ${escapeMrkdwn(truncate(choice.description, 200))}` : "";
        return `${optionIndex + 1}. *${escapeMrkdwn(truncate(choice.label, 150))}*${description}`;
      });
      blocks.push(section(lines.join("\n")));
    }
  });

  // Leave room for the controls under Slack's 50-block limit.
  blocks.splice(46);
  if (input.outcome) {
    blocks.push(context(escapeMrkdwn(truncate(input.outcome, 2_000))));
    return { text: "Question answered", blocks };
  }

  const reference = `${input.threadId}|${input.interactionId}`;
  const only = input.questions.length === 1 ? input.questions[0] : undefined;
  const elements: ActionElement[] = [];
  if (only && !only.multiSelect && only.options.length > 0 && only.options.length <= MAX_OPTION_BUTTONS) {
    only.options.forEach((choice, optionIndex) => {
      elements.push(button(`${ACTION.answer}:${optionIndex}`, choice.label, `${reference}|0|${optionIndex}`, optionIndex === 0 ? "primary" : undefined));
    });
    if (only.allowFreeText) elements.push(button(ACTION.answerModal, "Other…", reference));
  } else {
    elements.push(button(ACTION.answerModal, "Answer", reference, "primary"));
  }
  blocks.push({ type: "actions", elements });
  if (only && (only.allowFreeText || only.options.length > 0)) blocks.push(context("Or reply here with an option number or your own answer."));
  return { text: notification("❓", input.threadTitle, input.questions[0]?.prompt ?? ""), blocks };
}

export function buildAnswerModal(threadId: string, interactionId: string, questions: readonly QuestionInput[]): ModalView {
  const blocks: KnownBlock[] = [];
  questions.forEach((question, index) => {
    blocks.push(...markdownBlocks(question.prompt).blocks);
    const label = plain(question.shortLabel ?? `Answer ${questions.length > 1 ? index + 1 : ""}`.trim(), 2_000);
    const options = question.options.slice(0, 10).map((choice, optionIndex) => ({
      text: plain(choice.label),
      value: String(optionIndex),
      ...(choice.description ? { description: plain(choice.description) } : {}),
    }));
    if (options.length > 0) {
      blocks.push({
        type: "input",
        block_id: `q${index}`,
        label,
        optional: question.allowFreeText,
        element: question.multiSelect ? { type: "checkboxes", action_id: "choice", options } : { type: "radio_buttons", action_id: "choice", options },
      });
    }
    if (question.allowFreeText || options.length === 0) {
      blocks.push({
        type: "input",
        block_id: `q${index}_text`,
        label: plain(options.length > 0 ? "Or write your own answer" : label.text, 2_000),
        optional: options.length > 0,
        element: { type: "plain_text_input", action_id: "text", multiline: true },
      });
    }
  });
  return {
    type: "modal",
    callback_id: VIEW.answer,
    private_metadata: `${threadId}|${interactionId}`,
    title: plain("Answer the agent", 24),
    submit: plain("Send", 24),
    close: plain("Cancel", 24),
    blocks: blocks.slice(0, 100),
  };
}

export function buildPendingElsewhereCard(threadId: string, threadTitle: string, title: string, outcome?: string): SlackMessage {
  const blocks: KnownBlock[] = [section(`🟡 *${escapeMrkdwn(truncate(title, 200))}* needs your input in BB.`)];
  if (outcome) blocks.push(context(escapeMrkdwn(outcome)));
  else blocks.push({ type: "actions", elements: [button(ACTION.open, "Show in BB", threadId)] });
  return { text: outcome ? title : notification("🟡", threadTitle, `${title} needs your input in BB`), blocks };
}
