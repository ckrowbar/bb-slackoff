// Everything Slackoff sends to Slack goes through here: posting with a plain
// fallback when Slack rejects rich blocks, a consistent error policy, and the
// native thread status line.
import { toMrkdwnFallback } from "../format/mrkdwn.ts";
import { SlackApiError, type SlackResponse } from "./api.ts";
import type { HomeView, ModalView, SlackMessage } from "./types.ts";

export interface SlackClient {
  call<T extends SlackResponse = SlackResponse>(method: string, body?: Record<string, unknown>): Promise<T>;
  download(url: string, maxBytes: number): Promise<Uint8Array>;
}

export interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Slack failures worth retrying later: the message must not be dropped. */
const RETRYABLE = new Set(["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout", "missing_ts"]);

export function isRetryable(error: unknown): boolean {
  if (!(error instanceof SlackApiError)) return true;
  return RETRYABLE.has(error.code) || /^http_5\d\d$/u.test(error.code) || error.code === "http_429";
}

const BLOCK_ERRORS = new Set(["invalid_blocks", "invalid_blocks_format", "msg_blocks_too_long", "msg_too_long", "invalid_attachments"]);
/** Slack clears a thread status after two minutes; refresh before that. */
const STATUS_REFRESH_MS = 90_000;

export interface Place {
  channel: string;
  threadTs?: string | undefined;
}

export class Outbox {
  readonly slack: SlackClient;
  readonly #log: Log;
  readonly #permalinks = new Map<string, string>();
  readonly #permalinkErrors = new Set<string>();
  readonly #status = new Map<string, { text: string; at: number }>();
  #statusSupported = true;

  constructor(slack: SlackClient, log: Log) {
    this.slack = slack;
    this.#log = log;
  }

  /**
   * Post a message. Returns its ts, or undefined when Slack refused it for a
   * reason a retry cannot fix (logged). Network failures, rate limits and
   * Slack outages throw so the caller can retry later.
   */
  async post(place: Place, message: SlackMessage): Promise<{ channel: string; ts: string } | undefined> {
    try {
      const result = await this.#withFallback(message, (candidate) =>
        this.slack.call<SlackResponse & { channel?: string; ts?: string }>("chat.postMessage", {
          channel: place.channel,
          ...(place.threadTs ? { thread_ts: place.threadTs } : {}),
          text: candidate.text,
          blocks: candidate.blocks,
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
      if (!result.channel || !result.ts) throw new SlackApiError("chat.postMessage", "missing_ts");
      // A reply clears the thread's status line; let the next refresh restore it.
      if (place.threadTs) this.#status.delete(statusKey(result.channel, place.threadTs));
      return { channel: result.channel, ts: result.ts };
    } catch (error) {
      if (isRetryable(error)) throw error;
      this.#log.warn(`dropped a Slack message: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Update a message in place. Updates never notify. */
  async update(channel: string, ts: string, message: SlackMessage): Promise<boolean> {
    try {
      await this.#withFallback(message, (candidate) => this.slack.call("chat.update", { channel, ts, text: candidate.text, blocks: candidate.blocks }));
      return true;
    } catch (error) {
      if (error instanceof SlackApiError) {
        this.#log.warn(`could not update a Slack message: ${error.message}`);
        return false;
      }
      throw error;
    }
  }

  async react(channel: string, ts: string, name: string): Promise<void> {
    await this.slack.call("reactions.add", { channel, timestamp: ts, name }).catch(() => undefined);
  }

  async unreact(channel: string, ts: string, name: string): Promise<void> {
    await this.slack.call("reactions.remove", { channel, timestamp: ts, name }).catch(() => undefined);
  }

  async ephemeral(channel: string, user: string, text: string, threadTs?: string): Promise<void> {
    await this.slack
      .call("chat.postEphemeral", { channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
      .catch((error: unknown) => this.#log.warn(`ephemeral message failed: ${String(error)}`));
  }

  /** Open a modal; returns its view id for later updates. The trigger expires 3 seconds after the tap. */
  async openModal(triggerId: string, view: ModalView): Promise<string | undefined> {
    const result = await this.slack.call<SlackResponse & { view?: { id?: string } }>("views.open", { trigger_id: triggerId, view });
    return result.view?.id;
  }

  async updateModal(viewId: string, view: ModalView): Promise<void> {
    await this.slack.call("views.update", { view_id: viewId, view });
  }

  async publishHome(userId: string, view: HomeView): Promise<void> {
    await this.slack.call("views.publish", { user_id: userId, view });
  }

  async permalink(channel: string, ts: string): Promise<string | undefined> {
    const key = `${channel}:${ts}`;
    const cached = this.#permalinks.get(key);
    if (cached) return cached;
    try {
      const result = await this.slack.call<SlackResponse & { permalink?: string }>("chat.getPermalink", { channel, message_ts: ts });
      if (result.permalink) this.#permalinks.set(key, result.permalink);
      return result.permalink;
    } catch (error) {
      const reason = error instanceof SlackApiError ? error.code : String(error);
      if (!this.#permalinkErrors.has(reason)) {
        this.#permalinkErrors.add(reason);
        this.#log.warn(`could not get a Slack link: ${reason}`);
      }
      return undefined;
    }
  }

  /** A link that opens the thread view, not just its first message. */
  async threadPermalink(channel: string, rootTs: string): Promise<string | undefined> {
    const permalink = await this.permalink(channel, rootTs);
    if (!permalink) return undefined;
    const url = new URL(permalink);
    url.searchParams.set("thread_ts", rootTs);
    url.searchParams.set("cid", channel);
    return url.toString();
  }

  /**
   * Show "Slackoff is …" under the thread, on desktop and mobile. Slack
   * offers this to agent-style apps; when the workspace or app does not
   * support it, the first failure turns it off for this connection.
   */
  async status(channel: string, threadTs: string, text: string, now: number): Promise<void> {
    if (!this.#statusSupported) return;
    const key = statusKey(channel, threadTs);
    const previous = this.#status.get(key);
    if (previous && previous.text === text && now - previous.at < STATUS_REFRESH_MS) return;
    if (!previous && !text) return;
    try {
      await this.slack.call("assistant.threads.setStatus", { channel_id: channel, thread_ts: threadTs, status: text });
      if (text) this.#status.set(key, { text, at: now });
      else this.#status.delete(key);
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "ratelimited") return;
      this.#statusSupported = false;
      this.#log.info(`thread status line unavailable (${String(error)}); continuing without it`);
    }
  }

  async #withFallback<T>(message: SlackMessage, send: (message: SlackMessage) => Promise<T>): Promise<T> {
    try {
      return await send(message);
    } catch (error) {
      if (!(error instanceof SlackApiError) || !BLOCK_ERRORS.has(error.code)) throw error;
      this.#log.warn(`Slack rejected rich blocks (${error.message}); resending with plain formatting`);
      return send(toMrkdwnFallback(message));
    }
  }
}

function statusKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}
