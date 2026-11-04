// Minimal Slack Web API client over fetch. Retries rate-limited calls using
// Slack's Retry-After header and surfaces Slack error codes.

export class SlackApiError extends Error {
  readonly code: string;
  readonly method: string;
  readonly detail: unknown;

  constructor(method: string, code: string, detail?: unknown) {
    super(`Slack ${method} failed: ${code}${formatDetail(detail)}`);
    this.name = "SlackApiError";
    this.code = code;
    this.method = method;
    this.detail = detail;
  }
}

function formatDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const messages = (detail as { response_metadata?: { messages?: unknown } }).response_metadata?.messages;
  return Array.isArray(messages) && messages.length > 0 ? ` (${messages.slice(0, 3).join("; ")})` : "";
}

export interface SlackApiOptions {
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type SlackResponse = Record<string, unknown> & { ok: boolean; error?: string };

export class SlackApi {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: SlackApiOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = options.baseUrl ?? "https://slack.com/api";
    this.#maxRetries = options.maxRetries ?? 3;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async call<T extends SlackResponse = SlackResponse>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#fetch(`${this.#baseUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      if (response.status === 429 && attempt < this.#maxRetries) {
        const seconds = Number.parseInt(response.headers.get("retry-after") ?? "1", 10);
        await this.#sleep(Math.min(Math.max(Number.isFinite(seconds) ? seconds : 1, 1), 60) * 1000);
        continue;
      }
      if (!response.ok) throw new SlackApiError(method, `http_${response.status}`);
      const payload = (await response.json()) as T;
      if (!payload.ok) {
        if (payload.error === "ratelimited" && attempt < this.#maxRetries) {
          await this.#sleep(1000 * (attempt + 1));
          continue;
        }
        throw new SlackApiError(method, payload.error ?? "unknown_error", payload);
      }
      return payload;
    }
  }

  /** GET a private file URL with the bot token. */
  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${this.#token}` },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    // Slack answers an unauthorised file request with its HTML sign-in page.
    if (type.startsWith("text/html")) throw new Error("Slack returned a sign-in page; check the files:read scope");
    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("file is too large");
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array(await response.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("file is too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

/** Slack serves user uploads only from these hosts. */
export function isTrustedSlackFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (url.hostname === "files.slack.com" || url.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}
