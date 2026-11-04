// BB pending interactions → Slack cards, and Slack answers → BB resolutions.
import type { PendingInteraction } from "./bb.ts";
import {
  buildApprovalCard,
  buildPendingElsewhereCard,
  buildQuestionCard,
  type ApprovalDecision,
  type QuestionInput,
} from "./blocks/interaction-cards.ts";
import type { SlackMessage } from "./slack/types.ts";
import type { InteractionCard } from "./store.ts";

export type { PendingInteraction };
type Payload = PendingInteraction["payload"];
type ApprovalPayload = Extract<Payload, { kind: "approval" }>;
type QuestionPayload = Extract<Payload, { kind: "user_question" }>;

export type Answers = Record<string, { selected: string[]; freeText?: string }>;

export type Resolution =
  | { decision: "allow_once" | "allow_for_session"; grantedPermissions: unknown }
  | { decision: "deny" }
  | { kind: "user_answer"; answers: Answers };

export function cardKind(interaction: PendingInteraction): InteractionCard["kind"] {
  if (interaction.payload.kind === "approval") return "approval";
  if (interaction.payload.kind === "user_question") return "question";
  return "other";
}

export function questionsOf(interaction: PendingInteraction): QuestionInput[] {
  if (interaction.payload.kind !== "user_question") return [];
  return (interaction.payload as QuestionPayload).questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    shortLabel: question.shortLabel,
    multiSelect: question.multiSelect,
    allowFreeText: question.allowFreeText,
    options: question.options ?? [],
  }));
}

/** Render the card for an interaction; `outcome` marks it resolved. */
export function interactionCard(threadId: string, threadTitle: string, interaction: PendingInteraction, outcome?: string): SlackMessage {
  const payload = interaction.payload;
  if (payload.kind === "approval") {
    const { title, body, code } = describeApproval(payload as ApprovalPayload);
    return buildApprovalCard({
      threadId,
      threadTitle,
      interactionId: interaction.id,
      title,
      body,
      code,
      reason: (payload as ApprovalPayload).reason,
      decisions: (payload as ApprovalPayload).availableDecisions,
      outcome,
    });
  }
  if (payload.kind === "user_question") {
    return buildQuestionCard({ threadId, threadTitle, interactionId: interaction.id, questions: questionsOf(interaction), outcome });
  }
  const title = "title" in payload && typeof payload.title === "string" ? payload.title : "A request";
  return buildPendingElsewhereCard(threadId, threadTitle, title, outcome);
}

