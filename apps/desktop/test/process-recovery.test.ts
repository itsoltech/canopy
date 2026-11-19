import { expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { Logs } from "../src/runtime/log.ts";
import { Supervisor } from "../src/runtime/process.ts";

const directory = tempDir("canopy-desktop-process-recovery-");

test("the Codex Windows installer receives the OS inherited by Desktop", () => {
  const script = `
    import { serviceEnvironment } from ${JSON.stringify(import.meta.resolve("../src/runtime/config.ts"))};
    import { installEnv } from ${JSON.stringify(import.meta.resolve("../../worker/src/cli-tools/installer.ts"))};

    const { env } = installEnv(serviceEnvironment());
    const command = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "if ($env:OS -ne 'Windows_NT') { exit 1 }"]
      : [process.execPath, "-e", "if (process.env.OS !== 'Windows_NT') process.exit(1)"];
    process.exit(Bun.spawnSync(command, { env, timeout: 5000 }).exitCode ?? 1);
  `;

  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, ...(process.platform !== "win32" && { OS: "Windows_NT" }) },
    stderr: "inherit",
    timeout: 7000,
  });

  expect(result.exitCode).toBe(0);
}, 10_000);

test("a local gateway restarts past the crash budget and recovers quickly after a longer run", async () => {
  jest.useFakeTimers();
  const logs = new Logs(directory);
  const failures: boolean[] = [];
  let closed = Promise.withResolvers<void>();
  let uptime = 0;

  const supervisor = new Supervisor(logs, (_name, running, failed) => {
    if (running) {
      if (uptime) jest.advanceTimersByTime(uptime);
    } else if (failed) failures.push(failed);
    else closed.resolve();
  });

  try {
    supervisor.start({
      name: "gateway",
      command: process.execPath,
      args: ["-e", "process.exit(9)"],
      cwd: directory,
      env: process.env,
      restart: "continuous",
    });

    for (const wait of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]) {
      await closed.promise;
      const log = readFileSync(join(directory, "gateway.log"), "utf8").trimEnd();
      expect(log.split("\n").at(-1)).toEndWith(`restarting in ${wait}ms`);
      closed = Promise.withResolvers<void>();
      jest.advanceTimersByTime(wait);
    }

    await closed.promise;
    closed = Promise.withResolvers<void>();
    uptime = 59_000;
    jest.advanceTimersByTime(30_000);
    await closed.promise;

    const lastExit = readFileSync(join(directory, "gateway.log"), "utf8").trimEnd().split("\n").at(-1);
    expect(lastExit).toMatch(
      /Process exited \(9, PID \d+, uptime 59000ms(?:, Windows status 0x9)?\); restarting in 500ms$/,
    );
    expect(failures).toEqual([]);
  } finally {
    jest.useRealTimers();
    await supervisor.stop();
  }
}, 20_000);

test.skipIf(process.platform !== "win32")("the supervisor logs the full Windows status of its gateway", async () => {
  const logs = new Logs(directory);
  const supervisor = new Supervisor(logs);

  const script = `
    import { dlopen } from "bun:ffi";
    const { symbols } = dlopen("kernel32.dll", {
      ExitProcess: { args: ["u32"], returns: "void" },
    });
    symbols.ExitProcess(0xc0000409);
  `;

  const { closed } = supervisor.start({
    name: "gateway",
    command: process.execPath,
    args: ["-e", script],
    cwd: directory,
    env: process.env,
    restart: "continuous",
  });

  try {
    await closed;
    const lastExit = readFileSync(join(directory, "gateway.log"), "utf8").trimEnd().split("\n").at(-1);
    expect(lastExit).toContain("Windows status 0xc0000409");
  } finally {
    await supervisor.stop();
  }
});
