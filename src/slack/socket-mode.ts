// Slack Socket Mode over a WebSocket: connect, acknowledge envelopes, and
// reconnect on refresh requests, drops, or a silent link.
// Protocol: https://docs.slack.dev/apis/events-api/using-socket-mode
import WebSocket from "ws";

export interface SocketEnvelope {
  type: string;
  envelope_id?: string;
  payload?: unknown;
  retry_attempt?: number;
  retry_reason?: string;
  reason?: string;
  accepts_response_payload?: boolean;
}

/** Return a value to send as the acknowledgement payload (for example, modal validation errors). */
export type EnvelopeHandler = (envelope: SocketEnvelope) => unknown;

export interface SocketLike {
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "ping" | "pong", listener: () => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  send(data: string): void;
  ping(): void;
  close(): void;
  terminate(): void;
}

export interface SocketModeOptions {
  /** Calls apps.connections.open and returns the wss URL. */
  openConnection: () => Promise<string>;
  onEnvelope: EnvelopeHandler;
  log: { info(message: string): void; warn(message: string): void };
  onConnectionChange?: (connected: boolean) => void;
  createSocket?: (url: string) => SocketLike;
  /** Close a link that has shown no traffic for this long. */
  idleTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Time a handler may take before the envelope is acknowledged without a payload. */
  ackTimeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const MAX_BACKOFF_MS = 30_000;

export class SocketModeClient {
  readonly #options: SocketModeOptions;

  constructor(options: SocketModeOptions) {
    this.#options = options;
  }

  /** Stay connected until `signal` aborts. Resolves after the last socket closes. */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    const sleep = this.#options.sleep ?? abortableSleep;
    while (!signal.aborted) {
      let greeted = false;
      try {
        const url = await this.#options.openConnection();
        if (signal.aborted) break;
        greeted = await this.#connect(url, signal);
      } catch (error) {
        if (signal.aborted) break;
        this.#options.log.warn(`Slack Socket Mode connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.#options.onConnectionChange?.(false);
      if (signal.aborted) break;
      failures = greeted ? 0 : failures + 1;
      const delay = failures === 0 ? 250 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 5));
      await sleep(delay, signal).catch(() => undefined);
    }
  }

  /** Resolves when the socket closes; true when Slack greeted the connection. */
  #connect(url: string, signal: AbortSignal): Promise<boolean> {
    const create = this.#options.createSocket ?? ((target: string) => new WebSocket(target) as unknown as SocketLike);
    const idleTimeoutMs = this.#options.idleTimeoutMs ?? 75_000;
    const pingIntervalMs = this.#options.pingIntervalMs ?? 30_000;
    const socket = create(url);
    let greeted = false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const pingTimer = setInterval(() => {
        try {
          socket.ping();
        } catch {
          // A failed ping surfaces as a close event.
        }
      }, pingIntervalMs);
      pingTimer.unref?.();

      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(pingTimer);
        clearTimeout(idleTimer);
        signal.removeEventListener("abort", onAbort);
        resolve(greeted);
      };
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          this.#options.log.warn("Slack Socket Mode link went quiet; reconnecting");
          socket.terminate();
          finish();
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };
      const onAbort = () => {
        socket.close();
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      socket.on("open", touch);
      socket.on("ping", touch);
      socket.on("pong", touch);
      socket.on("error", (error) => this.#options.log.warn(`Slack Socket Mode error: ${error.message}`));
      socket.on("close", finish);
      socket.on("message", (data) => {
        touch();
        let envelope: SocketEnvelope;
        try {
          envelope = JSON.parse(typeof data === "string" ? data : String(data)) as SocketEnvelope;
        } catch {
          return;
        }
        if (envelope.type === "hello") {
          greeted = true;
          this.#options.onConnectionChange?.(true);
          return;
        }
        if (envelope.type === "disconnect") {
          // Slack asks clients to reconnect before it rotates the link.
          this.#options.log.info(`Slack Socket Mode refresh requested (${envelope.reason ?? "unknown"})`);
          socket.close();
          finish();
          return;
        }
        if (envelope.envelope_id) void this.#acknowledge(socket, envelope);
      });
    });
  }

  async #acknowledge(socket: SocketLike, envelope: SocketEnvelope): Promise<void> {
    const ackTimeoutMs = this.#options.ackTimeoutMs ?? 2_500;
    let payload: unknown;
    try {
      const result = this.#options.onEnvelope(envelope);
      payload = await Promise.race([
        Promise.resolve(result),
        new Promise((resolve) => setTimeout(() => resolve(undefined), ackTimeoutMs).unref?.()),
      ]);
    } catch (error) {
      this.#options.log.warn(`Slack envelope handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      socket.send(JSON.stringify(payload === undefined ? { envelope_id: envelope.envelope_id } : { envelope_id: envelope.envelope_id, payload }));
    } catch {
      // The socket closed before the acknowledgement; Slack will retry the envelope.
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
