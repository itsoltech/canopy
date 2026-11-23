import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { tempDirs } from "@canopy/testing";
import { DesktopRuntime } from "../src/runtime/runtime.ts";

const tempDirectory = tempDirs();

test.skipIf(process.env["CANOPY_LIVE"] !== "1")(
  "desktop renders the startup palette and package version before the gateway connects",
  async () => {
    const directory = tempDirectory("canopy-startup-appearance-");
    const token = randomBytes(32).toString("hex");
    const web = resolve(import.meta.dir, "../../web/build/handler.js");

    const runtime = new DesktopRuntime(
      join(directory, "runtime"),
      { bun: process.execPath, web, gateway: "unused", worker: "unused", postgres: "unused" },
      {
        databasePassword: "startup-fixture",
        runtimeDatabasePassword: "startup-fixture",
        secretsKey: "startup-fixture",
        serviceToken: "startup-fixture".repeat(4),
      },
      undefined,
      undefined,
      token,
    );

    try {
      const origin = await runtime.initialize(false);

      for (const [name, source] of [
        ["main", "./startup-appearance.fixture.ts"],
        ["preload", "../src/preload.ts"],
      ] as const) {
        const result = await Bun.build({
          entrypoints: [resolve(import.meta.dir, source)],
          outdir: directory,
          naming: `${name}.cjs`,
          format: "cjs",
          target: "node",
          external: ["electron"],
        });

        if (!result.success) throw new AggregateError(result.logs, "Could not build Electron fixture");
      }

      // SAFETY: Outside the Electron runtime, its npm entry exports the executable path.
      const electron = require("electron") as string;

      for (const [scheme, system, version] of [
        ["dark", "light", "0.8.0"],
        ["light", "dark", "0.8.0-beta.2"],
        ["system", "dark", "0.8.0-nightly.4"],
        ["system", "light", ""],
      ]) {
        const child = Bun.spawn(
          [
            electron,
            ...(process.platform === "linux" ? ["--ozone-platform=headless", "--disable-gpu"] : []),
            join(directory, "main.cjs"),
          ],
          {
            env: {
              ...process.env,
              CANOPY_TEST_DESKTOP: directory,
              CANOPY_TEST_ORIGIN: origin,
              CANOPY_TEST_APPEARANCE: scheme,
              CANOPY_TEST_SYSTEM_SCHEME: system,
              CANOPY_TEST_DESKTOP_VERSION: version,
            },
            stdin: "pipe",
            stdout: "inherit",
            stderr: "inherit",
          },
        );

        child.stdin.write(token + "\n");
        child.stdin.end();
        const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);

        try {
          expect(await child.exited, `${scheme} scheme on a ${system} system, version ${version || "absent"}`).toBe(0);
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      await runtime.stop();
    }
  },
  40_000,
);
