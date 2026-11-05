# Slackoff for BB

Slackoff is a [BB](https://getbb.app) plugin that lets you follow and steer agent threads from Slack, built mainly for your phone. Each mirrored BB thread gets its own thread in your DMs with the Slackoff app. You see live progress, get one notification when the agent finishes a turn, answer questions and approvals with buttons, and reply to steer the agent.

## In Slack

- **Status card.** The first message of each Slack thread. It shows the title, status, current step, plan, the agent's latest update, project, model and effort. Its controls are Stop, model and effort pickers, and a ⋯ menu with Show in BB, Compact conversation and Stop mirroring. It updates in place, so it never notifies you. Your DM list therefore doubles as a dashboard of everything running.
- **Final replies.** By default, Slackoff posts only the agent's last message of each turn, so you get one notification per turn. The notification starts with the thread's name. Earlier messages appear on the status card as the latest update. Switch **Notify for** to *Every message* to post them all.
- **Native formatting.** Agent Markdown becomes Slack rich text: headings, bold, italics, strikethrough, inline code, links, nested and numbered lists, task lists, quotes, code blocks, tables and dividers. Long replies split at block boundaries. If Slack rejects a rich message, it is resent in plain Slack formatting and keeps its buttons.
- **Questions and approvals.** A question with up to five options shows one button per option. Others open a form. You can also reply with an option number or your own words. Approvals show the command verbatim with Allow, Allow for session and Deny. Anything too long to show in full must be approved in BB.
- **Replying.** Reply in the thread to message the agent. While it works, your reply steers the turn or queues behind it. Slack formatting, including code blocks, lists and links, is converted back to Markdown. Images and files are attached. Voice memos are transcribed with BB's voice service, and Slackoff shows you what it heard.
- **Reactions show progress.** 👀 means the agent has your message, ⏳ means it is queued, and ✅, ⚠️ or ⏹ show how the turn ended.
- **Status line.** While the agent works, Slackoff shows "Slackoff is running …" under the thread where Slack supports it.
- **New threads.** Send the app a direct message with the task. Slackoff starts a BB thread in the default project, or the last one you used. Otherwise it replies with one-tap buttons for your most recent projects. The **Home** tab lists mirrored threads and has New thread and Mirror a thread.
- **Text commands.** Reply `!help` to list them: `!stop`, `!model <id>`, `!effort <level>`, `!compact`, `!status` and `!close`.

## In BB

- **Sidebar footer → Slackoff** (under ⋯ when the footer is full; pin it with Customize footer). Turn Slackoff on or off, see the connection, jump to or stop any mirrored thread, and set the options: mirror new threads automatically, live progress, and notify for final replies or every message.
- **Thread header.** The message icon mirrors the thread; the arrow opens it in Slack.
- **Settings → Slackoff.** Tokens, options and a step-by-step setup guide.
- **Agent guidance.** Agents in mirrored threads are told the user is reading on a phone, so they lead with the outcome and keep final messages short.

## Set up

1. Install the plugin (below), then open **Settings → Slackoff** in BB.
2. Choose **Create app from manifest**. Slack opens with this repository's [`slack-manifest.json`](slack-manifest.json) filled in. Pick your workspace, create the app and install it.
3. Paste three values into the settings form:
   - **Slack bot token**: OAuth & Permissions → Bot User OAuth Token (`xoxb-…`).
   - **Slack app-level token**: Basic Information → App-Level Tokens → generate one with `connections:write` (`xapp-…`).
   - **Your Slack member ID**: your Slack profile → ⋯ → Copy member ID.
4. Slackoff connects on its own. Use **Send test message** to check.

Use a Slack app of its own for Slackoff. Slack spreads events across every Socket Mode connection of an app, so sharing one with another tool loses messages.

## Install

From a clone, which is best while it is changing:

```sh
git clone https://github.com/ckrowbar/bb-slackoff.git
cd bb-slackoff
npm ci
bb plugin install . --yes
```

`bb plugin dev` rebuilds and reloads it on every save. `bb plugin logs slackoff -f` follows its log.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Slackoff on | on | Off pauses every mirror and disconnects from Slack. Cards show ⏸️ Paused. |
| Slack bot token, app-level token, member ID | | Required. Tokens are BB secret settings: files with mode `0600` that never reach the browser. |
| Notify for (`replies`) | `final` | `final`: one message per turn. `every`: each agent message. |
| Live progress (`showActivity`) | on | Steps and plan on the status card. |
| Mirror new threads (`mirrorNewThreads`) | off | Mirror every new visible top-level thread. |
| Project for threads started from Slack | | Otherwise the last project you used. |
| BB web address (`appUrl`) | | Adds Open in BB links. Without it, Show in BB focuses the thread in your open BB window. |

## For agents and scripts

`bb slackoff on|off [--thread <id>]`, `bb slackoff status`, `bb slackoff list` and `bb slackoff test`. The bundled skill in [`skills/slackoff`](skills/slackoff/SKILL.md) explains when to use them.

## How it works

```text
BB server
  └─ Slackoff plugin
       ├─ Slack connection: Socket Mode, an outbound WebSocket (no public URL)
       ├─ BB events: thread lifecycle, event log, pending questions and approvals
       └─ kv store: one binding per mirrored thread (Slack thread, last mirrored event)
```

| Path | Role |
| --- | --- |
| [`server.ts`](server.ts) | Wires settings, the Slack connection, BB events, agent guidance, RPC and the CLI. |
| [`src/bridge.ts`](src/bridge.ts) | Mirrors BB to Slack and routes Slack messages, buttons and forms back. Work for each thread runs in order. |
| [`src/turn.ts`](src/turn.ts) | Pure turn tracking: event rows in, Slack effects out. It decides what is a final reply. |
| [`src/format/`](src/format) | Markdown → Block Kit, and Slack → Markdown. |
| [`src/blocks/`](src/blocks) | Status card, question and approval cards, App Home and modals. |
| [`src/slack/`](src/slack) | Web API client, Socket Mode client with a silent-link watchdog, and the outbox (fallbacks, errors, status line). |
| [`app.tsx`](app.tsx), [`ui/`](ui) | Sidebar panel, thread header toggle and setup guide. |

Restarts and dropped connections catch up from BB's event log without duplicate posts. Slackoff saves the last mirrored event per thread after every post. If a turn is in progress, it replays that turn's events without posting to rebuild the status card and any held final reply.

## Development

```sh
npm ci
npm test
npm run typecheck
bb plugin build
```
