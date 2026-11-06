import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

/** A killed orphan can remain a zombie until its new parent reaps it. It cannot run code. */
function running(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      // Read once: an exists check races with reaping, including ESRCH during the read itself.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];

      return state !== "Z" && state !== "X";
    }

    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return false;
    throw error;
  }
}

/** Wait for OS signal delivery independently of the parent's stream/turn completion. */
export async function waitForProcessStopped(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Expected an owned positive process id");
  const deadline = performance.now() + 5_000;

  while (running(pid)) {
    if (performance.now() >= deadline) throw new Error(`Owned process ${pid} is still running`);
    await setTimeout(10);
  }
}
