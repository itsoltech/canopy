import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Provider, ProviderProfileKind, bots, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { decryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import { eventually, failure } from "./support/gateway.ts";
import { linkedExecutionFixture, type LinkedExecutionFixture } from "./support/linked-execution.ts";

const wait = async (predicate: () => boolean | Promise<boolean>) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

const future = () => timestampFromDate(new Date(Date.now() + 3600_000));

describe.skipIf(!dockerAvailable)("bots, schedules and worker settings at their linked home", () => {
  let f: LinkedExecutionFixture;
  let bot: bots.Bot;
  let thread: ui.Thread;
  let scheduled: ui.Schedule;
  const worker = () => qualifyId(f.fixture.workerId, f.node);
  const onB = (id: string) => qualifyId(id, f.node);

  const request = (name: string, workerId = worker()) =>
    create(bots.CreateBotRequestSchema, {
      clientRequestId: crypto.randomUUID(),
      configuration: {
        name,
        shape: "round",
        color: "#22aaff",
        provider: Provider.CLAUDE,
        providerInstance: "native",
        model: "fixture-model",
        workerId,
      },
    });

  beforeAll(async () => {
    f = await linkedExecutionFixture();
    await wait(async () => (await f.a.gateway.api.listWorkerRecords({})).records.some((r) => r.workerId === worker()));
    thread = await f.fixture.thread(Provider.CODEX);
  }, 120_000);
  afterAll(async () => {
    await f?.close();
  }, 30_000);

  test("A creates a bot at B, runs its harness there, edits and archives it from A", async () => {
    bot = (await f.a.gateway.api.createBot(request("Studio bot"))).bot!;
    expect(bot.nodeId).toBe(f.node);
    expect(bot.configuration?.workerId).toBe(worker());
    const id = splitId(bot.id).id;
    expect(await f.a.store.query("SELECT 1 FROM bots WHERE id=$1::uuid", [id])).toHaveLength(0);
    expect(
      await f.store.query("SELECT 1 FROM bots WHERE id=$1::uuid AND owner_user_id=$2::uuid", [id, f.b.userId]),
    ).toHaveLength(1);
    await f.a.gateway.api.sendBotMessage({
      botId: bot.id,
      text: "Hello from the other computer",
      clientRequestId: crypto.randomUUID(),
    });

    const conversation = await eventually(
      () => f.b.core.bots.run((s) => s.conversation(f.b.userId, id)),
      (c) => !c.working && c.messages.some((m) => m.senderId === id && m.kind === "message"),
      20_000,
    );

    expect(conversation.messages.some((m) => m.failed)).toBe(false);
    expect(f.fixture.logs.join("\n")).not.toContain("fixture-secret");

    const updated = (
      await f.a.gateway.api.updateBot({
        botId: bot.id,
        configuration: { ...bot.configuration!, name: "Edited from A" },
      })
    ).bot!;

    expect(updated.configuration?.name).toBe("Edited from A");
    expect((await f.b.api.getBot({ botId: id })).bot?.configuration?.name).toBe("Edited from A");
    await f.a.gateway.api.archiveBot({ botId: bot.id });
    expect((await f.b.api.getBot({ botId: id })).bot?.archived).toBe(true);
    await f.a.gateway.api.unarchiveBot({ botId: bot.id });
    const disposable = (await f.a.gateway.api.createBot(request("Disposable"))).bot!;
    await f.a.gateway.api.archiveBot({ botId: disposable.id });
    await f.a.gateway.api.deleteBot({ botId: disposable.id });
    expect(await failure(f.b.api.getBot({ botId: splitId(disposable.id).id }))).toMatch(/not found/i);
  }, 45_000);

  test("thread and specific-worker schedules live at B and can be edited and paused from A", async () => {
    scheduled = (
      await f.a.gateway.api.createSchedule({
        target: "thread",
        threadId: onB(thread.id),
        prompt: "Report status",
        when: { case: "runAt", value: future() },
      })
    ).schedule!;
    expect(splitId(scheduled.id).node).toBe(nodeRef(f.node));
    expect(await f.a.store.query("SELECT 1 FROM schedules WHERE id=$1::uuid", [splitId(scheduled.id).id])).toHaveLength(
      0,
    );
    expect((await f.b.api.listSchedules({})).schedules.some((s) => s.id === splitId(scheduled.id).id)).toBe(true);
    scheduled = (
      await f.a.gateway.api.updateSchedule({
        scheduleId: scheduled.id,
        expectedVersion: scheduled.version,
        configuration: {
          target: "thread",
          threadId: onB(thread.id),
          prompt: "Updated report",
          when: { case: "runAt", value: future() },
        },
      })
    ).schedule!;
    expect(scheduled.prompt).toBe("Updated report");
    await f.a.gateway.api.setScheduleStatus({ scheduleId: scheduled.id, status: "paused" });
    expect((await f.b.api.listSchedules({})).schedules.find((s) => s.id === splitId(scheduled.id).id)?.status).toBe(
      "paused",
    );

    const workspace = (await f.b.api.getOverview({})).projects
      .flatMap((p) => p.workspaces)
      .find((w) => w.workerId === f.fixture.workerId)!;

    const fresh = (
      await f.a.gateway.api.createSchedule({
        target: "new_thread",
        prompt: "Start a report",
        when: { case: "runAt", value: future() },
        newThread: {
          projectId: onB(workspace.projectId),
          workspaceId: onB(workspace.id),
          placement: "specific",
          provider: Provider.CODEX,
          model: "fixture-model",
        },
      })
    ).schedule!;

    expect(fresh.newThread?.workspaceId).toBe(onB(workspace.id));
    await f.b.core.scheduler.tick(timestampDate(fresh.nextRunAt!));

    const ran = await eventually(
      async () =>
        (await f.a.gateway.api.listSchedules({ includeFinished: true })).schedules.find((s) => s.id === fresh.id),
      (row) => Boolean(row?.recentRuns.length),
      15_000,
    );

    expect(ran?.recentRuns[0]?.workerId).toBe(worker());
    expect(ran?.recentRuns[0]?.outcome).toBe("started");
  }, 45_000);

  test("worker records feed every settings list; home reads and writes keep the shared library intact", async () => {
    const current = await f.a.gateway.api.getAgentEnvironment({});
    await f.a.gateway.api.saveInstructionDocument({
      expectedRevision: current.revision,
      document: {
        name: "Shared instructions",
        harness: "codex",
        platformHome: true,
        selector: { everyone: true },
        fragments: [{ id: "intro", content: "Use clear names." }],
      },
    });
    await wait(async () =>
      (await f.b.api.getAgentEnvironment({})).documents.some((d) => d.name === "Shared instructions"),
    );
    let environment = await f.a.gateway.api.getWorkerEnvironment({ workerId: worker() });
    const item = environment.items.find((i) => i.name === "Shared instructions")!;
    environment = await f.a.gateway.api.setWorkerEnvironmentOverride({
      workerId: worker(),
      expectedRevision: environment.revision,
      override: { kind: item.kind, item: item.item, content: "Use this computer's toolchain." },
    });
    expect(environment.overrides.find((o) => o.item === item.item)?.content).toBe("Use this computer's toolchain.");
    expect(environment.worker?.preview.some((i) => i.content.includes("Use this computer's toolchain."))).toBe(true);
    expect(
      (await f.a.gateway.api.getAgentEnvironment({})).documents.find((d) => d.name === "Shared instructions")
        ?.overrides,
    ).toHaveLength(0);
    expect(
      await failure(
        f.a.gateway.api.setWorkerEnvironmentOverride({
          workerId: worker(),
          expectedRevision: environment.revision - 1n,
          override: { kind: item.kind, item: item.item, disabled: true },
        }),
      ),
    ).toContain("Environment changed");

    await f.a.gateway.api.updateWorktreeSettings({ workerId: worker(), settings: { branchPrefix: "studio" } });
    expect((await f.a.gateway.api.getWorktreeSettings({ workerId: worker() })).settings?.branchPrefix).toBe("studio");

    const connector = (
      await f.a.gateway.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Studio service",
        url: "https://mcp.example.test/mcp",
        authKind: "headers",
        token: "fixture-connector-key",
      })
    ).account!;

    await wait(async () => (await f.b.api.listConnectors({})).accounts.some((a) => a.id === connector.id));
    await f.a.gateway.api.setConnectorAccess({
      accountId: connector.id,
      workerIds: [worker()],
      expectedRevision: connector.revision,
    });
    await wait(async () => {
      const record = (await f.a.gateway.api.listWorkerRecords({})).records.find((r) => r.workerId === worker());

      return (
        !!record?.worktreeSettings.some((s) => s.settings?.branchPrefix === "studio") &&
        record.connectorAccountIds.includes(connector.id)
      );
    });
    const record = (await f.a.gateway.api.listWorkerRecords({})).records.find((r) => r.workerId === worker())!;
    expect(record.computerName).toBe("Studio B");
    expect(record.readOnlyReason).toBe("");
    expect(
      (await f.a.gateway.api.getInstanceWorker({ workerId: worker(), harness: Provider.CLAUDE, id: "native" })).worker
        ?.enabled,
    ).toBe(true);
  }, 45_000);

  test("a shared proxy override follows aliases; a worker-scoped key and proxy id never leave B", async () => {
    expect(f.proxy.id).not.toBe(f.fixture.proxy.id);
    await wait(async () => (await f.b.api.listProxies({})).proxies.some((p) => p.id === f.fixture.proxy.id));
    await f.a.gateway.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "remote-proxy",
      create: true,
      label: "Remote proxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      proxyId: f.proxy.id,
      allWorkers: true,
    });
    await wait(async () => (await f.b.api.listProviderInstances({})).instances.some((p) => p.id === "remote-proxy"));
    await f.a.gateway.api.setInstanceWorker({
      workerId: worker(),
      harness: Provider.CODEX,
      id: "remote-proxy",
      enabled: true,
      overrides: { proxyId: f.proxy.id },
    });

    const stored = await f.store.query<{ proxy_id: string }>(
      "SELECT proxy_id::text FROM provider_instance_workers WHERE worker_id=$1::uuid AND harness='codex' AND instance_id='remote-proxy'",
      [f.fixture.workerId],
    );

    expect(stored[0]?.proxy_id).toBe(f.fixture.proxy.id);
    expect(
      (await f.a.gateway.api.getInstanceWorker({ workerId: worker(), harness: Provider.CODEX, id: "remote-proxy" }))
        .worker?.overrides?.proxyId,
    ).toBe(f.proxy.id);

    const secret = "fixture-worker-home-key";

    const response = await f.a.gateway.api.setInstanceWorker({
      workerId: worker(),
      harness: Provider.CODEX,
      id: "remote-proxy",
      enabled: true,
      overrides: { apiKey: secret },
    });

    const scoped = (
      await f.store.query<{ id: string }>(
        "SELECT id::text FROM proxies WHERE owner_user_id=$1::uuid AND worker_scoped",
        [f.b.userId],
      )
    )[0]!.id;

    expect(toJsonString(ui.SetInstanceWorkerResponseSchema, response)).not.toContain(scoped);

    const read = await f.a.gateway.api.getInstanceWorker({
      workerId: worker(),
      harness: Provider.CODEX,
      id: "remote-proxy",
    });

    expect(read.worker?.overrides?.apiKeySet).toBe(true);
    expect(toJsonString(ui.GetInstanceWorkerResponseSchema, read)).not.toContain(scoped);
    expect(
      await failure(
        f.a.gateway.api.setInstanceWorker({
          workerId: worker(),
          harness: Provider.CODEX,
          id: "remote-proxy",
          overrides: { proxyId: scoped },
        }),
      ),
    ).toMatch(/same computer|shared proxy/);
    expect(await f.a.store.query("SELECT 1 FROM proxies WHERE id=$1::uuid", [scoped])).toHaveLength(0);
    expect(await f.a.store.query("SELECT 1 FROM config_items WHERE global_id=$1", [scoped])).toHaveLength(0);
    const secrets = await f.a.store.query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM secrets");
    expect(secrets.map((s) => decryptSecret(f.a.gateway.secretsKey, s.ciphertext))).not.toContain(secret);
    expect(JSON.stringify(await f.a.store.query("SELECT details FROM audit_log"))).not.toContain(secret);
  }, 45_000);

  test("the home rejects foreign workers, threads, schedules and environment items", async () => {
    const owner = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await f.store.query(
      "INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,'other-execution@localhost','Other','user')",
      [owner],
    );
    await f.store.query(
      "INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES($1::uuid,$2::uuid,'Other worker','x')",
      [foreign, owner],
    );
    expect(await failure(f.a.gateway.api.createBot(request("Foreign", onB(foreign))))).toContain("Choose a worker");
    expect(await failure(f.a.gateway.api.getWorkerEnvironment({ workerId: onB(foreign) }))).toContain(
      "isn't on this computer",
    );
    const foreignProject = crypto.randomUUID();
    const foreignWorkspace = crypto.randomUUID();
    const foreignThread = crypto.randomUUID();
    const foreignSchedule = crypto.randomUUID();
    await f.store.query("INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Other','other')", [
      foreignProject,
      owner,
    ]);
    await f.store.query(
      "INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES($1::uuid,$2::uuid,$3::uuid,'/other')",
      [foreignWorkspace, foreignProject, foreign],
    );
    await f.store.query(
      "INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd,status) VALUES($1::uuid,$2::uuid,$3::uuid,'main',$1::uuid,'worker','codex',$4::uuid,$5::uuid,'/other','idle')",
      [foreignThread, foreignProject, owner, foreign, foreignWorkspace],
    );
    await f.store.query(
      "INSERT INTO schedules(id,thread_id,created_by_user_id,project_id,kind,prompt,run_at,next_run_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'once','Other schedule',now()+interval '1 hour',now()+interval '1 hour')",
      [foreignSchedule, foreignThread, owner, foreignProject],
    );
    expect(
      await failure(
        f.a.gateway.api.createSchedule({
          target: "thread",
          threadId: onB(foreignThread),
          prompt: "Another owner's thread",
          when: { case: "runAt", value: future() },
        }),
      ),
    ).toMatch(/not found/i);
    expect(
      await failure(f.a.gateway.api.setScheduleStatus({ scheduleId: onB(foreignSchedule), status: "cancelled" })),
    ).toMatch(/not found/i);
    expect(
      (await f.a.gateway.api.listSchedules({ includeFinished: true })).schedules.some(
        (s) => s.id === onB(foreignSchedule),
      ),
    ).toBe(false);

    const environment = await f.a.gateway.api.getWorkerEnvironment({ workerId: worker() });
    expect(
      await failure(
        f.a.gateway.api.setWorkerEnvironmentOverride({
          workerId: worker(),
          expectedRevision: environment.revision,
          override: { kind: "instruction", item: crypto.randomUUID(), content: "Foreign" },
        }),
      ),
    ).toContain("Document not found");
    expect(
      await failure(
        f.a.gateway.api.createSchedule({
          target: "thread",
          threadId: onB(crypto.randomUUID()),
          prompt: "Foreign",
          when: { case: "runAt", value: future() },
        }),
      ),
    ).toMatch(/not found/i);
    expect(
      await failure(f.a.gateway.api.setScheduleStatus({ scheduleId: onB(crypto.randomUUID()), status: "cancelled" })),
    ).toMatch(/not found/i);
    expect((await f.a.gateway.api.listWorkerRecords({})).records.some((r) => r.workerId === onB(foreign))).toBe(false);
  }, 30_000);

  test("bot and schedule creation also work without Share configuration", async () => {
    await f.a.sharing(f.node, false);
    await wait(() => !configAllowed(f.a.links, f.node) && !configAllowed(f.links, f.a.node));
    const created = (await f.a.gateway.api.createBot(request("Execution only"))).bot!;
    expect(created.nodeId).toBe(f.node);

    const task = (
      await f.a.gateway.api.createSchedule({
        target: "thread",
        threadId: onB(thread.id),
        prompt: "Execution only",
        when: { case: "runAt", value: future() },
      })
    ).schedule!;

    expect(splitId(task.id).node).toBe(nodeRef(f.node));
    await f.a.sharing(f.node, true);
    await wait(() => configAllowed(f.a.links, f.node) && configAllowed(f.links, f.a.node));
  }, 45_000);

  test("an unreachable home fails immediately, keeps records read-only and queues nothing", async () => {
    // Re-enabling sharing starts a new bootstrap. Connectivity alone does not mean records arrived.
    await wait(async () =>
      (await f.a.gateway.api.listWorkerRecords({})).records.some(
        (r) => r.workerId === worker() && r.worktreeSettings.some((s) => s.settings?.branchPrefix === "studio"),
      ),
    );
    await f.links.close();
    await wait(() => !f.a.links.reachable().includes(f.node));
    const started = Date.now();
    expect(await failure(f.a.gateway.api.createBot(request("Must not queue")))).toContain("Studio B");
    expect(
      await failure(
        f.a.gateway.api.createSchedule({
          target: "thread",
          threadId: onB(thread.id),
          prompt: "Must not queue",
          when: { case: "runAt", value: future() },
        }),
      ),
    ).toContain("Studio B");
    expect(
      await failure(
        f.a.gateway.api.updateBot({ botId: bot.id, configuration: { ...bot.configuration!, name: "Must not queue" } }),
      ),
    ).toContain("Studio B");
    expect(Date.now() - started).toBeLessThan(1500);
    const record = (await f.a.gateway.api.listWorkerRecords({})).records.find((r) => r.workerId === worker())!;
    expect(record.readOnlyReason).toContain("Studio B");
    expect(record.worktreeSettings.some((s) => s.settings?.branchPrefix === "studio")).toBe(true);
    await f.reconnect();
    await wait(
      async () =>
        (await f.a.gateway.api.listWorkerRecords({})).records.find((r) => r.workerId === worker())?.readOnlyReason ===
        "",
    );
    expect((await f.b.api.listBots({})).bots.some((b) => b.configuration?.name === "Must not queue")).toBe(false);
    expect((await f.b.api.listSchedules({})).schedules.some((s) => s.prompt === "Must not queue")).toBe(false);
  }, 60_000);
});
