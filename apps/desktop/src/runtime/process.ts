import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Logs } from "./log.ts";

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(check: () => Promise<boolean>, timeout = 60_000, alive: () => boolean = () => true) {
  const end = Date.now() + timeout;

  while (Date.now() < end && alive()) {
    if (await check().catch(() => false)) return;
    await delay(150);
  }

  throw new Error("Service did not become ready; see the desktop logs");
}

export interface ProcessSpec {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  restart?: boolean;
  stopSignal?: NodeJS.Signals;
  stop?: () => Promise<void>;
}

/** Tracks only owned process groups; never uses process-name matching. */
export class Supervisor {
  private stopping = false;
  private children = new Map<string, { child: ChildProcess; closed: Promise<void>; spec: ProcessSpec }>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(
    private readonly logs: Logs,
    private readonly changed: (name: string, running: boolean, failed?: boolean) => void = () => {},
  ) {}
  get pids() {
    return [...this.children.values()].flatMap(({ child }) => (child.pid ? [child.pid] : []));
  }
  alive(name: string) {
    return this.children.has(name) && !this.stopping;
  }
  send(name: string, message: string) {
    const child = this.children.get(name)?.child;

    if (!child?.stdin?.writable) throw new Error("Desktop worker is unavailable");
    child.stdin.write(message + "\n");

    return child.pid;
  }
  start(spec: ProcessSpec, attempts = 0) {
    if (this.stopping) throw new Error("Supervisor is stopping");

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    this.children.set(spec.name, { child, closed, spec });
    const stream = this.logs.stream(spec.name);
    child.stdout?.on("data", stream);
    child.stderr?.on("data", stream);
    child.once("error", (error) => this.logs.write(spec.name, error.message));
    const started = Date.now();
    child.once("spawn", () => this.changed(spec.name, true));
    child.once("exit", () => {
      if (!this.stopping) this.signal(child, "SIGKILL");
    });
    child.once("close", (code) => {
      // Provider grandchildren can outlive a crashed worker; clean up its process group as well.
      this.signal(child, "SIGKILL");
      this.children.delete(spec.name);
      this.changed(spec.name, false);

      if (!this.stopping && spec.restart && code !== 78) {
        const count = Date.now() - started > 60_000 ? 0 : attempts + 1;

        if (count > 8) {
          this.logs.write(spec.name, "Restart budget exhausted; reopen desktop settings to retry");
          this.changed(spec.name, false, true);

          return;
        }

        const wait = Math.min(30_000, 500 * 2 ** count);
        this.logs.write(spec.name, `Process exited (${code}); restarting in ${wait}ms`);

        const timer = setTimeout(() => {
          this.timers.delete(timer);

          if (!this.stopping) this.start(spec, count);
        }, wait);

        this.timers.add(timer);
      } else if (!this.stopping && spec.restart) this.changed(spec.name, false, true);
    });

    return { child, closed };
  }
  private signal(child: ChildProcess, signal: NodeJS.Signals) {
    if (!child.pid) return;

    try {
      if (process.platform === "win32") {
        if (signal === "SIGTERM") child.stdin?.end();
        else spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else process.kill(-child.pid, signal);
    } catch {
      /* Already reaped. */
    }
  }
  killOwned() {
    for (const { child } of this.children.values()) this.signal(child, "SIGKILL");
  }
  restart(name: string) {
    const entry = this.children.get(name);

    if (entry && !this.stopping) this.signal(entry.child, "SIGKILL");
  }
  async stop() {
    this.stopping = true;

    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();

    for (const { child, closed, spec } of [...this.children.values()].reverse()) {
      const timeout = setTimeout(() => this.signal(child, "SIGKILL"), 10_000);

      if (spec.stop) await spec.stop().catch(() => this.signal(child, "SIGTERM"));
      else this.signal(child, spec.stopSignal ?? "SIGTERM");
      await closed;
      clearTimeout(timeout);
      this.signal(child, "SIGKILL");
    }

    this.children.clear();
  }
  async run(spec: ProcessSpec) {
    const { child, closed } = this.start(spec);
    await closed;

    if (child.exitCode !== 0) throw new Error(`${spec.name} failed; see the desktop logs`);
  }
}
