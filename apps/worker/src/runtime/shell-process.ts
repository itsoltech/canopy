import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { create } from "@bufbuild/protobuf";
import { ShellResultSchema, type ShellResult } from "@canopy/contracts";
import { SHELL_INPUT_OUTPUT_BYTES, SHELL_INPUT_TIMEOUT_MS } from "@canopy/domain";
import { killProcessTree, processGovernor } from "@canopy/process-governor";

export const SHELL_STOPPED_REASON = "Command stopped. Send a new message to run it again.";
const shutdownReason = "Command interrupted by a worker shutdown. Send a new message to run it again.";

/** Bounded head and tail capture, without ever accumulating the omitted middle. */
class ShellOutput {
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #bytes = 0;
  append(chunk: Buffer): void {
    this.#bytes += chunk.length;
    const half = SHELL_INPUT_OUTPUT_BYTES / 2;
    const take = Math.min(half - this.#head.length, chunk.length);

    if (take > 0) this.#head = Buffer.concat([this.#head, chunk.subarray(0, take)]);
    const rest = chunk.subarray(take);
    this.#tail = Buffer.concat([this.#tail, rest.subarray(-half)]).subarray(-half);
  }
  result() {
    const omitted = this.#bytes - this.#head.length - this.#tail.length;

    return {
      output:
        this.#head.toString() +
        (omitted > 0 ? `\n[canopy: ${omitted} output bytes omitted]\n` : "") +
        this.#tail.toString(),
      truncated: omitted > 0,
    };
  }
}

/** Only the device environment, never profile credentials or the gateway's secrets. */
function shellEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CANOPY_")));
}

export function runShellInput(
  command: string,
  cwd: string,
  signal: AbortSignal,
  onSpawn: (pid: number) => void,
  timeoutMs = SHELL_INPUT_TIMEOUT_MS,
): Promise<ShellResult> {
  return processGovernor.run({ kind: "utility" }, () => captureShell(command, cwd, signal, onSpawn, timeoutMs));
}

function captureShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  onSpawn: (pid: number) => void,
  timeoutMs: number,
): Promise<ShellResult> {
  const started = Date.now();
  const result = create(ShellResultSchema, { command, cwd, status: "completed" });

  if (signal.aborted)
    return Promise.resolve(
      create(ShellResultSchema, {
        ...result,
        status: "interrupted",
        reason: signal.reason === "worker_shutdown" ? shutdownReason : SHELL_STOPPED_REASON,
      }),
    );

  return new Promise((resolve) => {
    const shell =
      process.platform === "win32"
        ? process.env["COMSPEC"] || "cmd.exe"
        : process.env["SHELL"] || userInfo().shell || "/bin/sh";

    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-l", "-c", command];

    const child = spawn(shell, args, {
      cwd,
      env: shellEnvironment(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new ShellOutput();
    let killing: Promise<void> | undefined;

    const stop = (status: string, reason: string) => {
      if (killing) return;
      result.status = status;
      result.reason = reason;
      killing = child.pid ? killProcessTree(child.pid) : Promise.resolve();
    };

    const abort = () =>
      stop("interrupted", signal.reason === "worker_shutdown" ? shutdownReason : SHELL_STOPPED_REASON);

    const timer = setTimeout(
      () => stop("failed", "Command timed out. Shorten it, then send a new message."),
      timeoutMs,
    );

    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => output.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.append(chunk));

    if (child.pid) {
      try {
        onSpawn(child.pid);
      } catch {
        stop("failed", "Command could not be recorded. Send a new message to retry.");
      }
    }

    child.once("error", () => {
      result.status = "failed";
      result.reason = "The shell could not start. Check the working directory and shell, then retry.";
    });
    child.once("close", async (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);

      // A command may leave descendants holding pipes. The deadline stays active until close.
      if (child.pid) await killProcessTree(child.pid);
      await killing;
      Object.assign(result, output.result(), { durationMs: BigInt(Date.now() - started) });

      if (code !== null) result.exitCode = code;
      else if (result.status === "completed") {
        result.status = "failed";
        result.reason = "Command ended without an exit code. Send a new message to retry.";
      }

      resolve(result);
    });
  });
}
