import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { AgentToolCallSchema, bots, Provider, ProviderProfileKind } from "@canopy/contracts";
import { GatewayCore } from "@canopy/gateway/core";
import { startGrpcServer } from "@canopy/transport";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";
import { eventually } from "./support/gateway.ts";

describe("bots through official worker harnesses", () => {
  let f: InstanceFixture;
  let closeReconnect = async () => {};
  const read = (id: string) => f.gw.core.bots.run((s) => s.conversation(f.gw.userId, id));

  const send = (id: string, text: string) =>
    f.gw.core.bots.send(
      create(bots.SendBotMessageRequestSchema, {
        botId: id,
        text,
        clientRequestId: crypto.randomUUID(),
      }),
    );

  const add = async (provider: Provider, policy = "safe", workerId = f.workerId) =>
    (
      await f.gw.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: `Harness ${crypto.randomUUID().slice(0, 8)}`,
          shape: "round",
          color: "#22aaff",
          provider,
          providerInstance: "native",
          model: "fixture-model",
          approvalPolicy: policy,
          workerId,
        },
      })
    ).bot!;

  const settled = (id: string) =>
    eventually(
      () => read(id),
      (r) => !r.working,
      10_000,
    );

  beforeAll(async () => {
    f = await startInstanceFixture(true);

    for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
      await f.save(provider, "bot-native");
      await f.gw.api.setInstanceModels({ harness: provider, id: "native", models: { custom: ["fixture-model"] } });
    }

    f.gw.core.bots.start();
  }, 30_000);
  afterAll(async () => {
    await closeReconnect();
    await f?.close();
  });

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} round trip and hidden session resume`, async () => {
      const bot = await add(provider);
      await send(bot.id, "Hello");
      let result = await settled(bot.id);
      expect(result.messages.at(-1)?.text).toBe("FIXTURE_OK");
      await send(bot.id, "Second message");
      result = await settled(bot.id);
      expect(result.messages.filter((m) => m.senderId === bot.id)).toHaveLength(2);
      const turns = f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`));
      expect(turns).toHaveLength(2);
      expect(turns[0]?.session).toBe(turns[1]?.session);
      const evidence = readFileSync(join(f.dir, "bots.jsonl"), "utf8");
      expect(evidence).toContain(`"provider":"${Provider[provider].toLowerCase()}","isolated":true`);
    });

    test(`${Provider[provider]} Canopy tool waits for approval and runs in the gateway`, async () => {
      const bot = await add(provider, "always");
      const turnId = await send(bot.id, "TOOL:create_project");

      const pending = await eventually(
        () => read(bot.id),
        (r) => r.approvals.some((a) => a.status === "pending"),
      );

      expect(pending.approvals).toHaveLength(1);
      expect(pending.messages).toHaveLength(1);

      const denied = await f.gw.core.bots.harnessTools.handle(
        create(AgentToolCallSchema, {
          callId: crypto.randomUUID(),
          threadId: bot.id,
          botId: bot.id,
          turnId,
          toolName: "list_projects",
          argumentsJson: "{}",
        }),
        f.gw.workerId,
      );

      expect(denied.isError).toBe(true);

      const foreign = new GatewayCore({
        runtime: f.gw.runtime,
        userId: crypto.randomUUID(),
        instanceId: crypto.randomUUID(),
      });

      expect(
        (
          await foreign.bots.harnessTools.handle(
            create(AgentToolCallSchema, {
              callId: crypto.randomUUID(),
              threadId: bot.id,
              botId: bot.id,
              turnId,
              toolName: "list_projects",
              argumentsJson: "{}",
            }),
            f.workerId,
          )
        ).isError,
      ).toBe(true);
      await f.gw.core.bots.answer(
        create(bots.AnswerBotApprovalRequestSchema, {
          approvalId: pending.approvals[0]!.id,
          approve: true,
        }),
      );
      const result = await settled(bot.id);
      expect(result.messages.at(-1)?.text).toContain("Harness project");
      expect(result.approvals[0]?.status).toBe("approved");
    }, 15_000);
  }

  test("Grok with native id and Proxy connection runs through the pinned worker harness", async () => {
    await f.save(Provider.GROK, "bot-proxy", ProviderProfileKind.CLIPROXYAPI);

    try {
      const bot = await add(Provider.GROK);
      await send(bot.id, "Hello through Proxy");
      expect((await settled(bot.id)).messages.at(-1)).toMatchObject({ text: "FIXTURE_OK", failed: false });
      const instances = (await f.gw.api.getBotProviderInstances({ botId: bot.id })).instances;
      expect(instances.find((instance) => instance.harness === Provider.GROK && instance.id === "native")?.kind).toBe(
        ProviderProfileKind.CLIPROXYAPI,
      );
      const turns = f.records().filter((record) => record.event === "turn" && record.home.includes(`/bots/${bot.id}/`));
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ harness: "grok", proxy: true, credentialMatches: true });
      expect((await f.gw.api.getBot({ botId: bot.id })).bot?.configuration?.workerId).toBe(f.workerId);
    } finally {
      await f.save(Provider.GROK, "bot-native");
    }
  });

  test("gateway restart preserves a pending approval and never reruns inference", async () => {
    const bot = await add(Provider.GROK, "always");
    await send(bot.id, "TOOL:create_project");

    const pending = await eventually(
      () => read(bot.id),
      (r) => r.approvals.some((a) => a.status === "pending"),
    );

    expect(pending.approvals).toHaveLength(1);
    await f.gw.core.bots.stop();
    await f.disconnect();
    const restarted = new GatewayCore({ runtime: f.gw.runtime, userId: f.gw.userId, instanceId: crypto.randomUUID() });
    const grpc = await startGrpcServer({ routes: (router) => restarted.link.routes(router) });

    try {
      closeReconnect = await f.reconnect(grpc.url);
      restarted.bots.start();
      await restarted.bots.answer(
        create(bots.AnswerBotApprovalRequestSchema, { approvalId: pending.approvals[0]!.id, approve: true }),
      );

      const result = await eventually(
        () => restarted.bots.run((s) => s.conversation(f.gw.userId, bot.id)),
        (r) => !r.working,
        10_000,
      );

      expect(result.messages.at(-1)?.text).toContain("Harness project");
      expect(f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))).toHaveLength(1);
    } finally {
      await restarted.bots.stop();
      await closeReconnect();
      await restarted.link.shutdown();
      await grpc.close();
      closeReconnect = await f.reconnect();
      f.gw.core.bots.start();
    }
  }, 15_000);

  test("harness crash recovers the completed transcript without duplicate text", async () => {
    const bot = await add(Provider.CLAUDE);
    await send(bot.id, "CRASH_AFTER_TRANSCRIPT");
    const result = await settled(bot.id);
    expect(result.messages.at(-1)?.text).toBe("FIXTURE_OK");
    expect(result.messages.filter((m) => m.senderId === bot.id)).toHaveLength(1);
  });

  test("Grok recovers a saved CLI end after a process crash", async () => {
    const bot = await add(Provider.GROK);
    await send(bot.id, "CRASH_AFTER_TRANSCRIPT");
    const result = await settled(bot.id);
    expect(result.messages.at(-1)?.text).toBe("FIXTURE_OK");
    expect(result.messages.filter((m) => m.senderId === bot.id)).toHaveLength(1);
  });

  test("Grok refuses built-in permissions while Canopy tools keep gateway approvals", async () => {
    const bot = await add(Provider.GROK, "always");
    await send(bot.id, "BUILTIN_PERMISSION");
    const result = await settled(bot.id);
    expect(result.messages.at(-1)?.text).toBe("BUILTIN_DENIED");
    expect(result.approvals).toHaveLength(0);
  });

  test("an existing API-era Grok bot pins a worker on its next turn and retains its history", async () => {
    const id = crypto.randomUUID();

    const configuration = create(bots.BotConfigurationSchema, {
      name: "Migrated Grok",
      shape: "round",
      color: "#22aaff",
      provider: Provider.GROK,
      providerInstance: "native",
      model: "fixture-model",
      approvalPolicy: "safe",
    });

    await f.query(
      "INSERT INTO bots(id, owner_user_id, client_request_id, provider, provider_instance, configuration) VALUES ($1::uuid,$2::uuid,$3,'grok','native',$4::jsonb)",
      [id, f.gw.userId, crypto.randomUUID(), JSON.stringify(toJson(bots.BotConfigurationSchema, configuration))],
    );
    await send(id, "Before migration");
    expect((await settled(id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    expect((await f.gw.api.getBot({ botId: id })).bot?.configuration?.workerId).toBe(f.workerId);
    await send(id, "After migration");
    expect((await settled(id)).messages.map((m) => m.text)).toEqual([
      "Before migration",
      "FIXTURE_OK",
      "After migration",
      "FIXTURE_OK",
    ]);
  });

  test("an unpinned bot waits clearly when no eligible worker is online", async () => {
    const bot = await add(Provider.GROK, "safe", "");
    await f.disconnect();
    await send(bot.id, "Waiting for an eligible worker");

    const pending = await eventually(
      () => read(bot.id),
      (r) => r.statusLine === "Waiting for a worker",
    );

    expect(pending.working).toBe(true);
    await f.gw.core.bots.interrupt(bot.id);
    closeReconnect = await f.reconnect();
  });

  test("Grok loses no history when its local session disappears, and retries explicitly", async () => {
    const bot = await add(Provider.GROK);
    await send(bot.id, "Original context");
    await settled(bot.id);
    const before = f.records().find((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))!;
    rmSync(join(before.home, `${before.session}.json`));
    await send(bot.id, "Continue after session loss");
    expect((await settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    const turns = f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`));
    expect(turns.at(-1)?.session).not.toBe(before.session);
    const failedId = await send(bot.id, "FAIL_ONCE");
    expect((await settled(bot.id)).messages.at(-1)).toMatchObject({
      failed: true,
      errorCode: "stream_cut_off",
      errorSource: "harness",
    });
    expect((await f.gw.core.bots.run((s) => s.harnessTurn(failedId)))?.error_code).toBe("max_tokens");
    await f.gw.core.bots.retry(bot.id);
    await eventually(
      () => read(bot.id),
      (r) => !r.working && r.messages.at(-1)?.text === "FIXTURE_OK",
    );
  });

  test("worker restart preserves the session and command deduplication", async () => {
    const bot = await add(Provider.GROK);
    await send(bot.id, "Before worker restart");
    expect((await settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    await f.restartWorker();
    await send(bot.id, "After worker restart");
    expect((await settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    const turns = f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`));
    expect(turns).toHaveLength(2);
    expect(turns[0]?.session).toBe(turns[1]?.session);
  }, 15_000);

  test("offline pinned worker keeps the outbox, reconnect delivers once", async () => {
    const bot = await add(Provider.GROK);
    await f.disconnect();
    await send(bot.id, "Queued while offline");

    const queued = await eventually(
      () => read(bot.id),
      (r) => r.statusLine.includes("Waiting for"),
    );

    expect(queued.statusLine).toBe("Waiting for Instance fixture");
    expect(queued.working).toBe(true);
    expect(f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))).toHaveLength(0);
    closeReconnect = await f.reconnect();
    const result = await settled(bot.id);
    expect(result.messages.at(-1)?.text).toBe("FIXTURE_OK");
    expect(f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))).toHaveLength(1);
  });

  test("a cancelled offline turn is never launched on reconnect", async () => {
    const bot = await add(Provider.GROK);
    await f.disconnect();
    await send(bot.id, "Cancel before delivery");
    await eventually(
      () => read(bot.id),
      (r) => r.statusLine.includes("Waiting for"),
    );
    await f.gw.core.bots.interrupt(bot.id);
    closeReconnect = await f.reconnect();
    await send(bot.id, "Next live turn");
    expect((await settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    expect(f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))).toHaveLength(1);
  });

  test("a failed harness turn retains its thread error code and explicit retry gets a new command", async () => {
    const bot = await add(Provider.CODEX);
    const failedId = await send(bot.id, "FAIL_ONCE");
    expect((await settled(bot.id)).messages.at(-1)?.failed).toBe(true);
    expect((await f.gw.core.bots.run((s) => s.harnessTurn(failedId)))?.error_code).toBe("usageLimitExceeded");
    await f.gw.core.bots.retry(bot.id);

    const result = await eventually(
      () => read(bot.id),
      (r) => r.messages.at(-1)?.text === "FIXTURE_OK",
      10_000,
    );

    expect(result.messages.filter((m) => m.senderId === bot.id)).toHaveLength(1);
    expect(f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))).toHaveLength(2);
  });

  test("lost Codex session is rebuilt from gateway history", async () => {
    const bot = await add(Provider.CODEX);
    await send(bot.id, "Original context");
    await settled(bot.id);
    const before = f.records().find((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))!;
    rmSync(join(before.home, "sessions", `${before.session}.json`));
    await send(bot.id, "Continue after local session loss");
    expect((await settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    const turns = f.records().filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`));
    expect(turns).toHaveLength(2);
    expect(turns[1]?.session).not.toBe(before.session);
  });

  test("four waiting approvals leave capacity for another bot", async () => {
    const blocked = [];

    for (let i = 0; i < 4; i++) {
      const bot = await add(Provider.CLAUDE, "always");
      blocked.push(bot.id);
      await send(bot.id, "TOOL:create_project");
      await eventually(
        () => read(bot.id),
        (r) => r.approvals.some((a) => a.status === "pending"),
      );
    }

    try {
      const ready = await add(Provider.CODEX);
      await send(ready.id, "Runs while others wait");
      expect((await settled(ready.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    } finally {
      for (const id of blocked) await f.gw.core.bots.interrupt(id);
    }
  }, 20_000);
});
