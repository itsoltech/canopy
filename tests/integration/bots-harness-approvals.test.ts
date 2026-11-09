import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, PermissionMode } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { BOT_APPROVAL_OPTIONS } from "@canopy/domain/bot-chat";
import { failurePresentation } from "@canopy/domain/failure-presentation";
import { join } from "node:path";
import { botContexts } from "./fixtures/bot-probe.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("platform tools delegate approval to the gateway", () => {
  let f: HarnessBots;
  let projectId = "";
  let workspaceId = "";
  beforeAll(async () => {
    f = await harnessBots();
    const target = await f.thread(Provider.CODEX);
    projectId = target.projectId;
    workspaceId = target.workspaceId;
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  for (const provider of [Provider.CODEX, Provider.CLAUDE, Provider.GROK]) {
    for (const policy of BOT_APPROVAL_OPTIONS) {
      test(`${Provider[provider]} ${policy.value} creates a protected approval card and executes only after approval`, async () => {
        const bot = await f.add(provider, f.workerId, policy.value);
        const name = `Approved ${crypto.randomUUID().slice(0, 8)}`;
        await f.send(bot.id, `PROBE_CONTEXT\nTOOL:create_bot\nARGS:${JSON.stringify({ name })}`);

        const pending = await eventually(
          () => f.read(bot.id),
          (r) => r.approvals.some((a) => a.status === "pending"),
        );

        const card = pending.approvals.find((a) => a.status === "pending")!;
        expect(card.proposedBot?.name).toBe(name);
        expect(card.prompt).toContain(`Ask for approval: ${policy.label}`);
        expect(botContexts(join(f.dir, "bots.jsonl.context")).at(-1)?.instructions).toContain(
          `Canopy Permissions → Ask for approval: ${policy.label}`,
        );
        expect((await f.gw.api.listBots({})).bots.some((b) => b.configuration?.name === name)).toBe(false);
        await f.gw.api.answerBotApproval({ approvalId: card.id, approve: true });
        const completed = await f.settled(bot.id);
        expect(completed.messages.at(-1)).toMatchObject({ failed: false });
        expect(completed.messages.at(-1)?.text).toContain(name);
        expect((await f.gw.api.listBots({})).bots.find((b) => b.configuration?.name === name)?.ownerUserId).toBe(
          f.gw.userId,
        );
      }, 15_000);
    }

    test(`${Provider[provider]} full auto starts a thread without native refusal or a gateway card`, async () => {
      const bot = await f.add(provider, f.workerId, "full_auto");
      const title = `From bot ${crypto.randomUUID().slice(0, 8)}`;
      await f.tool(bot.id, "start_thread", {
        project_id: projectId,
        workspace_id: workspaceId,
        provider: "codex",
        provider_instance: "native",
        model: "fixture-model",
        title,
        prompt: "Work on the requested task",
      });
      const completed = await f.settled(bot.id);
      expect(completed.messages.at(-1)).toMatchObject({ failed: false });
      expect(completed.approvals).toHaveLength(0);
      const thread = (await f.gw.api.listThreads({ projectId })).threads.find((t) => t.title === title);
      expect(thread?.permissionMode).toBe(PermissionMode.FULL_AUTO);
    }, 15_000);
  }

  for (const provider of [Provider.CODEX, Provider.CLAUDE]) {
    test(`${Provider[provider]} native MCP denial becomes an actionable failure even when the harness completes`, async () => {
      const bot = await f.add(provider);
      await f.send(bot.id, "FAIL:MCP_POLICY");
      const completed = await f.settled(bot.id);
      expect(completed.messages.at(-1)).toMatchObject({
        failed: true,
        errorCode: "tool_approval",
        errorSource: "harness",
      });
      expect(completed.approvals).toHaveLength(0);
      expect(completed.messages.at(-1)?.text).not.toContain("never");
      const error = completed.messages.at(-1)!;
      expect(failurePresentation(error.text, error.errorCode, false).explanation).toContain(
        "Update the worker, then retry.",
      );
    });
  }
});
