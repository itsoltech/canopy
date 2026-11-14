import { existsSync } from "node:fs";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { embeddedWebOrigin, webListen, webProcessEnv } from "./config.ts";
import { healthAnswer, listenProblem } from "./probe.ts";
import { WEB_HOSTS_MESSAGE } from "./protocol.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface EmbeddedWebOptions {
  env: Env;
  log: (message: string) => void;
  /** The executable with the embedded web; defaults to this process's own image. */
  executable?: string;
  version?: string;
  startupTimeoutMs?: number;
  /** Host names learned at runtime that the web must accept (Tailscale MagicDNS); sent on start and on hostsChanged. */
  hosts?: () => readonly string[];
  /** The state or its reason changed (Settings → App updates shows it). */
  changed?: () => void;
}

/** `failed`: not serving, with the reason; a retry follows. `stopped`: the gateway is shutting down. */
export type EmbeddedWebState = "starting" | "running" | "failed" | "stopped";

/**
 * Linux: the running image even after a self-update renamed a new binary over it, so a web restart
 * between staging and the gateway's restart never mixes versions. Elsewhere the installed path.
 */
function ownExecutable(): string {
  return process.platform === "linux" && existsSync("/proc/self/exe") ? "/proc/self/exe" : process.execPath;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The embedded web BFF as a child of the gateway process (same binary, `web` subcommand). For an update
 * candidate, start() throws with the reason, so the update rolls back both (gateway.ts). Otherwise a web that
 * can't start (a busy port) leaves the gateway, workers and bots running: the web state is `failed` with a
 * specific reason and it retries with backoff, as after a crash. Stopping the gateway stops it first.
 */
export class EmbeddedWebProcess {
  #child: ReturnType<typeof Bun.spawn> | undefined;
  #instance = "";
  #stopping = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #state: EmbeddedWebState = "starting";
  #reason = "";
  readonly url: string;
  readonly #listen: { host: string; port: number };
  constructor(readonly options: EmbeddedWebOptions) {
    this.#listen = webListen(options.env);
    this.url = embeddedWebOrigin(options.env);
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
      await this.#kill();

      if (candidate) throw error;
      this.#failed(message(error));
      this.#schedule();
    }
  }
  /** The runtime Host names changed: the running child gets the new list. */
  hostsChanged(): void {
    try {
      this.#child?.send({ type: WEB_HOSTS_MESSAGE, hosts: [...(this.options.hosts?.() ?? [])] });
    } catch {
      // A child that is exiting has no IPC; the next one gets the list when it starts.
    }
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
  async #launch(timeoutMs: number): Promise<void> {
    const problem = await listenProblem(this.#listen.host, this.#listen.port);

    if (problem) throw new Error(problem);
    this.#spawn();
    await this.#healthy(timeoutMs);
    this.#failures = 0;
    this.#set("running");
    this.options.log(`web ${this.#version} listening on ${this.url}`);
  }
  #spawn() {
    const instance = crypto.randomUUID();

    const child = Bun.spawn([this.options.executable ?? ownExecutable(), "web"], {
      argv0: process.execPath,
      env: {
        ...webProcessEnv(this.options.env),
        CANOPY_WEB_PARENT_PID: String(process.pid),
        CANOPY_WEB_INSTANCE: instance,
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      serialization: "json",
      ipc() {},
    });

    this.#child = child;
    this.#instance = instance;
    this.hostsChanged();
    void child.exited.then((code) => this.#exited(child, code));
  }
  #exited(child: ReturnType<typeof Bun.spawn>, code: number) {
    if (this.#child !== child || this.#stopping || this.#state !== "running") return;
    this.#child = undefined;
    this.#failed(`It stopped unexpectedly (exit ${code}); restarting.`);
    this.#schedule();
  }
  #schedule() {
    if (this.#stopping) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.#failures++);
    this.options.log(`web: retrying in ${delay / 1000} s`);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;

      if (this.#stopping) return;
      void this.#launch(60_000).catch(async (cause: unknown) => {
        await this.#kill();
        this.#failed(message(cause));
        this.#schedule();
      });
    }, delay);
  }
  /** This child's own `/api/health` (instance header) with this build's version; an older web on the port fails. */
  async #healthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const child = this.#child;
    let last = "no answer";

    while (Date.now() < deadline) {
      if (!child || child.exitCode !== null || this.#child !== child)
        throw new Error(`It exited before it became healthy (exit ${child?.exitCode ?? "unknown"}).`);
      const problem = await healthAnswer(this.url, this.#instance, this.#version);

      if (!problem) return;
      last = problem;
      await Bun.sleep(200);
    }

    throw new Error(`It did not become healthy on ${this.url}: ${last}.`);
  }
  async #kill(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;

    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await child.exited;
    clearTimeout(timer);
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#retry);
    await this.#kill();
    this.#set("stopped");
  }
}