export function describeApproval(payload: ApprovalPayload): { title: string; body: string; code?: string } {
  const subject = payload.subject;
  switch (subject.kind) {
    case "command":
      // The command travels as raw preformatted text so nothing in it is read as Markdown.
      return { title: "Approve command?", body: subject.cwd ? `in \`${subject.cwd}\`` : "", code: subject.command };
    case "file_change":
      return { title: "Approve file changes?", body: subject.writeScope ? `Write access to \`${subject.writeScope}\`` : "" };
    case "permission_grant": {
      const lines: string[] = [];
      const fileSystem = subject.permissions.fileSystem;
      if (fileSystem?.read.length) lines.push(`- Read: ${fileSystem.read.map((path) => `\`${path}\``).join(", ")}`);
      if (fileSystem?.write.length) lines.push(`- Write: ${fileSystem.write.map((path) => `\`${path}\``).join(", ")}`);
      if (subject.permissions.network?.enabled) lines.push("- Network access");
      return { title: `Grant permissions${subject.toolName ? ` for ${subject.toolName}` : ""}?`, body: lines.join("\n") };
    }
    case "plan":
      return { title: "Approve plan?", body: subject.plan };
    case "tool_use": {
      const presentation = subject.presentation as { title?: string; detail?: string };
      const detail = [presentation.title, presentation.detail].filter(Boolean).join("\n\n");
      return { title: `Allow ${subject.tool}?`, body: detail };
    }
  }
}

export function approvalResolution(interaction: PendingInteraction, decision: ApprovalDecision): Resolution {
  if (decision === "deny") return { decision };
  // Mirrors BB's own approval UI: a permission request is granted with what it
  // asked for, and a session approval carries the provider's session grant.
  const subject = (interaction.payload as ApprovalPayload).subject;
  if (subject.kind === "permission_grant") {
    const { fileSystem, network } = subject.permissions;
    return {
      decision,
      grantedPermissions: {
        network: network?.enabled === true ? { enabled: true } : null,
        fileSystem: fileSystem ? { read: fileSystem.read, write: fileSystem.write } : null,
      },
    };
  }
  const sessionGrant = decision === "allow_for_session" && (subject.kind === "command" || subject.kind === "file_change") ? subject.sessionGrant : null;
  return { decision, grantedPermissions: sessionGrant };
}

const DECISION_OUTCOME: Record<ApprovalDecision, string> = {
  allow_once: "✓ Allowed",
  allow_for_session: "✓ Allowed for this session",
  deny: "✗ Denied",
};

/** Describe how an interaction ended, from its resolution. */
export function describeOutcome(interaction: PendingInteraction): string {
  if (interaction.status === "interrupted") return `Cancelled${interaction.statusReason ? `: ${interaction.statusReason}` : ""}`;
  const resolution = interaction.resolution as Record<string, unknown> | null;
  if (!resolution) return "Resolved in BB";
  if (typeof resolution.decision === "string" && resolution.decision in DECISION_OUTCOME) {
    return DECISION_OUTCOME[resolution.decision as ApprovalDecision];
  }
  if (resolution.kind === "user_answer" && interaction.payload.kind === "user_question") {
    const answers = resolution.answers as Answers;
    const parts = questionsOf(interaction).map((question) => {
      const answer = answers[question.id];
      if (!answer) return undefined;
      const labels = answer.selected.map((value) => question.options.find((choice) => choice.value === value)?.label ?? value);
      if (answer.freeText) labels.push(`“${answer.freeText}”`);
      return labels.length > 0 ? labels.join(", ") : undefined;
    });
    const text = parts.filter(Boolean).join(" · ");
    return text ? `Answered: ${text}` : "Answered";
  }
  return "Resolved";
}

/** BB accepts at most this many selected choices per question. */
export const MAX_SELECTED = 4;

export type ReplyAnswer = { ok: true; answers: Answers; summary: string } | { ok: false; message: string };

/**
 * Interpret a thread reply as the answer to a single-question interaction:
 * an option number, an option label, or free text when allowed.
 */
export function answerFromReply(interaction: PendingInteraction, reply: string): ReplyAnswer {
  const questions = questionsOf(interaction);
  if (questions.length !== 1) return { ok: false, message: "This question has several parts. Use the *Answer* button." };
  const question = questions[0]!;
  const text = reply.trim();
  const byNumber = /^\d+$/u.test(text) ? question.options[Number.parseInt(text, 10) - 1] : undefined;
  const byLabel = question.options.find((choice) => choice.label.toLowerCase() === text.toLowerCase());
  const multi = question.multiSelect
    ? text
        .split(/[\s,]+/u)
        .filter(Boolean)
        .map((part) => (/^\d+$/u.test(part) ? question.options[Number.parseInt(part, 10) - 1] : undefined))
    : [];
  if (question.multiSelect && multi.length > MAX_SELECTED) return { ok: false, message: `Choose at most ${MAX_SELECTED} options.` };
  if (question.multiSelect && multi.length > 0 && multi.every(Boolean)) {
    const chosen = multi as NonNullable<(typeof multi)[number]>[];
    return { ok: true, answers: { [question.id]: { selected: chosen.map((choice) => choice.value) } }, summary: chosen.map((choice) => choice.label).join(", ") };
  }
  const choice = byNumber ?? byLabel;
  if (choice) return { ok: true, answers: { [question.id]: { selected: [choice.value] } }, summary: choice.label };
  if (question.allowFreeText || question.options.length === 0) {
    return { ok: true, answers: { [question.id]: { selected: [], freeText: text } }, summary: `“${text}”` };
  }
  return { ok: false, message: "Pick one of the options with the buttons, or reply with its number." };
}

/** Answers from the answer modal's submitted state. */
export function answersFromModal(
  questions: readonly QuestionInput[],
  values: Record<string, Record<string, { selected_option?: { value: string } | null; selected_options?: { value: string }[]; value?: string | null }>>,
): { ok: true; answers: Answers } | { ok: false; errors: Record<string, string> } {
  const answers: Answers = {};
  const errors: Record<string, string> = {};
  questions.forEach((question, index) => {
    const choice = values[`q${index}`]?.choice;
    const indexes = choice?.selected_options?.map((selected) => selected.value) ?? (choice?.selected_option ? [choice.selected_option.value] : []);
    const selected = indexes
      .map((raw) => question.options[Number.parseInt(raw, 10)]?.value)
      .filter((value): value is string => typeof value === "string");
    const freeText = values[`q${index}_text`]?.text?.value?.trim() ?? "";
    if (selected.length > MAX_SELECTED) {
      errors[`q${index}`] = `Choose at most ${MAX_SELECTED} options.`;
      return;
    }
    if (selected.length === 0 && !freeText) {
      errors[question.options.length > 0 ? `q${index}` : `q${index}_text`] = "Choose an option or write an answer.";
      return;
    }
    answers[question.id] = { selected, ...(freeText ? { freeText } : {}) };
  });
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answers };
}
