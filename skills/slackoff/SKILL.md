---
name: slackoff
description: Mirror a BB thread to the user's Slack with the `bb slackoff` CLI, or check whether Slackoff is connected. Use when the user asks to follow, continue or control a thread from Slack or their phone, or to stop mirroring.
---

# Slackoff

Slackoff mirrors BB threads into the user's Slack direct messages with the
Slackoff app, mainly so they can follow and steer work from their phone. Each
mirrored thread gets one Slack thread with a live status card, the agent's
final reply per turn, and buttons for questions and approvals. Replies in Slack
go back to the agent.

## Commands

| Command | Effect |
| --- | --- |
| `bb slackoff on [--thread <id>]` | Start mirroring. Defaults to the thread running the command. Prints the Slack link. |
| `bb slackoff off [--thread <id>]` | Stop mirroring. The BB thread keeps running. |
| `bb slackoff status [--thread <id>] [--json]` | Show the Slack connection and whether the thread is mirrored. |
| `bb slackoff list [--json]` | List mirrored threads and their status. |
| `bb slackoff test` | Send the user a test message in Slack. |

## Procedure

1. Run `bb slackoff status` first. If Slack is "unconfigured", point the user
   to Slackoff's settings page in BB; never ask for token values in chat. If it
   is "off", the user turned Slackoff off in the sidebar; ask before you
   suggest turning it on.
2. Turn mirroring on only when the user asks. Mirroring posts to their Slack.
3. After `bb slackoff on`, share the Slack link it prints.

## Writing for a mirrored thread

When a thread is mirrored, the user often reads only your final message of
each turn, as a phone notification. Lead with the outcome, keep it short, and
make it self-contained. Markdown renders natively in Slack. Prefer lists to
wide tables, and use the question tool for choices so the user gets buttons.
