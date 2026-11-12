import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, PermissionMode } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { JsonObject } from "@canopy/domain";
import { describeBotTool } from "../../apps/gateway/src/bots/platform.ts";
import { PLATFORM_TOOLS } from "../../apps/gateway/src/bots/policy.ts";
import { ruleOptions } from "../../apps/gateway/src/bots/approval-rules.ts";
import { decode, encode } from "../../apps/web/src/lib/shared/wire.ts";
import { botsSuite, lastInput, reply, tool } from "./support/bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("approval review regressions through the gateway", () => {
  const { suite, add, read, send, settled } = botsSuite();

  const request = (name: string, args: JsonObject) => {
    suite.model = async (i) =>
      i.messages.at(-1)?.role === "tool" || lastInput(i).startsWith("Thread ") ? reply("Done") : tool(name, args);
  };

  const approve = async (botId: string) => {
    const card = (
      await eventually(
        () => read(botId),
        (s) => s.approvals.some((a) => a.status === "pending"),
      )
    ).approvals.find((a) => a.status === "pending")!;

    await suite.gw.api.answerBotApproval({ approvalId: card.id, approve: true });
    await settled(botId);

    return card;
  };

  test("old protobuf and BFF clients preserve the stored thread permission", async () => {
    const bot = await add("Old client", { threadPermission: "read_only" });
    const older = create(bots.BotConfigurationSchema, bot.configuration);
    older.threadPermission = undefined;
    const wire = encode(bots.BotConfigurationSchema, older);
    const configuration = decode(bots.BotConfigurationSchema, wire);
    expect(configuration.threadPermission).toBeUndefined();
    configuration.instructions = "An old client edits instructions";
    const saved = (await suite.gw.api.updateBot({ botId: bot.id, configuration })).bot!;
    expect(saved.configuration?.threadPermission).toBe("read_only");
    expect((await add("New default", { approvalPolicy: "full_auto" })).configuration?.threadPermission).toBe(
      "user_default",
    );

    const error = await suite.gw.api
      .deleteBotApprovalRule({ botId: bot.id, ruleId: "invalid" })
      .catch(ConnectError.from);

    expect(error).toBeInstanceOf(ConnectError);
    expect(error instanceof ConnectError && error.code).toBe(Code.InvalidArgument);
  });

  test("resolved names and fallback ids cannot be replaced by model-supplied names", async () => {
    const start = PLATFORM_TOOLS.find((t) => t.name === "start_thread")!;
    const message = PLATFORM_TOOLS.find((t) => t.name === "send_bot_message")!;
    const target = await add("Real recipient");
    const project = (await suite.gw.api.getOverview({})).projects.find((p) => p.id === suite.projectId)!;
    const args = { project_id: suite.projectId, project_name: "A trusted fake", bot_name: "Another fake" };
    const phrase = await describeBotTool(suite.gw.core, start, args);
    expect(phrase).toContain(project.name);
    expect(ruleOptions(start, args, phrase)[0]?.label).not.toContain("fake");
    const workspace = PLATFORM_TOOLS.find((t) => t.name === "add_workspace")!;

    const adding = await describeBotTool(suite.gw.core, workspace, {
      ...args,
      worker_id: suite.gw.workerId,
      worker_name: "A fake computer",
    });

    expect(adding).toContain(project.name);
    expect(adding).not.toContain("fake");
    const unknown = Bun.randomUUIDv7();
    const missing = await describeBotTool(suite.gw.core, start, { project_id: unknown, project_name: "Fake" });
    expect(missing).toContain(`a project (${unknown})`);
    expect(await describeBotTool(suite.gw.core, message, { bot_id: target.id, bot_name: "Fake" })).toContain(
      "Real recipient",
    );
    expect(await describeBotTool(suite.gw.core, message, { bot_id: unknown, bot_name: "Fake" })).toContain(
      `a bot (${unknown})`,
    );
  });

  test("thread and schedule permissions come from the owner's bot setting", async () => {
    for (const [ownerMode, expected] of [
      ["read_only", PermissionMode.READ_ONLY],
      ["ask", PermissionMode.ASK],
      ["accept_edits", PermissionMode.ACCEPT_EDITS],
      ["full_auto", PermissionMode.FULL_AUTO],
    ] as const) {
      const title = `Cap ${ownerMode}`;
      const bot = await add(title, { approvalPolicy: "always", threadPermission: ownerMode });
      request("start_thread", {
        project_id: suite.projectId,
        workspace_id: suite.workspaceId,
        provider: "codex",
        provider_instance: "native",
        title,
        prompt: "Check",
      });
      await send(bot.id, "Start");
      await approve(bot.id);

      const thread = (await suite.gw.api.listThreads({ projectId: suite.projectId })).threads.find(
        (t) => t.title === title,
      )!;

      expect(thread.permissionMode).toBe(expected);
    }

    const bot = await add("Schedule cap", { approvalPolicy: "full_auto", threadPermission: "read_only" });
    request("create_schedule", {
      prompt: "Check",
      target: "new_thread",
      run_at: new Date(Date.now() + 3600_000).toISOString(),
      new_thread: {
        project_id: suite.projectId,
        workspace_id: suite.workspaceId,
        placement: "specific",
        provider: "codex",
        provider_instance: "native",
      },
    });
    await send(bot.id, "Schedule");
    await settled(bot.id);
    const schedule = (await suite.gw.api.listSchedules({})).schedules.find((s) => s.prompt === "Check")!;
    expect(schedule.newThread?.permissionMode).toBe(PermissionMode.READ_ONLY);
  }, 20_000);

  test("model-supplied thread and schedule modes are rejected before creating anything", async () => {
    const bot = await add("Injected modes", { approvalPolicy: "full_auto" });
    const before = (await suite.gw.api.listThreads({ projectId: suite.projectId })).threads.length;

    for (const name of ["start_thread", "create_schedule"]) {
      const placement = {
        project_id: suite.projectId,
        workspace_id: suite.workspaceId,
        provider: "codex",
        provider_instance: "native",
        permission: "full_access",
      };

      request(
        name,
        name === "start_thread"
          ? { ...placement, prompt: "Injected" }
          : {
              prompt: "Injected",
              target: "new_thread",
              run_at: new Date(Date.now() + 3600_000).toISOString(),
              new_thread: placement,
            },
      );
      const requested = suite.model;
      suite.model = async (input) =>
        input.messages.at(-1)?.role === "tool" ? reply(input.messages.at(-1)!.text) : requested(input);
      await send(bot.id, name);
      const state = await settled(bot.id);
      expect(state.messages.some((m) => m.text.includes("unknown field permission"))).toBe(true);
    }

    expect((await suite.gw.api.listThreads({ projectId: suite.projectId })).threads).toHaveLength(before);
    expect((await suite.gw.api.listSchedules({})).schedules.some((s) => s.prompt === "Injected")).toBe(false);
  });

  test("archived and moved bots cannot use standing rules; workspace path actions always ask", async () => {
    const bot = await add("Stopped rule owner", { approvalPolicy: "always" });
    request("schedule_wakeup", { prompt: "Later", run_at: new Date(Date.now() + 3600_000).toISOString() });
    await send(bot.id, "First");

    const card = (
      await eventually(
        () => read(bot.id),
        (s) => s.approvals.some((a) => a.status === "pending"),
      )
    ).approvals.find((a) => a.status === "pending")!;

    await suite.gw.api.answerBotApproval({ approvalId: card.id, approve: true, ruleOptionId: card.ruleOptions[0]!.id });
    await settled(bot.id);

    const call = {
      id: Bun.randomUUIDv7(),
      turn_id: "",
      call_key: "",
      status: "pending",
      result: null,
      arguments: {},
      tool: PLATFORM_TOOLS.find((t) => t.name === "schedule_wakeup")!,
    };

    const match = () => suite.gw.core.bots.run((s) => s.matchingRule(suite.gw.userId, bot.id, call, "Reminder"));
    expect((await match()).matched).toBeDefined();
    await suite.gw.api.archiveBot({ botId: bot.id });
    expect((await match()).matched).toBeUndefined();
    await suite.gw.api.unarchiveBot({ botId: bot.id });
    await suite.gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE bots SET moved_to = 'another-home' WHERE id = ${bot.id}::uuid`;
      }),
    );
    expect((await match()).matched).toBeUndefined();
    const paths = await add("Workspace path owner", { approvalPolicy: "full_auto" });

    for (const name of ["add_workspace", "update_workspace"]) {
      request(name, {
        project_id: suite.projectId,
        workspace_id: suite.workspaceId,
        worker_id: suite.gw.workerId,
        root_path: "/different",
      });
      await send(paths.id, "Change path");

      const pending = await eventually(
        () => read(paths.id),
        (s) => s.approvals.some((a) => a.status === "pending"),
      );

      expect(pending.approvals.find((a) => a.status === "pending")?.ruleOptions).toHaveLength(0);
      await suite.gw.core.bots.interrupt(paths.id);
    }
  }, 20_000);
});
