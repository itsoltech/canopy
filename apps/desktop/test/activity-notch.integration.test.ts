import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempDirs } from "@canopy/testing";
import { buildMacNativeAddon } from "../scripts/mac-native-addon.ts";

const tempDirectory = tempDirs();
const supported = process.platform === "darwin" || process.platform === "win32";

test.skipIf(!supported || process.env["CANOPY_LIVE"] !== "1")(
  "activity notch preserves focus, resizes its window, and shows thread and bot identities through isolated IPC",
  async () => {
    const directory = tempDirectory("canopy-activity-notch-");
    const dist = join(directory, "dist");
    await mkdir(join(directory, "profile"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ main: "dist/main.cjs" }));

    if (process.platform === "darwin")
      buildMacNativeAddon(join(directory, "build/native"), "activity-notch-display", "AppKit");

    for (const [name, source] of [
      ["main", "./activity-notch.fixture.ts"],
      ["preload", "../src/preload.ts"],
      ["activity-notch-preload", "../src/activity-notch-preload.ts"],
      ["activity-notch-probe", "./activity-notch-probe.ts"],
    ] as const) {
      const result = await Bun.build({
        entrypoints: [resolve(import.meta.dir, source)],
        outdir: dist,
        naming: `${name}.cjs`,
        format: "cjs",
        target: "node",
        external: ["electron"],
      });

      if (!result.success) throw new Error(`Could not build the ${name} bundle for the activity notch test`);
    }

    // SAFETY: Outside the Electron runtime, the npm entry exports the executable path.
    const electron = require("electron") as string;
    const child = Bun.spawn([electron, directory], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 35_000);

    try {
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);

      const failure = output
        .match(/^Activity notch (?:(?:timed out|failed) while [a-z ]+|[a-z ]+ expected -?[\d.]+ and got -?[\d.]+)$/gm)
        ?.join("\n");

      expect(code, failure ?? `Electron exited with ${child.signalCode ?? `code ${code}`}`).toBe(0);
    } finally {
      clearTimeout(timeout);
    }
  },
  50_000,
);
