// App Home and the start/mirror modals.
import { escapeMrkdwn, truncate } from "../format/mrkdwn.ts";
import type { HomeView, KnownBlock, ModalView } from "../slack/types.ts";
import { ACTION, NO_SECTION, VIEW, button, context, option, plain, section, select, statusText, type CardStatus } from "./common.ts";

export const NEW_THREAD_FIELDS = {
  projectBlock: "project",
  projectInput: "project_input",
  sectionBlock: "section",
  sectionInput: "section_input",
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
    const text = `${link}\n${escapeMrkdwn(truncate(statusText(thread.status, thread.activity), 200))} · ${escapeMrkdwn(thread.projectName)}`;
    // A button is an easier target than a link on a phone.
    const open = thread.permalink ? { type: "button" as const, action_id: `${ACTION.link}:${blocks.length}`, text: plain("Open"), url: thread.permalink } : undefined;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(text, 3_000) }, ...(open ? { accessory: open } : {}) });
  }
  return { type: "home", blocks: blocks.slice(0, 100) };
}

/** Shown at once while the real form loads, so Slack's 3-second window to open a form is never missed. */
export function buildLoadingModal(title: string): ModalView {
  return { type: "modal", callback_id: "slackoff_loading", title: plain(title, 24), close: plain("Cancel", 24), blocks: [context("Loading…")] };
}

/**
 * Asks which project a DM-started thread should run in. Buttons need no
 * form, so one tap works on a phone; "Other…" opens the full picker.
 */
export function buildProjectChooser(input: {
  projects: readonly { id: string; name: string }[];
  origin: string;
  more: boolean;
  sections: readonly { id: string; name: string }[];
  sectionId: string | null;
}): { text: string; blocks: KnownBlock[] } {
  const buttons = input.projects.map((project, index) => button(`${ACTION.pickProject}:${index}`, project.name, `${input.origin}|${project.id}`, index === 0 ? "primary" : undefined));
  if (input.more) buttons.push(button(ACTION.newThread, "Other…", input.origin));
  const blocks: KnownBlock[] = [section("Which project should this run in?")];
  const sections = sectionSelect(ACTION.pickSection, input.sections, input.sectionId);
  // Pick the sidebar section first; tapping a project starts the thread.
  if (sections) blocks.push({ type: "actions", block_id: `origin:${input.origin}`, elements: [sections] });
  blocks.push({ type: "actions", elements: buttons.slice(0, 25) });
  blocks.push(context("Set a default project in Slackoff's settings to skip this."));
  return { text: "Which project should this thread run in?", blocks };
}

/** "Section" picker over BB's sidebar sections, with a "No section" choice. */
export function sectionSelect(actionId: string, sections: readonly { id: string; name: string }[], current: string | null) {
  if (sections.length === 0) return undefined;
  return select(actionId, "Section", [option("No section", NO_SECTION), ...sections.map((candidate) => option(candidate.name, candidate.id))], current ?? NO_SECTION);
}

export function buildNewThreadModal(input: {
  projects: readonly { id: string; name: string }[];
  projectId: string | undefined;
  sections?: readonly { id: string; name: string }[];
  sectionId?: string | null;
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
      ...sectionInput(input.sections ?? [], input.sectionId ?? null),
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

function sectionInput(sections: readonly { id: string; name: string }[], current: string | null): KnownBlock[] {
  const element = sectionSelect(NEW_THREAD_FIELDS.sectionInput, sections, current);
  if (!element) return [];
  return [{ type: "input", block_id: NEW_THREAD_FIELDS.sectionBlock, label: plain("Sidebar section"), optional: true, element }];
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
