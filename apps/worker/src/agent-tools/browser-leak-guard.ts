import type { JsonValue } from "@canopy/domain";
import { loginAllowsOrigin } from "@canopy/domain/project-logins";
import { z } from "zod";
import { BrowserCdp } from "./browser-cdp.ts";

/** Values entered from one login, and the websites they may be sent to. */
export interface GuardedLogin {
  name: string;
  values: readonly string[];
  websites: readonly string[];
  /** A one-time code stops mattering once it expires. */
  expiresAt?: number;
}

export interface BlockedRequest {
  login: string;
  origin: string;
}

const attached = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ targetId: z.string(), type: z.string() }),
  waitingForDebugger: z.boolean().optional(),
});

const detached = z.object({ sessionId: z.string() });

const paused = z.object({
  requestId: z.string(),
  request: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    postData: z.string().optional(),
    postDataEntries: z.array(z.object({ bytes: z.string().optional() })).optional(),
  }),
});

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const NETWORK = new Set(["http:", "https:", "ws:", "wss:"]);

// Targets that send requests of their own: each needs interception before a value can be entered.
const NETWORKED = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);
const RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 10_000;
const TARGET_WAIT_MS = 2_000;

interface Connection {
  cdp: BrowserCdp;
  /** Interception state per target ID: the promise settles once Fetch is enabled there. */
  targets: Map<string, { sessionId: string; ready: Promise<boolean> }>;
}

const MAX_JSON_BODY = 1024 * 1024;

