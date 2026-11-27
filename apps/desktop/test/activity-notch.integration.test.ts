import { beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempDirs } from "@canopy/testing";
import { buildMacNativeAddon } from "../scripts/mac-native-addon.ts";

const tempDirectory = tempDirs();
const supported = process.platform === "darwin" || process.platform === "win32";
const live = supported && process.env["CANOPY_LIVE"] === "1";

// A cold Intel macOS runner can spend most of a minute starting a freshly downloaded Electron and its helpers.
const launchBudget = 60_000;

// The fixture stops itself 25 s after launching and names the stalled step; this only backs up a hung exit.
const behaviourBudget = 35_000;
const outputGrace = 3_000;

let directory = "";
let electron = "";

beforeAll(
  async () => {
    if (!live) return;

    directory = tempDirectory("canopy-activity-notch-");
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

    // SAFETY: Outside the Electron runtime, the npm entry exports the executable path. It downloads the
    // pinned binary on first use, so this stays out of the Electron budgets.
    electron = require("electron") as string;
  },
  { timeout: 60_000 },
);

const failureLine =
  /^Activity notch (?:(?:timed out|failed) while [a-z ]+|[a-z ]+ expected -?[\d.]+ and got -?[\d.]+)$/;

interface FixtureLine {
  line: string;
  /** Milliseconds after the spawn, to tell a slow launch from a stalled step. */
  at: number;
}

/** Collects the fixture's lines with the time each arrived. */
function readLines(stream: ReadableStream<Uint8Array>, startedAt: number, onLine: (line: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: FixtureLine[] = [];
  let pending = "";

  const accept = (raw: string) => {
    const line = raw.replace(/\r$/, "");
    lines.push({ line, at: Math.round(performance.now() - startedAt) });
    onLine(line);
  };

  const done = (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      pending += decoder.decode(chunk.value, { stream: true });
      const complete = pending.split("\n");
      pending = complete.pop() ?? "";

      for (const line of complete) accept(line);
    }

    if (pending) accept(pending);
  })();

  // Helper processes inherit stdout, so the pipe may outlive a killed Electron for a moment.
  const finish = async () => {
    const cancel = setTimeout(() => void reader.cancel(), outputGrace);
    await done;
    clearTimeout(cancel);

    return lines;
  };

  return { finish };
}

test.skipIf(!live)(
  "activity notch preserves focus, resizes its window, and shows thread and bot identities through isolated IPC",
  async () => {
    const child = Bun.spawn([electron, directory], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    let stalled: string | undefined;

    const deadline = (budget: number, phase: string) =>
      setTimeout(() => {
        stalled = `Electron did not ${phase} within ${budget / 1000} s`;
        child.kill("SIGKILL");
      }, budget);

    let timeout = deadline(launchBudget, "launch");

    const output = readLines(child.stdout, performance.now(), (line) => {
      if (line !== "Activity notch launched") return;
      clearTimeout(timeout);
      timeout = deadline(behaviourBudget, "finish after launching");
    });

    try {
      const code = await child.exited;
      const lines = await output.finish();

      const failure = lines.filter(({ line }) => failureLine.test(line)).map(({ line }) => line);
      const exit = stalled ?? `Electron exited with ${child.signalCode ?? `code ${code}`}`;
      const timeline = lines.map(({ line, at }) => `+${at} ms ${line}`);
      expect(code, [...failure, exit, ...timeline].join("\n")).toBe(0);
    } finally {
      clearTimeout(timeout);
    }
  },
  launchBudget + behaviourBudget + outputGrace + 5_000,
);
