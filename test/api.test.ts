import assert from "node:assert/strict";
import { test } from "node:test";

import { SlackApi, SlackApiError } from "../src/slack/api.ts";

test("calls are form-encoded so every Slack method accepts them", async () => {
  let request: RequestInit | undefined;
  const api = new SlackApi({
    token: "xoxb-test",
    fetch: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ ok: true, permalink: "https://x" }), { headers: { "content-type": "application/json" } });
    },
  });
  await api.call("chat.getPermalink", { channel: "D1", message_ts: "1.2", blocks: [{ type: "divider" }], unfurl_links: false, skipped: undefined });
  const body = request?.body as URLSearchParams;
  assert.ok(body instanceof URLSearchParams);
  assert.equal(body.get("channel"), "D1");
  assert.equal(body.get("blocks"), '[{"type":"divider"}]');
  assert.equal(body.get("unfurl_links"), "false");
  assert.equal(body.has("skipped"), false);
  assert.equal((request?.headers as Record<string, string>).authorization, "Bearer xoxb-test");
});

test("Slack errors and outages surface as typed errors", async () => {
  const api = new SlackApi({ token: "t", maxRetries: 0, fetch: async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" })) });
  await assert.rejects(api.call("chat.postMessage", {}), (error: unknown) => error instanceof SlackApiError && error.code === "channel_not_found");
  const down = new SlackApi({ token: "t", maxRetries: 0, fetch: async () => new Response("", { status: 503 }) });
  await assert.rejects(down.call("chat.postMessage", {}), (error: unknown) => error instanceof SlackApiError && error.code === "http_503");
});
