/**
 * Temporary directories of tests: every one is removed when the scope that created it ends (afterAll of that file
 * or describe), and whatever is left at the end of the run (preload.ts: a skipped describe, whose body bun runs but
 * whose afterAll it does not, a failed hook) or on a signal. /tmp is a tmpfs with a limited number of inodes shared
 * by every run on the machine: a leaked directory per run fills it.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = new Set<string>();
let hooked = false;

function remove(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  live.delete(dir);
}

/** Every directory still there (the end of a run: describes that bun skipped never run their afterAll). */
export function removeTempDirs(): void {
  for (const dir of [...live]) {
    try {
      remove(dir);
    } catch {
      // Best effort on the way out.
    }
  }
}

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.once("exit", removeTempDirs);

  // A signal ends the process without "exit" handlers: clean up, then die of the same signal.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      removeTempDirs();
      process.kill(process.pid, signal);
    });
  }
}

function make(prefix: string): string {
  hookExit();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  live.add(dir);

  return dir;
}

/**
 * Registers `cleanup` as the scope's last afterAll: bun runs a scope's afterAll hooks in the order they were
 * registered, and the teardown that stops what writes into the directory (a worker, a journal) is usually
 * registered after the directory was made. A registration deferred to the end of the file's or describe's
 * collection comes after them.
 */
function afterScope(cleanup: () => void): void {
  queueMicrotask(() =>
    afterAll(async () => {
      await childrenExited(CHILD_GRACE_MS);
      cleanup();
    }),
  );
}

/** A harness the test stopped may still be exiting (Claude Code gets ~2 s after stdin closes) and write its files. */
const CHILD_GRACE_MS = 3_000;

async function childrenExited(timeoutMs: number): Promise<void> {
  if (process.platform === "win32") return;
  const deadline = Date.now() + timeoutMs;

  while (
    Bun.spawnSync(["pgrep", "-P", String(process.pid)])
      .stdout.toString()
      .trim() !== "" &&
    Date.now() < deadline
  )
    await Bun.sleep(100);
}

/**
 * A new empty directory `<tmp>/<prefix>XXXXXX`, removed after the file or describe that calls this, once its other
 * afterAll hooks ran (or at the end of the run at the latest). Call it at that level only: bun runs an afterAll registered inside a
 * hook or a test right after it, so a directory made there comes from a `tempDirs()` factory instead.
 */
export function tempDir(prefix: string): string {
  const dir = make(prefix);
  afterScope(() => remove(dir));

  return dir;
}

/**
 * Called at the top of a test file (or in a describe): makes directories anywhere in that scope, hooks and tests
 * included, all removed after the scope's other afterAll hooks (or at the end of the run at the latest).
 */
export function tempDirs(): (prefix: string) => string {
  const made: string[] = [];
  afterScope(() => {
    for (const dir of made.splice(0)) remove(dir);
  });

  return (prefix) => {
    const dir = make(prefix);
    made.push(dir);

    return dir;
  };
}