/** The strings inside a JSON body, decoded: an encoder may escape a value in any way JSON allows. */
function jsonStrings(body: string): string[] {
  if (!body || body.length > MAX_JSON_BODY || !/^\s*[[{"]/.test(body)) return [];

  try {
    return collectStrings(JSON.parse(body));
  } catch {
    return [];
  }
}

function collectStrings(value: JsonValue, depth = 0): string[] {
  if (depth > 64) return [];
  const text = z.string().safeParse(value);

  if (text.success) return [text.data];
  const list = z.array(z.json()).safeParse(value);

  if (list.success) return list.data.flatMap((item) => collectStrings(item, depth + 1));
  const object = z.record(z.string(), z.json()).safeParse(value);

  return object.success
    ? Object.entries(object.data).flatMap(([key, item]) => [key, ...collectStrings(item, depth + 1)])
    : [];
}

/**
 * Blocks requests that carry an entered login's value to a website outside that login's list, for every page,
 * frame and worker of this browser session. Requests without such a value pass untouched. If the connection
 * drops, Chrome resumes paused requests and the guard reconnects while it still protects values.
 */
export class BrowserLeakGuard {
  // Every value stays guarded for the browser session: a page can hold an old password after a newer one.
  readonly #logins: GuardedLogin[] = [];
  readonly #blocked: BlockedRequest[] = [];
  #connection: Promise<Connection | undefined> | undefined;
  #closed = false;
  #reconnecting = false;

  constructor(private readonly endpoint: (signal: AbortSignal) => Promise<string | undefined>) {}

  /**
   * Add values, then make sure interception runs on `targets` (the page and frame where they go). False if the
   * guard cannot protect them: the caller must not enter the values then.
   */
  async protect(login: GuardedLogin, targets: readonly string[], signal: AbortSignal): Promise<boolean> {
    this.#add(login);
    const connection = await this.#connect(signal);

    if (!connection) return false;
    const ready = await Promise.all(targets.map((id) => this.#targetReady(connection, id, signal)));

    return ready.every(Boolean);
  }

  /** A target reaches the guard as an auto-attach event, shortly after it appears in Chrome. */
  async #targetReady(connection: Connection, id: string, signal: AbortSignal): Promise<boolean> {
    for (let waited = 0; waited < TARGET_WAIT_MS; waited += 50) {
      const target = connection.targets.get(id);

      if (target) return target.ready;

      if (signal.aborted || this.#connection === undefined) return false;
      await Bun.sleep(50);
    }

    return false;
  }

  /** Blocked requests not yet reported to the agent. */
  takeBlocked(): BlockedRequest[] {
    return this.#blocked.splice(0);
  }

  get values(): string[] {
    return this.#live().flatMap((login) => login.values);
  }

  close(): void {
    this.#closed = true;
    void this.#connection?.then((connection) => connection?.cdp.close());
    this.#connection = undefined;
  }

  #add(login: GuardedLogin): void {
    const known = this.#logins.find(
      (entry) =>
        entry.name === login.name &&
        entry.websites.join("\n") === login.websites.join("\n") &&
        login.values.every((value) => entry.values.includes(value)),
    );

    if (known && !login.expiresAt) return;
    this.#logins.push(login);
  }

  #live(): GuardedLogin[] {
    const now = Date.now();

    for (let index = this.#logins.length - 1; index >= 0; index--)
      if ((this.#logins[index]!.expiresAt ?? Infinity) <= now) this.#logins.splice(index, 1);

    return this.#logins;
  }

  #connect(signal: AbortSignal): Promise<Connection | undefined> {
    this.#connection ??= this.#open(signal).catch(() => undefined);

    return this.#connection.then((connection) => {
      if (connection) return connection;
      this.#connection = undefined;

      return undefined;
    });
  }

  async #open(signal: AbortSignal): Promise<Connection | undefined> {
    const url = await this.endpoint(signal);

    if (!url) return;
    const cdp = await BrowserCdp.connect(url, signal, MAX_MESSAGE_BYTES);
    const connection: Connection = { cdp, targets: new Map() };
    const current = this.#connection;

    void cdp.closed.then(() => {
      if (this.#connection !== current) return;
      this.#connection = undefined;
      void this.#reconnect();
    });
    cdp.onSessionEvent((method, params, sessionId) => void this.#event(connection, method, params, sessionId));
    await cdp.sendTo(undefined, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    return connection;
  }

  /** Keep guarding values a page may still hold, as long as this session's browser runs. */
  async #reconnect(): Promise<void> {
    if (this.#reconnecting) return;
    this.#reconnecting = true;

    try {
      for (
        let delay = RECONNECT_MS;
        !this.#closed && this.#logins.length;
        delay = Math.min(delay * 2, MAX_RECONNECT_MS)
      ) {
        await Bun.sleep(delay);

        if (this.#closed) return;

        const running = await this.endpoint(AbortSignal.timeout(5_000)).then(
          (url) => Boolean(url),
          () => true,
        );

        // Chrome is gone, and with it every page that held a value.
        if (!running) return;

        // Joins an attempt a fill already started; a failed one leaves the loop running.
        if (await this.#connect(AbortSignal.timeout(5_000))) return;
      }
    } finally {
      this.#reconnecting = false;
    }
  }

  async #event(connection: Connection, method: string, params: JsonValue, sessionId: string | undefined) {
    if (method === "Target.attachedToTarget") return this.#attach(connection, params);

    if (method === "Target.detachedFromTarget") {
      const event = detached.safeParse(params);

      for (const [id, target] of connection.targets)
        if (event.success && target.sessionId === event.data.sessionId) connection.targets.delete(id);

      return;
    }

    if (method !== "Fetch.requestPaused" || !sessionId) return;
    const event = paused.safeParse(params);

    if (!event.success) return;
    const leak = this.#leak(event.data.request);
    const { requestId } = event.data;

    await (
      leak
        ? connection.cdp.sendTo(sessionId, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
        : connection.cdp.sendTo(sessionId, "Fetch.continueRequest", { requestId })
    ).catch(() => undefined);

    if (leak) this.#blocked.push(leak);
  }

  async #attach({ cdp, targets }: Connection, params: JsonValue): Promise<void> {
    const target = attached.safeParse(params);

    if (!target.success) return;
    const { sessionId, targetInfo } = target.data;
    const ready = Promise.withResolvers<boolean>();
    targets.set(targetInfo.targetId, { sessionId, ready: ready.promise });

    try {
      await cdp.sendTo(sessionId, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      await cdp.sendTo(sessionId, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      ready.resolve(true);
    } catch {
      // A target without a network of its own still has to resume; one with a network stays unprotected.
      ready.resolve(!NETWORKED.has(targetInfo.type));
    } finally {
      if (target.data.waitingForDebugger)
        await cdp.sendTo(sessionId, "Runtime.runIfWaitingForDebugger").catch(() => undefined);
    }
  }

  #leak(request: z.infer<typeof paused>["request"]): BlockedRequest | undefined {
    const url = URL.parse(request.url);

    if (!url || !NETWORK.has(url.protocol)) return;
    const origin = `${url.protocol.replace(/^ws/, "http")}//${url.host}`;
    const outside = this.#live().filter((login) => !loginAllowsOrigin(login.websites, origin));

    if (!outside.length) return;

    const body = (request.postDataEntries ?? []).map((entry) =>
      entry.bytes ? Buffer.from(entry.bytes, "base64").toString("utf8") : "",
    );

    const sent = [request.postData ?? "", ...body];

    const haystack = [request.url, ...Object.values(request.headers ?? {}), ...sent, ...sent.flatMap(jsonStrings)].join(
      "\n",
    );

    const login = outside.find((candidate) => candidate.values.some((value) => value && haystack.includes(value)));

    return login && { login: login.name, origin: url.origin === "null" ? origin : url.origin };
  }
}
