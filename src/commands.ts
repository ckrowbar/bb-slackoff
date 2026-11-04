// Thread control commands typed as a Slack reply.
//
// The grammar is deliberately strict: one line, a leading `!`, no trailing
// prose. Anything else is an instruction or a question answer, so a message
// that merely starts with "!" never becomes a command by accident.
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type ThreadCommand =
  | { kind: "stop" }
  | { kind: "close" }
  | { kind: "compact" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "model"; model: string }
  | { kind: "effort"; level: ReasoningLevel };

const MODEL_ID = /^[A-Za-z0-9][\w.:/-]*$/u;

export function parseThreadCommand(text: string): ThreadCommand | undefined {
  const line = text.trim();
  if (!line.startsWith("!") || /[\r\n]/u.test(line)) return undefined;
  const [keyword = "", ...args] = line.slice(1).split(/\s+/u);
  switch (keyword.toLowerCase()) {
    case "stop":
      return args.length === 0 ? { kind: "stop" } : undefined;
    case "close":
      return args.length === 0 ? { kind: "close" } : undefined;
    case "compact":
      return args.length === 0 ? { kind: "compact" } : undefined;
    case "help":
      return args.length === 0 ? { kind: "help" } : undefined;
    case "status":
      return args.length === 0 ? { kind: "status" } : undefined;
    case "model": {
      const model = args.length === 1 ? args[0] : undefined;
      return model && MODEL_ID.test(model) ? { kind: "model", model } : undefined;
    }
    case "effort": {
      const level = args.length === 1 ? args[0]?.toLowerCase() : undefined;
      return level && (REASONING_LEVELS as readonly string[]).includes(level)
        ? { kind: "effort", level: level as ReasoningLevel }
        : undefined;
    }
    default:
      return undefined;
  }
}

export const COMMAND_HELP = [
  "`!stop` stops the running turn.",
  "`!model <id>` switches the model for the next turn.",
  "`!effort <level>` sets the reasoning effort for the next turn.",
  "`!compact` compacts the conversation.",
  "`!status` refreshes the status card.",
  "`!close` stops mirroring this thread.",
  "Anything else is sent to the agent. Attach files to send them too.",
].join("\n");
