import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJsonString } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bot harness failures through worker gRPC", () => {
  let f: HarnessBots;
  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} retains native codes and shared classes without provider payloads`, async () => {
      for (const [prompt, errorCode] of [
        ["auth", "auth_required"],
        ["model", "model_unavailable"],
        ["usage", "usage_limit"],
        ["proxy", "configuration"],
        ["network", "network"],
        ["stream", "stream_cut_off"],
        ["exit", "process_exit"],
      ] as const) {
        const bot = await f.add(provider);
        const sent = await f.send(bot.id, `FAIL:${prompt}`);
        const result = await f.settled(bot.id);
        expect(result.messages.at(-1)).toMatchObject({ failed: true, errorCode, errorSource: "harness" });
        const row = await f.gw.core.bots.run((s) => s.harnessTurn(sent.turnId));
        expect(row?.error_class).toBe(errorCode);
        expect(row?.error_code).toBe(
          prompt === "exit"
            ? "process_exit"
            : provider === Provider.CLAUDE
              ? prompt === "auth"
                ? "authentication_failed"
                : "error_during_execution"
              : provider === Provider.CODEX
                ? {
                    auth: "httpConnectionFailed:401",
                    model: "modelNotFound",
                    usage: "usageLimitExceeded",
                    proxy: "badRequest",
                    network: "httpConnectionFailed",
                    stream: "responseStreamDisconnected",
                    exit: "processExit",
                  }[prompt]
                : errorCode,
        );

        const controller = new AbortController();

        try {
          for await (const snapshot of f.gw.api.watchBotConversation(
            { botId: bot.id },
            { signal: controller.signal },
          )) {
            expect(snapshot.messages.at(-1)).toMatchObject({
              failed: true,
              errorCode,
              errorSource: "harness",
              text: result.messages.at(-1)?.text,
            });
            const serialized = toJsonString(bots.BotConversationSchema, snapshot);
            expect(serialized).not.toContain("private.invalid");
            expect(serialized).not.toContain("fixture-credential");
            expect(serialized).not.toContain("echoed-private-prompt");
            break;
          }
        } finally {
          controller.abort();
        }

        const preview = (await f.gw.api.listBots({})).bots.find((item) => item.id === bot.id)?.lastMessage;
        expect(preview).toMatchObject({
          failed: true,
          errorCode,
          errorSource: "harness",
          text: result.messages.at(-1)?.text,
        });

        const stored = await f.query<{ reason: string; payload: Uint8Array }>(
          "SELECT h.reason, e.payload FROM bot_harness_turns h JOIN bot_harness_events e ON e.turn_id=h.turn_id WHERE h.turn_id=$1",
          [sent.turnId],
        );

        expect(stored.length).toBeGreaterThan(0);
        const persisted = stored.map((r) => r.reason + new TextDecoder().decode(r.payload)).join("\n");
        expect(persisted).not.toContain("private.invalid");
        expect(persisted).not.toContain("fixture-credential");
        expect(persisted).not.toContain("echoed-private-prompt");
      }
    }, 30_000);

    test(`${Provider[provider]} missing executable is actionable and retry recovers`, async () => {
      const bot = await f.add(provider);
      await f.executable(provider, `${f.dir}/missing-cli`);

      try {
        await f.send(bot.id, "Hello");
        expect((await f.settled(bot.id)).messages.at(-1)).toMatchObject({ errorCode: "cli_missing", failed: true });
      } finally {
        await f.executable(provider, "");
      }

      await f.gw.api.retryBot({ botId: bot.id });
      await eventually(
        () => f.read(bot.id),
        (r) => !r.working && r.messages.at(-1)?.text === "FIXTURE_OK",
      );
    }, 15_000);
  }

  test("a pinned worker missing its instance gives settings guidance without failover", async () => {
    const bot = await f.add(Provider.GROK);
    await f.gw.api.setInstanceWorkers({ harness: Provider.GROK, id: "native", allWorkers: false, workerIds: [] });

    try {
      await f.send(bot.id, "Do not move my login");
      const result = await f.settled(bot.id);
      expect(result.messages.at(-1)).toMatchObject({
        failed: true,
        errorCode: "configuration",
        errorSource: "platform",
      });
      expect(result.messages.at(-1)?.text).toContain("Runs on");
      expect(result.bot?.configuration?.workerId).toBe(f.workerId);
    } finally {
      await f.gw.api.setInstanceWorkers({
        harness: Provider.GROK,
        id: "native",
        allWorkers: false,
        workerIds: [f.workerId],
      });
    }
  });
});
