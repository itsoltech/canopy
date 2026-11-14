import { existsSync } from "node:fs";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { isJsonObject, parseJson } from "@canopy/domain/json";
import { webConnectHost, webListen, webProcessEnv } from "./config.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface EmbeddedWebOptions {
  env: Env;
  log: (message: string) => void;
  /** The executable with the embedded web; defaults to this process's own image. */
  executable?: string;
  version?: string;
  startupTimeoutMs?: number;
}

/**
 * Linux: the running image even after a self-update renamed a new binary over it, so a web restart
 * between staging and the gateway's restart never mixes versions. Elsewhere the installed path.
 */
function ownExecutable(): string {
  return process.platform === "linux" && existsSync("/proc/self/exe") ? "/proc/self/exe" : process.execPath;
}

/**
 * The embedded web BFF as a child of the gateway process (same binary, `web` subcommand). The gateway
 * starts it after its listener and before it confirms startup, so a web that never becomes healthy fails
 * the update and the supervisor's rollback restores both. Later crashes restart it with backoff; stopping
 * the gateway (shutdown, update restart, supervisor handover) stops it first.
 */
export class EmbeddedWebProcess {
  #child: ReturnType<typeof Bun.spawn> | undefined;
  #stopping = false;
  #failures = 0;
  #restart: ReturnType<typeof setTimeout> | undefined;
  readonly url: string;
  constructor(readonly options: EmbeddedWebOptions) {
    const { host, port } = webListen(options.env);
    this.url = `http://${webConnectHost(host)}:${port}`;
  }
  async start(): Promise<void> {
    this.#spawn();

    try {
      await this.#healthy(this.options.startupTimeoutMs ?? 60_000);
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.options.log(`web ${this.#version} listening on ${this.url}`);
  }
  get #version() {
    return this.options.version ?? CANOPY_VERSION;
  }
  #spawn() {
    const child = Bun.spawn([this.options.executable ?? ownExecutable(), "web"], {
      argv0: process.execPath,
      env: { ...webProcessEnv(this.options.env), CANOPY_WEB_PARENT_PID: String(process.pid), CANOPY_SUPERVISED: "" },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });

    this.#child = child;
    void child.exited.then((code) => this.#exited(child, code));
  }
  #exited(child: ReturnType<typeof Bun.spawn>, code: number) {
    if (this.#child !== child || this.#stopping) return;
    this.#child = undefined;
    const delay = Math.min(30_000, 1000 * 2 ** this.#failures++);
    this.options.log(`web exited (${code}); restarting in ${delay / 1000} s`);
    this.#restart = setTimeout(() => {
      this.#restart = undefined;

      if (this.#stopping) return;
      this.#spawn();
      void this.#healthy(60_000).then(
        () => (this.#failures = 0),
        (cause: unknown) => this.options.log(`web restart: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    }, delay);
  }
  /** `/api/health` answers with this build's version (a stale web on the port does not count). */
  async #healthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const child = this.#child;
    let last = "no answer";

    while (Date.now() < deadline) {
      if (!child || child.exitCode !== null || this.#child !== child)
        throw new Error(`The embedded web exited before it became healthy (${child?.exitCode ?? "not running"})`);

      try {
        const response = await fetch(`${this.url}/api/health`, { signal: AbortSignal.timeout(2000) });
        const body = parseJson(await response.text());
        const version = isJsonObject(body) ? body["version"] : undefined;

        if (response.ok && version === this.#version) return;
        last = `HTTP ${response.status}, version ${String(version)}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }

      await Bun.sleep(200);
    }

    throw new Error(`The embedded web did not become healthy on ${this.url}: ${last}`);
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#restart);
    const child = this.#child;
    this.#child = undefined;

    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await child.exited;
    clearTimeout(timer);
  }
}
