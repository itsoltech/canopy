import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";

const mount = "/sys/fs/cgroup";
const MiB = 1024 * 1024;
let workloads: { path: string; max: number } | undefined;

function memoryLimit(path: string): number {
  // A user slice or container can have less memory than the host. Honor every ancestor ceiling.
  let limit = totalmem();

  for (let dir = path; dir !== mount; dir = dirname(dir)) {
    const max = readFileSync(join(dir, "memory.max"), "utf8").trim();

    if (max !== "max") limit = Math.min(limit, Number(max));
  }

  return limit;
}

function setLimits(path: string, max: number) {
  writeFileSync(join(path, "memory.max"), String(max));

  if (existsSync(join(path, "memory.swap.max")))
    writeFileSync(join(path, "memory.swap.max"), String(Math.floor(max / 4)));
}

/** Only the worker calls this, after systemd has placed it in the delegated service's control leaf. */
export function configureWorkloadMemory(log: (message: string) => void): void {
  if (process.platform !== "linux") return;

  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8").trim();
    const service = /^0::(\/[^\n]+\.service)\/canopy-control$/m.exec(cgroup)?.[1];

    if (!service) {
      if (cgroup.endsWith("/canopy-worker.service"))
        log(
          "Workload memory isolation is inactive. Apply the current worker service unit on a cgroup v2 host with systemd 254 or newer.",
        );

      return;
    }

    const root = join(mount, service);
    writeFileSync(join(root, "cgroup.subtree_control"), "+memory");
    const path = join(root, "canopy-workloads");
    mkdirSync(path, { recursive: true });

    if (!existsSync(join(path, "cgroup.kill"))) throw new Error("cgroup.kill unavailable");
    const available = memoryLimit(root);
    const max = Math.floor(available / 2);
    setLimits(path, Math.floor(available * 0.8));
    writeFileSync(join(path, "cgroup.subtree_control"), "+memory");
    workloads = { path, max };
    log(`Workload memory isolation active (per workload: ${Math.floor(max / MiB)} MiB).`);
  } catch {
    log("Workload memory isolation is inactive. Check cgroup v2 memory delegation for the worker service.");
  }
}

function removeWorkload(path: string): void {
  // cgroup.kill includes descendants that changed process groups or sessions. Delivery is asynchronous.
  writeFileSync(join(path, "cgroup.kill"), "1");

  const remove = () => {
    try {
      rmdirSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EBUSY") setTimeout(remove, 250).unref();
    }
  };

  remove();
}

// Keep the PID, stdin, stdout, stderr, cwd, argv and environment of the original launch. The child joins
// before exec, so even the first fork inherits the budget. Shell source is constant; all values are positional.
const joinThenExec = 'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"';

export function startWorkload<T extends ChildProcess | { exited: Promise<number> }>(
  argv: readonly string[],
  start: (argv: readonly string[]) => T,
  oomTarget: "tree" | "process" = "tree",
): T {
  if (!workloads) return start(argv);
  const path = join(workloads.path, randomUUID());
  mkdirSync(path);

  const cleanup = () => {
    try {
      removeWorkload(path);
    } catch {
      // systemd can remove the entire subtree while the worker is stopping.
    }
  };

  try {
    setLimits(path, workloads.max);
    writeFileSync(join(path, "memory.oom.group"), oomTarget === "tree" ? "1" : "0");
    const child = start(["/bin/sh", "-c", joinThenExec, "canopy-workload", path, ...argv]);

    if ("exited" in child) void child.exited.then(cleanup, cleanup);
    else {
      child.once("exit", cleanup);
      child.once("error", () => {
        if (!child.pid) cleanup();
      });
    }

    return child;
  } catch (error) {
    cleanup();
    throw error;
  }
}
