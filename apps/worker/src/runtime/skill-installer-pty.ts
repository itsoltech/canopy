import { isAbsolute } from "node:path";
import { killProcessTree } from "@canopy/process-governor";
import { filterInstallerEnv } from "../cli-tools/installer.ts";
import { CommandError } from "./host-types.ts";

const tailBytes = 256 * 1024;
const totalInputBytes = 1024 * 1024;
const flushMs = 500;

class OutputTail {
  readonly #buffer = Buffer.alloc(tailBytes);
  #end = 0n;

  append(chunk: Uint8Array): void {
    const bytes = chunk.subarray(-tailBytes);
    this.#end += BigInt(chunk.length);
    const start = Number((this.#end - BigInt(bytes.length)) % BigInt(tailBytes));
    const first = Math.min(bytes.length, tailBytes - start);
    this.#buffer.set(bytes.subarray(0, first), start);
    this.#buffer.set(bytes.subarray(first), 0);
  }

  read(offset: bigint) {
    const earliest = this.#end > BigInt(tailBytes) ? this.#end - BigInt(tailBytes) : 0n;
    const cursor = offset < earliest ? earliest : offset > this.#end ? this.#end : offset;
    const length = Number(this.#end - cursor);
    const start = Number(cursor % BigInt(tailBytes));
    const first = Math.min(length, tailBytes - start);

    return {
      output: Buffer.concat([this.#buffer.subarray(start, start + first), this.#buffer.subarray(0, length - first)]),
      offset: this.#end,
      outputTruncated: offset < earliest,
    };
  }
}

function terminalSize(value: number, previous: number): number {
  return value > 0 ? Math.min(value, 500) : previous;
}

function installerEnvironment(home: string, source: NodeJS.ProcessEnv) {
  const { env } = filterInstallerEnv(source);

  for (const name of [
    "BASH_ENV",
    "CDPATH",
    "CI",
    "CLAUDE_CONFIG_DIR",
    "DATABASE_URL",
    "ENV",
    "GIT_SSH_COMMAND",
    "GIT_TERMINAL_PROMPT",
    "INIT_CWD",
    "NO_COLOR",
    "OLDPWD",
    "PWD",
  ])
    delete env[name];

  return { ...env, HOME: home, TERM: "xterm-256color" };
}

async function waitForFlush(flushed: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      flushed,
      new Promise<boolean>((resolve) => (timer = setTimeout(resolve, flushMs, false))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class SkillInstallerPty {
  readonly #tail = new OutputTail();
  readonly #process: Bun.Subprocess;
  readonly #terminal: Bun.Terminal;
  readonly done: Promise<void>;
  #cols: number;
  #rows: number;
  #accepted = 0;
  #killing: Promise<void> | undefined;
  exitCode: number | undefined;
  running = true;
  reason = "";

  constructor(command: string, cwd: string, home: string, cols: number, rows: number, source = process.env) {
    const env = installerEnvironment(home, source);
    const shell = source["SHELL"];
    const flushed = Promise.withResolvers<boolean>();
    this.#cols = terminalSize(cols, 80);
    this.#rows = terminalSize(rows, 24);

    // Bun starts a spawn-owned PTY in its own UNIX session and closes the parent's copy of the slave.
    const child = Bun.spawn([shell && isAbsolute(shell) ? shell : "/bin/sh", "-c", command], {
      cwd,
      env,
      terminal: {
        cols: this.#cols,
        rows: this.#rows,
        data: (_terminal, bytes) => this.#tail.append(bytes),
        exit: () => flushed.resolve(true),
      },
    });

    if (!child.terminal) {
      void killProcessTree(child.pid);
      throw new Error("The process did not open a terminal.");
    }

    this.#process = child;
    this.#terminal = child.terminal;
    this.done = this.#finish(flushed.promise);
  }

  read(offset: bigint) {
    return this.#tail.read(offset);
  }

  write(input: Uint8Array): void {
    if (!input.length || !this.running || this.reason || this.#terminal.closed) return;

    // Bun buffers writes when the child stops reading. Cap the cumulative input as well as each request.
    if (this.#accepted + input.length > totalInputBytes)
      throw new CommandError(
        "SKILL_INSTALLER_INPUT_LIMIT",
        "The installer terminal has reached its input limit.",
        false,
      );
    this.#terminal.write(Uint8Array.from(input));
    this.#accepted += input.length;
  }

  resize(cols: number, rows: number): void {
    if (!this.running || this.#terminal.closed) return;
    const width = terminalSize(cols, this.#cols);
    const height = terminalSize(rows, this.#rows);

    if (width === this.#cols && height === this.#rows) return;
    this.#terminal.resize(width, height);
    this.#cols = width;
    this.#rows = height;
  }

  stop(reason: string): void {
    if (!this.running || this.reason) return;
    this.reason = reason;
    void this.#kill();
  }

  #kill(): Promise<void> {
    return (this.#killing ??= killProcessTree(this.#process.pid));
  }

  async #finish(flushed: Promise<boolean>): Promise<void> {
    const exit = await this.#process.exited.catch(() => undefined);

    try {
      // A background child can keep the terminal open after the shell exits.
      const drained = await waitForFlush(flushed);
      await this.#kill();

      if (!drained) await waitForFlush(flushed);

      if (exit !== undefined && this.#process.signalCode === null) this.exitCode = exit;

      if (!this.reason && this.exitCode !== 0)
        this.reason =
          this.exitCode === undefined
            ? "The installer process was interrupted."
            : `The installer exited with code ${this.exitCode}.`;
    } finally {
      this.#terminal.close();
      this.running = false;
    }
  }
}
