import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { startInstanceFixture } from "./support/instance-fixture.ts";

for (const [harness, provider] of [
  ["codex", Provider.CODEX],
  ["claude", Provider.CLAUDE],
  ["grok", Provider.GROK],
] as const) {
  test.skipIf(!dockerAvailable)(
    `${harness} scopes message_delegating_bot to the bot-started thread across worker restart`,
    async () => {
      const f = await startInstanceFixture();

      try {
        await f.save(provider, "delegation");
        const ownerThread = await f.thread(provider);
        const botId = Bun.randomUUIDv7();
        await f.query(
          "INSERT INTO bots (id,owner_user_id,client_request_id,provider,provider_instance,configuration) VALUES ($1::uuid,$2::uuid,$3,'codex','native','{}')",
          [botId, f.gw.userId, botId],
        );

        const delegated = await f.gw.core.createThread(
          create(ui.CreateThreadRequestSchema, {
            projectId: ownerThread.projectId,
            workspaceId: ownerThread.workspaceId,
            provider,
            title: "Delegated task",
          }),
          undefined,
          false,
          { startedByBot: botId },
        );

        const check = async (threadId: string, available: boolean) => {
          const turn = await f.send(threadId, "Check the catalog");
          expect((await f.finished(threadId, turn.id)).status).toBe("completed");
          const tools = f.records().findLast((r) => r.harness === harness && r.event === "turn")?.tools;
          expect(tools?.includes("message_delegating_bot")).toBe(available);
        };

        await check(ownerThread.id, false);
        await check(delegated.id, true);
        await f.restartWorker();
        await check(delegated.id, true);
        await check(ownerThread.id, false);
      } finally {
        await f.close();
      }
    },
    90_000,
  );
}
