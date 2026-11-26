import { randomUUID } from "expo-crypto";
import type { SkillArtifact, SkillInstallerRequest, SkillInstallerResult } from "@canopy/contracts";
import type { SettingsApi } from "./resource";
import { SkillInstallerOutput } from "./skill-installer-output";

type Phase = "starting" | "running" | "stopping" | "stopped" | "finished" | "failed";

type InstallerRequest = Partial<
  Pick<SkillInstallerRequest, "command" | "input" | "offset" | "cols" | "rows" | "skillPath">
> & {
  action: "start" | "read" | "write" | "cancel" | "collect" | "close";
};

export interface SkillInstallerState {
  phase: Phase;
  output: string;
  truncated: boolean;
  paths: string[];
  writing: boolean;
  collecting: boolean;
  error: string;
}

const requestTimeoutMs = 15_000;
const installerTimeoutMs = 30 * 60_000;
const collectionTimeoutMs = 5 * 60_000;
const terminalRows = 10;
const encoder = new TextEncoder();

export class SkillInstallerSession {
  readonly #id = randomUUID();
  readonly #controller = new AbortController();
  readonly #output = new SkillInstallerOutput(terminalRows);
  #state: SkillInstallerState = {
    phase: "starting",
    output: "",
    truncated: false,
    paths: [],
    writing: false,
    collecting: false,
    error: "",
  };
  #closed = false;
  #deadline = 0;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #poll: ReturnType<typeof setTimeout> | undefined;
  #offset = 0n;
  #readFailures = 0;

  constructor(
    readonly api: SettingsApi,
    readonly workerId: string,
    readonly cols: number,
    readonly onChange: (state: SkillInstallerState) => void,
  ) {}

  async start(command: string) {
    this.#expireAt(Date.now() + installerTimeoutMs);
    this.onChange(this.#state);

    try {
      this.#receive(await this.#request({ action: "start", command, cols: this.cols, rows: terminalRows }));
    } catch {
      this.#fail("Could not start the installer. Check the computer connection and try again.");
    }
  }

  send(value: string): boolean {
    if (this.#expired() || this.#state.phase !== "running" || this.#state.writing) return false;
    const input = encoder.encode(value);

    this.#patch({ writing: true, error: "" });
    void this.#write(input);

    return true;
  }

  async stop() {
    if (this.#expired()) return;
    const phase = this.#state.phase;

    if (phase === "starting") {
      this.#patch({ phase: "stopped" });
      this.dispose();

      return;
    }

    if (phase !== "running") return;
    this.#patch({ phase: "stopping", error: "" });

    try {
      await this.#request({ action: "cancel" });
    } catch {
      if (this.#state.phase === "stopping")
        this.#patch({ phase: "running", error: "Could not confirm that the installer stopped. Check its output." });
    }
  }

  async collect(skillPath: string): Promise<SkillArtifact | undefined> {
    if (this.#expired() || this.#state.collecting || !this.#state.paths.includes(skillPath)) return;
    this.#patch({ collecting: true, error: "" });

    try {
      const { artifact } = await this.#request({ action: "collect", skillPath });

      if (this.#expired()) return;

      if (!artifact?.files.length) {
        this.#fail("The installer closed. Run it again or import the skill folder.");

        return;
      }

      this.dispose();

      return artifact;
    } catch {
      this.#patch({ collecting: false, error: "Could not read this skill folder. Try again or import it manually." });

      return undefined;
    }
  }

  dispose() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timeout);
    clearTimeout(this.#poll);
    this.#controller.abort();

    // Close fences this ID at the worker even if it arrives before start.
    void this.api
      .runSkillInstaller(
        { workerId: this.workerId, installer: { sessionId: this.#id, action: "close" } },
        { timeoutMs: requestTimeoutMs },
      )
      .catch(() => undefined);
  }

  async #write(input: Uint8Array) {
    try {
      await this.#request({ action: "write", input });
      this.#patch({ writing: false });
    } catch {
      this.#patch({
        writing: false,
        ...(this.#state.phase === "running" && {
          error: "Could not confirm that the installer received your answer. Check the prompt before sending it again.",
        }),
      });
    }
  }

  async #read() {
    if (this.#expired()) return;

    try {
      const result = await this.#request({ action: "read", offset: this.#offset });
      this.#readFailures = 0;
      this.#receive(result);
    } catch {
      if (this.#expired()) return;

      this.#readFailures++;

      if (this.#readFailures < 3) this.#scheduleRead(this.#readFailures * 1000);
      else this.#fail("Lost contact with the installer. Check the computer connection and try again.");
    }
  }

  #receive(result: SkillInstallerResult) {
    if (this.#expired()) return;

    if (result.offset < this.#offset || (result.output.length && result.offset === this.#offset)) {
      this.#fail("Could not read the installer output. Run the installer again.");

      return;
    }

    this.#offset = result.offset;

    if (result.output.length || result.outputTruncated || !result.running) {
      const output = this.#output.append(result.output, result.outputTruncated, result.running);
      this.#patch({ output, truncated: this.#output.truncated });
    }

    if (result.running) {
      if (this.#state.phase === "starting") this.#patch({ phase: "running" });
      this.#scheduleRead(result.output.length ? 150 : 400);

      return;
    }

    if (result.exitCode === 0 && !result.reason) {
      this.#patch({ phase: "finished", paths: result.skillPaths, error: "" });

      if (result.skillPaths.length) this.#expireAt(Math.min(this.#deadline, Date.now() + collectionTimeoutMs));
      else this.dispose();
    } else if (this.#state.phase === "stopping") {
      this.#patch({ phase: "stopped", error: "" });
      this.dispose();
    } else {
      this.#fail(
        result.exitCode === undefined
          ? "The installer closed before it finished. Run it again or import the skill folder."
          : `The installer exited with code ${result.exitCode}. Check the output and try again.`,
      );
    }
  }

  #scheduleRead(delay: number) {
    this.#poll = setTimeout(() => void this.#read(), delay);
  }

  #expireAt(deadline: number) {
    this.#deadline = deadline;
    clearTimeout(this.#timeout);
    this.#timeout = setTimeout(() => this.#expired(), Math.max(0, deadline - Date.now()));
  }

  #expired() {
    if (!this.#closed && Date.now() >= this.#deadline)
      this.#fail("The installer expired. Run it again or import the skill folder.");

    return this.#closed;
  }

  async #request(request: InstallerRequest) {
    const result = await this.api.runSkillInstaller(
      { workerId: this.workerId, installer: { sessionId: this.#id, ...request } },
      { signal: this.#controller.signal, timeoutMs: requestTimeoutMs },
    );

    if (result.sessionId !== this.#id) throw new Error("Unexpected installer session");

    return result;
  }

  #patch(patch: Partial<SkillInstallerState>) {
    if (this.#closed) return;
    this.#state = { ...this.#state, ...patch };
    this.onChange(this.#state);
  }

  #fail(error: string) {
    this.#patch({ phase: "failed", paths: [], writing: false, collecting: false, error });
    this.dispose();
  }
}
