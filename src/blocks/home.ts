// App Home and the start/mirror modals.
import { escapeMrkdwn, truncate } from "../format/mrkdwn.ts";
import type { HomeView, KnownBlock, ModalView } from "../slack/types.ts";
import { ACTION, VIEW, button, context, option, plain, section, statusText, type CardStatus } from "./common.ts";

export const NEW_THREAD_FIELDS = {
  projectBlock: "project",
  projectInput: "project_input",
  promptBlock: "prompt",
  promptInput: "prompt_input",
} as const;

export const MIRROR_FIELDS = { block: "thread", input: "thread_input" } as const;

export interface HomeThread {
  title: string;
  projectName: string;
  status: CardStatus;
  activity?: string | undefined;
  permalink?: string | undefined;
}

export function buildHomeView(input: { threads: readonly HomeThread[]; notice?: string | undefined }): HomeView {
  const blocks: KnownBlock[] = [
    { type: "header", text: plain("Slackoff", 150) },
    section("Send me a message to start a BB thread. Reply in a thread to talk to its agent."),
    {
      type: "actions",
      elements: [button(ACTION.newThread, "New thread", "home", "primary"), button(ACTION.mirrorThread, "Mirror a thread", "home")],
    },
  ];
  if (input.notice) blocks.push(context(escapeMrkdwn(input.notice)));
  blocks.push({ type: "divider" });
  const live = input.threads.filter((thread) => thread.status === "working" || thread.status === "waiting" || thread.status === "starting");
  blocks.push(section(`*Mirrored threads* (${input.threads.length})${live.length > 0 ? ` · ${live.length} active` : ""}`));
  if (input.threads.length === 0) blocks.push(context("No threads are mirrored yet."));
  for (const thread of input.threads.slice(0, 40)) {
    const title = escapeMrkdwn(truncate(thread.title, 150));
    const link = thread.permalink ? `*<${thread.permalink}|${title}>*` : `*${title}*`;
    blocks.push(section(`${link}\n${escapeMrkdwn(truncate(statusText(thread.status, thread.activity), 200))} · ${escapeMrkdwn(thread.projectName)}`));
  }
  return { type: "home", blocks: blocks.slice(0, 100) };
}

export function buildNewThreadModal(input: {
  projects: readonly { id: string; name: string }[];
  projectId: string | undefined;
  prompt?: string;
  /** "channel|ts" of the DM to thread under, when started from a message. */
  origin?: string;
}): ModalView {
  const options = input.projects.slice(0, 100).map((project) => option(project.name, project.id));
  const initial = options.find((candidate) => candidate.value === input.projectId);
  return {
    type: "modal",
    callback_id: VIEW.newThread,
    ...(input.origin ? { private_metadata: input.origin } : {}),
    title: plain("New BB thread", 24),
    submit: plain("Start", 24),
    close: plain("Cancel", 24),
    blocks: [
      {
        type: "input",
        block_id: NEW_THREAD_FIELDS.projectBlock,
        label: plain("Project"),
        element: {
          type: "static_select",
          action_id: NEW_THREAD_FIELDS.projectInput,
          placeholder: plain("Choose a project"),
          options,
          ...(initial ? { initial_option: initial } : {}),
        },
      },
      {
        type: "input",
        block_id: NEW_THREAD_FIELDS.promptBlock,
        label: plain("What should the agent do?"),
        element: {
          type: "plain_text_input",
          action_id: NEW_THREAD_FIELDS.promptInput,
          multiline: true,
          ...(input.prompt ? { initial_value: truncate(input.prompt, 3_000) } : {}),
        },
      },
    ],
  };
}

export function buildMirrorModal(threads: readonly { id: string; title: string; projectName: string }[]): ModalView {
  if (threads.length === 0) {
    return {
      type: "modal",
      callback_id: VIEW.mirror,
      title: plain("Mirror a thread", 24),
      close: plain("Close", 24),
      blocks: [section("Every recent BB thread is already mirrored.")],
    };
  }
  return {
    type: "modal",
    callback_id: VIEW.mirror,
    title: plain("Mirror a thread", 24),
    submit: plain("Mirror", 24),
    close: plain("Cancel", 24),
    blocks: [
      {
        type: "input",
        block_id: MIRROR_FIELDS.block,
        label: plain("BB thread"),
        element: {
          type: "static_select",
          action_id: MIRROR_FIELDS.input,
          placeholder: plain("Choose a thread"),
          options: threads.slice(0, 100).map((thread) => option(`${thread.title} · ${thread.projectName}`, thread.id)),
        },
      },
    ],
  };
}
