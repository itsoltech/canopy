import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJsonString } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { dockerAvailable } from "@canopy/db/testing";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually, failure } from "./support/gateway.ts";
import { fakeConnector } from "./support/connector.ts";

describe.skipIf(!dockerAvailable)("remote thread panel at its authoritative home", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let fake: ReturnType<typeof fakeConnector>;
  let thread = "";
  let project = "";
  let account = "";
  let foreignThread = "";
  let foreignAccount = "";
  let foreignSchedule = "";
  const q = (id: string) => qualifyId(id, b.node);
  const panel = () => a.gateway.api.getThreadPanel({ threadId: q(thread) });

  beforeAll(async () => {
    a = await configComputer("Panel laptop");
    b = await configComputer("Panel home");
    // In particular, credentials cannot arrive via Share configuration either.
    await pairConfig(a, b, false, false);
    expect(await eventually(async () => a.links.reachable().includes(b.node), Boolean, 20_000)).toBe(true);
    fake = fakeConnector();
    const gw = b.gateway;
    gw.worker.holdTurns = true;
    project = (await gw.api.createProject({ name: "Panel project" })).project!.id;

    const workspace = (await gw.api.createWorkspace({ projectId: project, workerId: gw.workerId, rootPath: "/repo" }))
      .workspace!.id;

    thread = (
      await gw.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        permissionMode: PermissionMode.FULL_AUTO,
        initialMessage: "Use home connectors",
        title: "Home panel",
      })
    ).thread!.id;

    const saved = (
      await gw.api.saveConnectorAccount({
        connectorType: "custom",
        name: "work",
        url: fake.url,
        authKind: "headers",
        token: fake.secret,
        headers: { "X-Private": "private-panel-header" },
      })
    ).account!;

    account = saved.id;
    await gw.api.setConnectorAccess({ accountId: account, expectedRevision: saved.revision, workerIds: [gw.workerId] });
    await gw.api.testConnector({ accountId: account });

    const owner = crypto.randomUUID();
    const privateProject = crypto.randomUUID();
    foreignThread = crypto.randomUUID();
    foreignAccount = crypto.randomUUID();
    foreignSchedule = crypto.randomUUID();
    await b.store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      owner,
      `${owner}@test`,
    ]);
    await b.store.query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Private','private-panel')",
      [privateProject, owner],
    );
    await b.store.query(
      `INSERT INTO threads(id,root_thread_id,project_id,owner_user_id,kind,runtime,provider,status,title)
      VALUES($1::uuid,$1::uuid,$2::uuid,$3::uuid,'main','gateway','openai','idle','Private thread')`,
      [foreignThread, privateProject, owner],
    );
    await b.store.query(
      `INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status)
      VALUES($1::uuid,$2::uuid,'custom','private account',$1::text,'https://example.test','http','headers','connected')`,
      [foreignAccount, owner],
    );
    await b.store.query(
      `INSERT INTO schedules(id,project_id,created_by_user_id,thread_id,kind,prompt,status,run_at,next_run_at)
      VALUES($1::uuid,$4::uuid,$2::uuid,$3::uuid,'once','private prompt','active',now()+interval '1 day',now()+interval '1 day')`,
      [foreignSchedule, owner, foreignThread, privateProject],
    );
    await b.store.query("UPDATE threads SET status='archived',archived_at=now() WHERE id=$1::uuid", [foreignThread]);
  }, 90_000);

  afterAll(async () => {
    await fake?.close();
    await b?.close();
    await a?.close();
  }, 30_000);

  test("same granted account metadata as home, with no credentials or account internals on the link", async () => {
    const home = await b.gateway.api.getThreadPanel({ threadId: thread });
    const remote = await panel();
    expect(remote.connectors).toHaveLength(1);
    expect(remote.connectors[0]).toMatchObject({
      accountId: q(account),
      connectorName: home.connectors[0]!.connectorName,
      accountLabel: "work",
      status: "connected",
      granted: true,
    });
    const wire = toJsonString(ui.ThreadPanelSchema, remote);

    for (const forbidden of [
      fake.secret,
      "private-panel-header",
      "headerNames",
      "credentials",
      "authKind",
      fake.url,
      "private account",
    ])
      expect(wire).not.toContain(forbidden);
    expect(
      (await a.store.query<{ count: number }>("SELECT count(*)::int AS count FROM connector_accounts"))[0]!.count,
    ).toBe(0);
  });

  test("create, list, edit and cancel a schedule remotely, storing and executing it only at home", async () => {
    const created = (
      await a.gateway.api.createSchedule({
        threadId: q(thread),
        name: "Home task",
        prompt: "Run later",
        when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 86_400_000)) },
      })
    ).schedule!;

    expect(created.threadId).toBe(q(thread));
    expect((await a.gateway.api.listSchedules({ threadId: q(thread) })).schedules.map((s) => s.id)).toContain(
      created.id,
    );

    const edited = (
      await a.gateway.api.updateSchedule({
        scheduleId: created.id,
        expectedVersion: created.version,
        configuration: {
          threadId: q(thread),
          name: "Edited at home",
          prompt: "New prompt",
          when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 172_800_000)) },
        },
      })
    ).schedule!;

    expect((await b.gateway.api.listSchedules({ threadId: thread })).schedules[0]!.name).toBe("Edited at home");
    expect((await panel()).schedules[0]!.id).toBe(edited.id);
    expect(
      (await a.gateway.api.setScheduleStatus({ scheduleId: edited.id, status: "cancelled" })).schedule!.status,
    ).toBe("cancelled");
    expect((await a.gateway.api.listSchedules({ threadId: q(thread) })).schedules).toEqual([]);
    expect((await b.gateway.api.listSchedules({ threadId: thread, includeFinished: true })).schedules[0]!.status).toBe(
      "cancelled",
    );
    expect((await a.store.query<{ count: number }>("SELECT count(*)::int AS count FROM schedules"))[0]!.count).toBe(0);
  });

  test("remote grant changes are immediately enforced by the home worker bridge", async () => {
    const gw = b.gateway;

    const turns = await eventually(
      () =>
        b.store.query<{ id: string; status: string }>("SELECT id,status FROM turns WHERE thread_id=$1::uuid", [thread]),
      (rows) => rows.some((row) => row.status === "running"),
    );

    const turn = turns.find((row) => row.status === "running")!;
    const tools = (await gw.api.testConnector({ accountId: account })).tools;
    const tool = tools.find((entry) => entry.remoteName === "read_marker")!;

    const call = () =>
      gw.worker.callTool({
        threadId: thread,
        turnId: turn.id,
        connectorAccountId: account,
        tool: tool.name,
        args: { marker: "PANEL_OK" },
      });

    expect((await call()).isError).toBe(false);
    let metadata = (await panel()).connectors[0]!;

    const revoked = await a.gateway.api.setThreadConnectorGrant({
      threadId: q(thread),
      accountId: q(account),
      expectedRevision: metadata.revision,
      granted: false,
    });

    expect(revoked.connectors[0]!.granted).toBe(false);
    expect((await call()).isError).toBe(true);
    expect(
      await failure(
        a.gateway.api.setThreadConnectorGrant({
          threadId: q(thread),
          accountId: q(account),
          expectedRevision: metadata.revision,
          granted: true,
        }),
      ),
    ).toContain("reload");
    metadata = revoked.connectors[0]!;
    await a.gateway.api.setThreadConnectorGrant({
      threadId: q(thread),
      accountId: q(account),
      expectedRevision: metadata.revision,
      granted: true,
    });
    expect((await call()).isError).toBe(false);
  });

  test("the home rejects foreign threads, accounts and schedules, including mixed-home ids", async () => {
    expect(await failure(a.gateway.api.getThreadPanel({ threadId: q(foreignThread) }))).toContain("failed");
    expect(
      await failure(
        a.gateway.api.setThreadConnectorGrant({
          threadId: q(thread),
          accountId: q(foreignAccount),
          expectedRevision: 1n,
          granted: true,
        }),
      ),
    ).toContain("not found");
    expect(
      await failure(
        a.gateway.api.setThreadConnectorGrant({
          threadId: q(foreignThread),
          accountId: q(account),
          expectedRevision: 1n,
          granted: true,
        }),
      ),
    ).toContain("failed");
    expect(
      await failure(
        a.gateway.api.setThreadConnectorGrant({
          threadId: q(thread),
          accountId: account,
          expectedRevision: 1n,
          granted: true,
        }),
      ),
    ).toContain("same computer");
    expect((await a.gateway.api.listSchedules({ threadId: q(foreignThread) })).schedules).toEqual([]);
    expect(
      await failure(a.gateway.api.setScheduleStatus({ scheduleId: q(foreignSchedule), status: "cancelled" })),
    ).toContain("not found");
    expect(
      await failure(
        a.gateway.api.createSchedule({
          threadId: q(foreignThread),
          prompt: "No access",
          when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 86_400_000)) },
        }),
      ),
    ).toContain("not found");
  });

  test("archive counts and keyset pages include both homes, children, search and owner scoping", async () => {
    const localProject = (await a.gateway.api.createProject({ name: "Archive laptop" })).project!.id;

    for (const [computer, projectId, count] of [
      [a, localProject, 7],
      [b, project, 31],
    ] as const) {
      for (let index = 0; index < count; index++) {
        const id = crypto.randomUUID();
        await computer.store.query(
          `INSERT INTO threads(id,root_thread_id,project_id,owner_user_id,kind,runtime,provider,status,title,archived_at)
          VALUES($1::uuid,$1::uuid,$2::uuid,$3::uuid,'main','gateway','openai','archived',$4,
            '2026-01-01T00:00:00Z'::timestamptz+($5::int*interval '1 microsecond'))`,
          [id, projectId, computer.gateway.userId, `Archive panel ${index}`, index % 3],
        );

        if (index === 0)
          await computer.store.query(
            `INSERT INTO threads(id,root_thread_id,parent_thread_id,project_id,owner_user_id,kind,runtime,provider,status,title,archived_at)
            VALUES($1::uuid,$2::uuid,$2::uuid,$3::uuid,$4::uuid,'side','gateway','openai','archived','Archive child match',
              '2026-01-01T00:00:00Z'::timestamptz)`,
            [crypto.randomUUID(), id, projectId, computer.gateway.userId],
          );
      }
    }

    for (const computer of [a, b]) {
      const count = await eventually(
        () => computer.gateway.api.listArchivedThreads({ countOnly: true }),
        (page) => page.totalCount === 38,
        20_000,
      );

      expect(count.totalCount).toBe(38);
      const first = await computer.gateway.api.listArchivedThreads({ pageSize: 20 });
      const second = await computer.gateway.api.listArchivedThreads({ pageSize: 20, pageToken: first.nextPageToken });
      expect([first.threads.length, second.threads.length]).toEqual([20, 18]);
      expect(new Set([...first.threads, ...second.threads].map((t) => t.id.split("~")[0])).size).toBe(38);
      expect(second.nextPageToken).toBe("");
      const children = await computer.gateway.api.listArchivedThreads({ query: "child match" });
      expect(children.totalCount).toBe(2);
      expect(children.threads.map((entry) => entry.title)).toEqual(["Archive panel 0", "Archive panel 0"]);
      expect(children.sideThreads).toHaveLength(2);
      expect((await computer.gateway.api.listArchivedThreads({ query: "Private" })).totalCount).toBe(0);
      expect(
        await failure(computer.gateway.api.listArchivedThreads({ query: "changed", pageToken: first.nextPageToken })),
      ).toContain("page token");
    }

    expect((await a.gateway.api.listArchivedThreads({ projectIds: [q(project)], countOnly: true })).totalCount).toBe(
      31,
    );
    expect(
      (await b.gateway.api.listArchivedThreads({ projectIds: [qualifyId(localProject, a.node)], countOnly: true }))
        .totalCount,
    ).toBe(7);
  }, 45_000);

  test("thread-scoped failures and an offline home retain persisted panel data and refuse writes", async () => {
    const cached = await panel();
    const serve = b.links.options.serve!;
    b.links.options.serve = async function* (method, ...args) {
      if (method.name === "GetThreadPanel") throw new ConnectError("Thread panel unavailable", Code.Unavailable);
      yield* serve(method, ...args);
    };

    try {
      const stale = await panel();
      expect(stale.stale).toBe(true);
      expect(stale.connectors).toEqual(cached.connectors);
      expect(a.links.reachable()).toContain(b.node);
    } finally {
      b.links.options.serve = serve;
    }

    await b.links.close();
    expect(await eventually(async () => !a.links.reachable().includes(b.node), Boolean, 10_000)).toBe(true);
    const offline = await panel();
    expect(offline.stale).toBe(true);
    expect(offline.unavailable).toBe(false);
    expect(offline.connectors).toEqual(cached.connectors);
    expect(offline.schedules).toEqual(cached.schedules);
    expect((await a.gateway.api.listArchivedThreads({ countOnly: true })).totalCount).toBe(38);
    expect(
      await failure(
        a.gateway.api.setThreadConnectorGrant({
          threadId: q(thread),
          accountId: q(account),
          granted: false,
          expectedRevision: cached.connectors[0]!.revision,
        }),
      ),
    ).toBeTruthy();
    expect(
      await failure(
        a.gateway.api.createSchedule({
          threadId: q(thread),
          prompt: "Do not queue",
          when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 86_400_000)) },
        }),
      ),
    ).toBeTruthy();
    await a.restart();
    expect((await panel()).connectors).toEqual(cached.connectors);
    await a.gateway.api.manageComputer({ action: "unlink", nodeId: b.node });
    expect(
      (await a.store.query<{ count: number }>("SELECT count(*)::int AS count FROM computer_thread_panels"))[0]!.count,
    ).toBe(0);
  }, 45_000);
});
