import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bot tool diagnostics over worker gRPC", () => {
  let f: HarnessBots;
  const logs: string[] = [];
  beforeAll(async () => {
    f = await harnessBots({ log: (message) => logs.push(message) });
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  test("failed sends retain a diagnostic without leaking the destination or message", async () => {
    const bot = await f.add(Provider.CODEX);
    const threadId = crypto.randomUUID();
    const start = logs.length;
    await f.tool(bot.id, "send_message", { thread_id: threadId, text: "private-message-marker" });
    await f.settled(bot.id);
    const diagnostic = logs.slice(start).filter((line) => line.startsWith("bots: tool finished"));
    expect(diagnostic).toEqual(["bots: tool finished source platform operation send_message outcome failed"]);
    expect(diagnostic.join()).not.toContain(threadId);
    expect(diagnostic.join()).not.toContain("private-message-marker");
  });

  test("user rejection stays distinct from a failed platform call", async () => {
    const bot = await f.add(Provider.CLAUDE, f.workerId, "always");
    const target = await f.thread(Provider.CODEX);
    const start = logs.length;
    await f.tool(bot.id, "send_message", { thread_id: target.id, text: "private-declined-message" });

    const pending = await eventually(
      () => f.read(bot.id),
      (value) => value.approvals.some((card) => card.status === "pending"),
    );

    expect(logs.slice(start).some((line) => line.startsWith("bots: tool finished"))).toBe(false);
    await f.gw.api.answerBotApproval({
      approvalId: pending.approvals.find((card) => card.status === "pending")!.id,
      approve: false,
    });
    await f.settled(bot.id);
    expect(logs.slice(start).filter((line) => line.startsWith("bots: tool finished"))).toEqual([
      "bots: tool finished source platform operation send_message outcome discarded",
    ]);
    expect(await f.gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(target.id)))).toHaveLength(0);
  });

  test("a send committed before a dispatch failure is logged as completed", async () => {
    const bot = await f.add(Provider.GROK, f.workerId, "full_auto");
    const target = await f.thread(Provider.CODEX);
    const send = f.gw.core.sendBotThreadMessage.bind(f.gw.core);
    f.gw.core.sendBotThreadMessage = async (...args) => {
      await send(...args);
      throw new Error("private-dispatch-failure");
    };

    const start = logs.length;

    try {
      await f.tool(bot.id, "send_message", { thread_id: target.id, text: "private-accepted-message" });
      await f.settled(bot.id);
      expect(logs.slice(start).filter((line) => line.startsWith("bots: tool finished"))).toEqual([
        "bots: tool finished source platform operation send_message outcome completed",
      ]);
      expect(await f.gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(target.id)))).toHaveLength(1);
    } finally {
      f.gw.core.sendBotThreadMessage = send;
    }
  });
});
