import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const url = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const key = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
describe.skipIf(process.env["OA_LIVE"] !== "1" || !url || !key || !dockerAvailable)("bot routines through live CLIProxyAPI", () => {
  let gw: TestGateway;
  beforeAll(async () => {
    gw = await startTestGateway();
    await useLiveProxy(gw, gw.workerId, { url: url!, key: key!, allowedRoots: ["/repo"], harnesses: [Provider.CODEX] });
    await liveProxyReady(gw, gw.workerId, [Provider.CODEX]);
    gw.core.bots.start();
  }, 60_000);
  afterAll(async () => { await gw?.close(); });
  test("a real bot schedules a conditional check and its healthy run remains silent", async () => {
    const bot = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: {
      name: "Routine live", shape: "round", color: "#22aaff", provider: Provider.CODEX, providerInstance: "cliproxyapi",
      model: process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol", effort: "low", approvalPolicy: "always",
    } })).bot!;
    const read = () => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id));
    await gw.api.sendBotMessage({ botId: bot.id, clientRequestId: Bun.randomUUIDv7(), text:
      "Set up a routine now: every 15 minutes in UTC check X and tell me only if Y. For this task X is this fixed health snapshot: healthy=true, Y=false (no important incident). Put this snapshot in the routine instructions; evaluate it as given, without external tools, threads or other bots. Notify me ONLY if Y=true. If Y=false do nothing visible. Do not ask me for confirmation.",
    });
    const ready = await eventually(read, (s) => !s.working, 120_000);
    expect(ready.routines).toHaveLength(1); expect(ready.approvals).toHaveLength(0);
    const routine = ready.routines[0]!;
    expect(routine.cron).toBe("*/15 * * * *"); expect(routine.timezone).toBe("UTC");
    expect(routine.instructions.toLowerCase()).toContain("false");
    await gw.core.bots.run((s) => s.deliverRoutines(gw.userId, timestampDate(routine.nextRunAt!)));
    await gw.core.bots.tick();
    const turns = await eventually(() => gw.runtime.runPromise(Effect.gen(function* () {
      return yield* (yield* SqlClient.SqlClient)<{ status: string }>`SELECT status FROM bot_turns WHERE routine_id = ${routine.id}::uuid`;
    })), (r) => r.length === 1 && r[0]?.status === "completed", 120_000);
    expect(turns).toHaveLength(1); expect(turns[0]?.status).toBe("completed");
    const after = await read();
    expect(after.messages).toEqual(ready.messages); expect(after.approvals).toHaveLength(0);
    expect(after.routines[0]?.lastOutcome).toBe("Nothing to report");
    expect(after.bot?.lastMessage?.id).toBe(ready.bot?.lastMessage?.id);
  }, 250_000);
});
