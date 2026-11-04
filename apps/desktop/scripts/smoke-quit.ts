import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DesktopRuntime } from "../src/runtime/runtime.ts";

// Opt-in real Electron input/IPC smoke. No gateway, worker, DB or fixed ports.
const directory = mkdtempSync(join(tmpdir(), "canopy-quit-smoke-"));

const runtime = new DesktopRuntime(
  join(directory, "runtime"),
  {
    bun: process.execPath,
    web: resolve(import.meta.dir, "../../web/build/index.js"),
    gateway: "unused",
    worker: "unused",
    postgres: "unused",
  },
  {
    databasePassword: "quit-smoke-fixture",
    secretsKey: "quit-smoke-fixture",
    serviceToken: "quit-smoke-fixture".repeat(3),
  },
);

try {
  const web = await runtime.initialize(false);

  for (const [name, entry] of [
    ["main", "scripts/smoke-quit-main.ts"],
    ["preload", "src/preload.ts"],
  ]) {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "..", entry!)],
      target: "node",
      format: "cjs",
      external: ["electron"],
      outdir: directory,
      naming: `${name}.cjs`,
    });

    if (!result.success) throw new AggregateError(result.logs, "Quit smoke build failed");
  }

  // SAFETY: Under Bun, Electron's npm entry exports the installed executable path, not the Electron runtime API.
  const electron = require("electron") as string;

  const child = Bun.spawn(
    [
      electron,
      ...(process.platform === "linux" ? ["--ozone-platform=headless", "--disable-gpu"] : []),
      join(directory, "main.cjs"),
    ],
    {
      env: { ...process.env, CANOPY_QUIT_SMOKE_DIR: directory, CANOPY_QUIT_SMOKE_WEB: web },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);

  try {
    const code = await child.exited;

    if (code !== 0) throw new Error(`Electron quit smoke failed: exit ${code}, signal ${child.signalCode ?? "none"}`);
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await runtime.stop();
  rmSync(directory, { recursive: true, force: true });
}
