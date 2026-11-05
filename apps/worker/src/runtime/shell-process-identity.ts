import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** A durable PID alone is insufficient: the OS may reuse it before the worker restarts. */
export function shellProcessIdentity(pid: number): string {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];

      return started ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${started}` : "";
    }

    const command =
      process.platform === "win32"
        ? [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
          ]
        : ["ps", "-p", String(pid), "-o", "lstart="];

    const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 2_000, windowsHide: true });

    return result.status === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}
