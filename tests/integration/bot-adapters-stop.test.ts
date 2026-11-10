import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { join, resolve } from "node:path";
import { runClaudeBot } from "../../apps/worker/src/bots/claude.ts";
import { runCodexBot } from "../../apps/worker/src/bots/codex.ts";
import { runGrokBot } from "../../apps/worker/src/bots/grok.ts";
import { botSession } from "../../apps/worker/src/bots/session.ts";
import type { BotHarnessContext } from "../../apps/worker/src/bots/types.ts";
import { probeRecords } from "./fixtures/instance-probe.ts";

const temp = tempDirs();

for (const [provider, name, run] of [
  [Provider.CLAUDE, "claude", runClaudeBot],
  [Provider.CODEX, "codex", runCodexBot],
  [Provider.GROK, "grok", runGrokBot],
] as const) {
  test(`${name} abort closes a blocked fake harness before resolving`, async () => {
    const dir = temp("canopy-bot-adapter-stop-");
    const trace = join(dir, "probe.jsonl");
    const abort = new AbortController();
    const partial = Promise.withResolvers<void>();

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider,
      profileId: "fixture",
      model: "fixture-model",
      input: "STOP_REPLY HOLD:adapter-stop",
    });

    const context: BotHarnessContext = {
      input,
      session: botSession(input, { dataDir: dir, sourceHome: dir, linkLogin: false }),
      profile: { kind: "native", id: "fixture", providers: [name], env: { INSTANCE_TRACE: trace }, runtime: {} },
      executable: resolve(import.meta.dir, `fixtures/instance-${name}.ts`),
      signal: abort.signal,
      clientVersion: "test",
      mcp: { url: "", headers: {} },
      content: async () => ({ text: input.input, images: [], documents: [] }),
      noteHarness: async () => {},
      record: async (event) => {
        if (event.body?.case === "itemDelta") partial.resolve();
      },
    };

    const done = run(context).catch((error) => partial.reject(error));
    const timer = setTimeout(() => partial.reject(new Error("Harness did not stream a partial reply")), 5000);

    try {
      await partial.promise;
      abort.abort();
      await done;
      const pid = probeRecords(trace).find((r) => r.event === "turn")!.pid;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(probeRecords(trace).some((r) => r.event === "finish")).toBe(false);
      await expect(run(context)).rejects.toThrow();
      expect(probeRecords(trace).filter((r) => r.event === "turn")).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      abort.abort();
      await done;
    }
  }, 10_000);
}
