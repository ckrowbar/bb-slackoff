// Agent guidance for mirrored threads, added through bb.agents.contributeInstructions.
export const MIRRORED_THREAD_INSTRUCTIONS = [
  "The user follows this thread in Slack, usually on their phone, through the Slackoff plugin.",
  "Slack shows your final message of each turn as a notification, so make it self-contained:",
  "lead with the outcome, then the key details and any decision you need from the user.",
  "Keep it short enough to read on a phone. Markdown renders natively in Slack, including lists, code blocks and tables;",
  "prefer lists to wide tables. Use the question tool for choices so the user gets tappable buttons.",
].join(" ");
