import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bots, Provider } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const url = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const key = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["CANOPY_LIVE"] !== "1" || !url || !key || !dockerAvailable)(
  "self-edit through live CLIProxyAPI",
  () => {
    let gw: TestGateway;
    beforeAll(async () => {
      gw = await startTestGateway();
      await useLiveProxy(gw, gw.workerId, {
        url: url!,
        key: key!,
        allowedRoots: ["/repo"],
        harnesses: [Provider.CODEX],
      });
      gw.core.bots.start();
    }, 30_000);
    afterAll(async () => {
      await gw?.core.bots.stop();
      await gw?.close();
    });
    test("a conversational request durably changes the name and standing language, and the next reply follows", async () => {
      const name = `Kropka-${Bun.randomUUIDv7().slice(-6)}`;

      const bot = (
        await gw.api.createBot({
          clientRequestId: Bun.randomUUIDv7(),
          configuration: {
            name: "Live edit bot",
            shape: "round",
            color: "#f97316",
            provider: Provider.CODEX,
            providerInstance: "cliproxyapi",
            model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol",
            effort: "low",
            approvalPolicy: "safe",
          },
        })
      ).bot!;

      const ask = async (text: string) => {
        await gw.core.bots.send(
          create(bots.SendBotMessageRequestSchema, { botId: bot.id, text, clientRequestId: Bun.randomUUIDv7() }),
        );

        return eventually(
          () => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id)),
          (s) => !s.working,
          120_000,
        );
      };

      const edited = await ask(`From now on call yourself ${name} and always answer in English.`);
      expect(edited.bot?.configuration?.name).toBe(name);
      expect(edited.bot?.configuration?.instructions).toMatch(/English/i);
      expect(edited.messages.some((m) => m.settingChanges.some((c) => c.field === "name"))).toBe(true);
      expect(edited.messages.some((m) => m.settingChanges.some((c) => c.field === "instructions"))).toBe(true);
      expect(edited.approvals).toHaveLength(0);
      const next = await ask("Jak się nazywasz? Odpowiedz jednym krótkim zdaniem.");
      const answer = next.messages.at(-1)!;
      expect(answer.failed).toBe(false);
      expect(answer.text).toContain(name);
      expect(answer.text).toMatch(/\b(my|I|name|called)\b/i);
      expect(answer.text).not.toMatch(/nazywam|jestem|imię/i);
      console.info("live self-edit: name and standing language persisted; next reply is in English");
    }, 300_000);
  },
);
