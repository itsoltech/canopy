import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { embeddedWebOrigin, isLoopback, webDirectory, webListen, webSettings } from "./config.ts";
import type { EmbeddedWebArchive } from "./embedded.ts";
import { installKind } from "@canopy/updater";
import { containWebFaults } from "./faults.ts";
import { HostAllowlist } from "./hosts.ts";
import { healthAnswer, listen } from "./probe.ts";
import { prepareWebRelease, TOUCH_MS, touchWebRelease } from "./release.ts";
import { previousAssets, webRequestListener, type WebHandler } from "./requests.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface EmbeddedWebOptions {
  archive: EmbeddedWebArchive;
  env: Env;
  log: (message: string) => void;
  version?: string;
  startupTimeoutMs?: number;
  /** Host names learned at runtime that the web must accept (Tailscale MagicDNS); read on start and hostsChanged. */
  hosts?: () => readonly string[];
  /** The state or its reason changed (Settings → App updates shows it). */
  changed?: () => void;
  /** Standalone `canopy-gateway web`: the process is the web, so its faults need no containment. */
  standalone?: boolean;
}

/** `failed`: not serving, with the reason; a retry follows. `stopped`: the gateway is shutting down. */
export type EmbeddedWebState = "starting" | "running" | "failed" | "stopped";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Imports a web module from disk; anything without the expected export is a broken build. */
async function webHandler(directory: string): Promise<WebHandler> {
  const loaded: { handler?: WebHandler } = await import(pathToFileURL(join(directory, "handler.js")).href);

  if (!(loaded.handler instanceof Function)) throw new Error("The embedded web build has no request handler");

  return loaded.handler;
}

/**
 * The embedded web BFF inside the gateway process: adapter-node's handler from the extracted build, behind the
 * request guards (requests.ts), on its own HTTP listener. For an update candidate, start() throws with the
 * reason, so the update rolls back both (gateway.ts). Otherwise a web that can't load or listen (a busy port)
 * leaves the gateway, workers and bots running: the state is `failed` with a specific reason and it retries
 * with backoff. Stopping the gateway closes it first.
 */
export class EmbeddedWebServer {
  #server: Server | undefined;
  #handler: Promise<{ handler: WebHandler; assets: Map<string, string> }> | undefined;
  #hosts: HostAllowlist;
  #stopping = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #touch: ReturnType<typeof setInterval> | undefined;
  #state: EmbeddedWebState = "starting";
  #reason = "";
  readonly url: string;
  readonly #listen: { host: string; port: number };
  constructor(readonly options: EmbeddedWebOptions) {
    this.#listen = webListen(options.env);
    this.url = embeddedWebOrigin(options.env);
    this.#hosts = new HostAllowlist(options.env);
  }
  get state(): EmbeddedWebState {
    return this.#state;
  }
  get reason(): string {
    return this.#reason;
  }
  /** One line for Settings → App updates while the web isn't serving; "" otherwise. */
  get notice(): string {
    return this.#state === "failed" ? `The web app isn't running: ${this.#reason}` : "";
  }
  async start(candidate: boolean): Promise<void> {
    try {
      await this.#launch(this.options.startupTimeoutMs ?? 60_000);
    } catch (error) {
      await this.#close();

      if (candidate) throw error;
      this.#failed(message(error));
      this.#schedule();
    }
  }
  /** The runtime Host names changed (Tailscale). */
  hostsChanged(): void {
    this.#hosts.runtime = this.options.hosts?.() ?? [];
  }
  get #version() {
    return this.options.version ?? CANOPY_VERSION;
  }
  #set(state: EmbeddedWebState, reason = "") {
    if (this.#state === state && this.#reason === reason) return;
    this.#state = state;
    this.#reason = reason;
    this.options.changed?.();
  }
  #failed(reason: string) {
    // Loud once per distinct reason, not on every retry.
    if (this.#reason !== reason) console.error(`web: ${reason}`);
    this.#set("failed", reason);
  }
  /** Extracts and imports the build once per process; a failed import is retried on the next launch. */
  #load() {
    this.#handler ??= (async () => {
      // The web's settings in this process's environment, before adapter-node and SvelteKit read it on import.
      // CANOPY_WEB_IN_PROCESS: the BFF uses the gateway's log writer and ignores CANOPY_WEB_ORIGIN.
      Object.assign(process.env, webSettings(this.options.env), { CANOPY_WEB_IN_PROCESS: "1" });
      const root = webDirectory(this.options.env);
      const release = await prepareWebRelease(this.options.archive, root, this.options.log);

      if (!this.options.standalone) containWebFaults(release.base, this.options.log);
      this.#touch = setInterval(() => void touchWebRelease(release.directory).catch(() => {}), TOUCH_MS);
      this.#touch.unref();

      return {
        handler: await webHandler(release.directory),
        assets: previousAssets(release.directory, release.previous),
      };
    })().catch((cause: unknown) => {
      this.#handler = undefined;
      throw cause;
    });

    return this.#handler;
  }
  async #launch(timeoutMs: number): Promise<void> {
    const { handler, assets } = await this.#load();
    this.hostsChanged();
    const protocolHeader = (process.env["PROTOCOL_HEADER"] ?? "").toLowerCase();
    const log = (line: string) => console.error(line);
    const server = createServer(webRequestListener(handler, { assets, protocolHeader, hosts: this.#hosts, log }));
    await listen(server, this.#listen.host, this.#listen.port);
    this.#server = server;
    server.on("error", (error) => this.#lost(server, error));
    await this.#healthy(timeoutMs);
    this.#failures = 0;
    this.#set("running");

    // In a container the published port is the boundary (`127.0.0.1:3000:3000` in Compose), not the bind address.
    if (!isLoopback(this.#listen.host) && installKind() !== "docker")
      console.warn(
        `web: listening on ${this.#listen.host}:${this.#listen.port}, reachable from other computers. Put a TLS reverse proxy or Tailscale Serve in front of it.`,
      );

    this.options.log(`web ${this.#version} listening on ${this.url}`);
  }
  /** The listener failed while running: serve again after a backoff. */
  #lost(server: Server, error: Error) {
    if (this.#server !== server || this.#stopping) return;
    void this.#close().then(() => {
      this.#failed(`The web listener stopped: ${error.message}; restarting.`);
      this.#schedule();
    });
  }
  #schedule() {
    if (this.#stopping) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.#failures++);
    this.options.log(`web: retrying in ${delay / 1000} s`);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;

      if (this.#stopping) return;
      void this.#launch(60_000).catch(async (cause: unknown) => {
        await this.#close();
        this.#failed(message(cause));
        this.#schedule();
      });
    }, delay);
  }
  /** `/api/health` through the listener answers with this build's version: the handler works, not only the socket. */
  async #healthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "no answer";

    while (Date.now() < deadline) {
      const problem = await healthAnswer(this.url, this.#version);

      if (!problem) return;
      last = problem;
      await Bun.sleep(200);
    }

    throw new Error(`It did not become healthy on ${this.url}: ${last}.`);
  }
  async #close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;

    if (!server?.listening) return;
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeIdleConnections();
    // Open SSE streams would hold close() forever.
    const timer = setTimeout(() => server.closeAllConnections(), 5_000);
    await closed;
    clearTimeout(timer);
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#retry);
    clearInterval(this.#touch);
    await this.#close();
    this.#set("stopped");
  }
}
