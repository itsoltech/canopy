import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs, waitForProcessStopped } from "@canopy/testing";
import { Schema } from "effect";
import { resolveProfiles } from "../providers/profiles.ts";
import { botSession } from "./session.ts";
import { runClaudeBot } from "./claude.ts";
import { BotHarnessFailure } from "./types.ts";
import { runCodexBot } from "./codex.ts";

const temporary = tempDirs();

for (const provider of [Provider.CODEX, Provider.CLAUDE])
  test(`bot harness applies speed changes to its resumed session; provider=${provider}`, async () => {
    const root = temporary("canopy-bot-tiers-");
    const trace = join(root, "trace.jsonl");
    const name = provider === Provider.CLAUDE ? "claude" : "codex";
    const profile = resolveProfiles([{ id: "native", kind: "native", providers: [name] }])[0]!.resolved!;

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider,
      model: "fixture",
      historyJson: "[]",
      input: "Hello",
      serviceTier: "fast",
    });

    const options = { dataDir: root, sourceHome: root, linkLogin: false };
    const execute = provider === Provider.CLAUDE ? runClaudeBot : runCodexBot;

    for (const serviceTier of ["fast", "default"]) {
      input.serviceTier = serviceTier;
      const session = botSession(input, options);

      if (serviceTier === "default") expect(session.id).not.toBe("");
      await execute({
        input,
        session,
        profile: { ...profile, env: { TIER_TRACE: trace, TIER_BOT_COMPLETE: "1" } },
        executable: join(import.meta.dir, "../providers/fixtures/service-tiers.ts"),
        signal: AbortSignal.timeout(5000),
        clientVersion: "test",
        mcp: { url: "http://127.0.0.1:1", headers: {} },
        record: async () => {},
        noteHarness: async () => {},
        content: async () => ({ text: "Hello", images: [], documents: [] }),
      });
    }

    const records = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(line)));

    if (provider === Provider.CLAUDE) {
      expect(records.filter((row) => row["method"] === "prompt").map((row) => row["fast"])).toEqual([true, false]);
      expect(records.filter((row) => row["method"] === "spawn").at(-1)?.["resume"]).not.toBe("");
    } else {
      expect(records.filter((row) => row["method"] === "thread/resume")).toHaveLength(1);
      expect(records.filter((row) => row["method"] === "turn/start").map((row) => row["params"])).toMatchObject([
        { serviceTier: "fast" },
        { serviceTier: "default" },
      ]);
    }
  }, 15_000);

for (const provider of [Provider.CODEX, Provider.CLAUDE])
  test(`bot rejects a lost fast entitlement before submitting resumed input; provider=${provider}`, async () => {
    const root = temporary("canopy-bot-tier-denied-");
    const trace = join(root, "trace.jsonl");
    const name = provider === Provider.CLAUDE ? "claude" : "codex";
    const profile = resolveProfiles([{ id: "native", kind: "native", providers: [name] }])[0]!.resolved!;

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider,
      model: "fixture",
      historyJson: "[]",
      input: "Hello",
      serviceTier: "fast",
    });

    const options = { dataDir: root, sourceHome: root, linkLogin: false };
    const execute = provider === Provider.CLAUDE ? runClaudeBot : runCodexBot;

    const context = (disabled: boolean) => ({
      input,
      session: botSession(input, options),
      profile: {
        ...profile,
        env: { TIER_TRACE: trace, TIER_BOT_COMPLETE: "1", ...(disabled && { TIER_DISABLED: "extra_usage_disabled" }) },
      },
      executable: join(import.meta.dir, "../providers/fixtures/service-tiers.ts"),
      signal: AbortSignal.timeout(10_000),
      clientVersion: "test",
      mcp: { url: "http://127.0.0.1:1", headers: {} },
      record: async () => {},
      noteHarness: async () => {},
      content: async () => ({ text: "Hello", images: [], documents: [] }),
    });

    await execute(context(false));
    const resumed = context(true);
    expect(resumed.session.id).not.toBe("");
    let failure: Error | undefined;

    try {
      await execute(resumed);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = error;
    }

    expect(failure).toBeInstanceOf(BotHarnessFailure);
    expect(failure).toMatchObject({ code: "SERVICE_TIER_UNAVAILABLE" });

    const records = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(line)));

    const promptMethod = provider === Provider.CLAUDE ? "prompt" : "turn/start";
    expect(records.filter((row) => row["method"] === promptMethod)).toHaveLength(1);
    const pids = new Set(records.map((row) => Schema.decodeUnknownSync(Schema.Number)(row["pid"])));

    for (const pid of pids) await waitForProcessStopped(pid);
  }, 20_000);
