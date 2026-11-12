import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { computerLink, PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { nodeRef } from "@canopy/domain/computers";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { linkedMessage } from "../../apps/gateway/src/computers/remote.ts";
import { projectTransaction } from "../../apps/gateway/src/config-sync/project-records.ts";
import { wireItem } from "../../apps/gateway/src/config-sync/merge.ts";
import type { ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually, failure } from "./support/gateway.ts";

const ORIGIN = "code.example.test/team/canopy";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

const projects = (c: ConfigComputer) =>
  c.gateway.core.overview().then((r) => r.projects.filter((p) => p.kind !== "scratch"));

const named = async (c: ConfigComputer, id: string) => (await projects(c)).find((p) => p.id === id)?.name;

const defaults = async (c: ConfigComputer, id: string) =>
  (await c.gateway.api.getSettings({})).projects.find((p) => p.projectId === id);

async function project(c: ConfigComputer, name: string, path: string, origin = "") {
  const p = (await c.gateway.api.createProject({ name })).project!;

  const workspace = (
    await c.gateway.api.createWorkspace({ projectId: p.id, workerId: c.gateway.workerId, rootPath: path, label: name })
  ).workspace!;

  if (origin)
    await c.gateway.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        projectTransaction(sql, sql`UPDATE project_workspaces SET git_origin=${origin} WHERE id=${workspace.id}::uuid`),
      ),
    );

  return { project: p, workspace };
}

async function saveDefaults(c: ConfigComputer, id: string, value: MessageInitShape<typeof ui.ThreadDefaultsSchema>) {
  return c.gateway.api.updateProjectSettings({
    projectId: id,
    expectedVersion: (await defaults(c, id))?.version ?? 0n,
    threadDefaults: create(ui.ThreadDefaultsSchema, value),
  });
}

async function checkpoint(computer: ConfigComputer, threadId: string, cursor = "") {
  const abort = new AbortController();

  try {
    for await (const update of computer.gateway.api.watchThread(
      { threadId, cursor, incremental: true },
      { signal: abort.signal },
    ))
      return update;
    throw new Error("Missing thread checkpoint");
  } finally {
    abort.abort();
  }
}

async function policy(c: ConfigComputer, projectId: string, change: Partial<ui.WorktreeSettings>, workerId = "") {
  const current = await c.gateway.api.getWorktreeSettings({ projectId, workerId });

  return c.gateway.api.updateWorktreeSettings({
    projectId,
    workerId,
    expectedVersion: current.version,
    settings: create(ui.WorktreeSettingsSchema, { ...current.settings, ...change }),
  });
}

describe.skipIf(!dockerAvailable)("projects and worktree policy across separate linked databases", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let pa: Awaited<ReturnType<typeof project>>;
  let pb: Awaited<ReturnType<typeof project>>;
  beforeAll(async () => {
    a = await configComputer("Laptop A");
    b = await configComputer("Laptop B");
    pa = await project(a, "Canopy on A", "/repo/a", ORIGIN);
    pb = await project(b, "Canopy on B", "/repo/b", ORIGIN);
    await saveDefaults(a, pa.project.id, {
      workspaceId: pa.workspace.id,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.ASK,
    });
    await saveDefaults(b, pb.project.id, {
      workspaceId: pb.workspace.id,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.ASK,
    });
    await pairConfig(a, b);
    await wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, a.node));
  }, 90_000);
  afterAll(async () => {
    await a?.close();
    await b?.close();
  }, 30_000);

  test("origin merges preserve local project and workspace ids; a rename and defaults propagate", async () => {
    await wait(async () => (await named(a, pa.project.id)) === (await named(b, pb.project.id)));
    expect(await projects(a)).toHaveLength(1);
    expect(await projects(b)).toHaveLength(1);
    const canonical = [pa.project.id, pb.project.id].sort()[0]!;

    for (const c of [a, b]) {
      await wait(
        async () =>
          (await c.store.query("SELECT global_id FROM config_items WHERE kind='project' AND global_id=$1", [canonical]))
            .length === 1,
      );
      expect(
        await c.store.query("SELECT alias_id FROM config_aliases WHERE kind='project' AND global_id=$1", [canonical]),
      ).toHaveLength(1);
    }

    await a.gateway.api.renameProject({ projectId: pa.project.id, name: "Canopy renamed" });
    await wait(async () => (await named(b, pb.project.id)) === "Canopy renamed");
    await saveDefaults(a, pa.project.id, {
      workspaceId: pa.workspace.id,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.FULL_AUTO,
      models: [{ provider: Provider.CODEX, model: "project-model" }],
    });
    await wait(
      async () => (await defaults(b, pb.project.id))?.threadDefaults?.permissionMode === PermissionMode.FULL_AUTO,
    );
    expect((await defaults(b, pb.project.id))?.threadDefaults?.workspaceId).toBe(pb.workspace.id);
    expect((await defaults(b, pb.project.id))?.threadDefaults?.models[0]?.model).toBe("project-model");
    const overview = await a.gateway.api.getOverview({});
    expect(overview.projects.filter((p) => p.kind !== "scratch")).toHaveLength(1);
    expect(overview.projects.find((p) => p.id === pa.project.id)?.workspaces.map((w) => w.id)).toEqual(
      expect.arrayContaining([pa.workspace.id, `${pb.workspace.id}~${nodeRef(b.node)}`]),
    );

    const records = JSON.stringify(
      await b.store.query("SELECT fields FROM config_items WHERE kind='project_settings'"),
    );

    expect(records).not.toContain(pa.workspace.id);
  }, 30_000);

  test("an aliased project_id routes a new thread to B's own project", async () => {
    const response = await a.gateway.api.createThread({
      projectId: pa.project.id,
      workspaceId: `${pb.workspace.id}~${nodeRef(b.node)}`,
      title: "Shared project thread",
      provider: Provider.CODEX,
      permissionMode: PermissionMode.ASK,
      clientRequestId: crypto.randomUUID(),
    });

    expect(response.thread?.projectId).toBe(pa.project.id);

    const row = await b.store.query<{ project_id: string }>("SELECT project_id::text FROM threads WHERE id=$1::uuid", [
      response.thread!.id.split("~")[0],
    ]);

    expect(row[0]?.project_id).toBe(pb.project.id);
    await wait(async () =>
      (await a.gateway.api.listThreads({ projectId: pa.project.id })).threads.some((t) => t.id === response.thread?.id),
    );
  }, 30_000);

  test("linked working updates keep a worktree side thread's home project and branch", async () => {
    // Choose the home whose project is an alias, so outbound mapping must change projectId.
    const home = pa.project.id > pb.project.id ? a : b;
    const peer = home === a ? b : a;
    const place = home === a ? pa : pb;
    const canonical = [pa.project.id, pb.project.id].sort()[0]!;
    const tree = crypto.randomUUID();
    const path = "/repo/worktrees/ad9tje";
    const branch = "feat/trigger-material-matching";
    await home.store.query(
      `INSERT INTO worktrees(id,owner_user_id,project_id,workspace_id,worker_id,repo_root,path,branch)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8)`,
      [
        tree,
        home.gateway.userId,
        place.project.id,
        place.workspace.id,
        home.gateway.workerId,
        place.workspace.rootPath,
        path,
        branch,
      ],
    );

    const parent = (
      await home.gateway.api.createThread({
        projectId: place.project.id,
        workspaceId: place.workspace.id,
        provider: Provider.CODEX,
        title: "Worktree parent",
        workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
        worktreeId: tree,
      })
    ).thread!;

    const thread = (
      await home.gateway.api.createThread({
        projectId: place.project.id,
        workspaceId: place.workspace.id,
        provider: Provider.CODEX,
        title: "Worktree side",
        parentThreadId: parent.id,
      })
    ).thread!;

    await wait(async () => (await home.gateway.api.getThread({ threadId: thread.id })).thread?.status === "idle");
    const base = applyThreadUpdate(undefined, await checkpoint(home, thread.id));
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]);
    const serve = remoteServe(uiHandlers(home.gateway.core), home.gateway.core);

    const remote = serve(
      ui.GatewayService.method.watchOverview,
      create(ui.WatchOverviewRequestSchema, { includeSnapshot: true }),
      signal,
      peer.node,
    );

    const initial = await remote[Symbol.asyncIterator]().next();

    if (!initial.value) throw new Error("Missing linked overview snapshot");
    const snapshot = linkedMessage(ui.OverviewUpdateSchema, initial.value).change;
    expect(snapshot.case).toBe("mobileSnapshot");

    if (snapshot.case !== "mobileSnapshot") throw new Error("Missing linked overview snapshot");
    expect(snapshot.value.threads.find((row) => row.id === thread.id)?.projectId).toBe(canonical);
    const local = home.gateway.core.hub.subscribeOverview();
    const localRows: ui.Thread[] = [];
    const remoteRows: ui.Thread[] = [];

    const readingLocal = (async () => {
      for await (const update of local.updates)
        if (update.change.case === "thread" && update.change.value.id === thread.id)
          localRows.push(update.change.value);
    })();

    const readingRemote = (async () => {
      try {
        for await (const message of remote) {
          const update = linkedMessage(ui.OverviewUpdateSchema, message);

          if (update.change.case === "thread" && update.change.value.id === thread.id)
            remoteRows.push(update.change.value);
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    })();

    home.gateway.worker.holdTurns = true;
    let turn = "";

    try {
      turn = (await home.gateway.api.sendMessage({ threadId: thread.id, text: "Keep working" })).turn!.id;
      await wait(() => remoteRows.some((row) => row.status === "running"));
      await home.gateway.api.setThreadRead({ threadId: thread.id, unread: true });
      await wait(() => remoteRows.some((row) => row.status === "running" && row.markedUnread));
      const delta = await checkpoint(home, thread.id, base.cursor);
      expect(delta.change.case).toBe("delta");
      expect(applyThreadUpdate(base, delta).thread).toMatchObject({
        projectId: place.project.id,
        cwd: path,
        worktree: { id: tree, branch },
      });
      home.gateway.worker.finish(thread.id, turn);
      turn = "";
      await wait(() => remoteRows.some((row) => row.status === "idle"));
      expect(localRows.some((row) => row.status === "running" && row.markedUnread)).toBe(true);

      for (const [rows, projectId] of [
        [localRows, place.project.id],
        [remoteRows, canonical],
      ] as const)
        for (const row of rows)
          expect(row).toMatchObject({
            projectId,
            workspaceId: place.workspace.id,
            cwd: path,
            worktree: { id: tree, branch },
          });
    } finally {
      if (turn) home.gateway.worker.finish(thread.id, turn);
      home.gateway.worker.holdTurns = false;
      local.close();
      abort.abort();
      await Promise.all([readingLocal, readingRemote]);
    }
  }, 30_000);

  test("account and project policies propagate; locations and worker policy stay local", async () => {
    await policy(b, "", { location: "/repo/local-b" });
    await policy(a, "", { location: "/repo/local-a", branchPrefix: "shared", cleanupMerged: true });
    await wait(async () => (await b.gateway.api.getWorktreeSettings({})).settings?.branchPrefix === "shared");
    expect((await b.gateway.api.getWorktreeSettings({})).settings?.location).toBe("/repo/local-b");
    await policy(b, pb.project.id, { location: "/repo/project-b" });
    await policy(a, pa.project.id, { location: "/repo/project-a", cleanupInactiveDays: 30 });
    await wait(
      async () =>
        (await b.gateway.api.getWorktreeSettings({ projectId: pb.project.id })).settings?.cleanupInactiveDays === 30,
    );
    expect((await b.gateway.api.getWorktreeSettings({ projectId: pb.project.id })).settings?.location).toBe(
      "/repo/project-b",
    );
    await policy(a, pa.project.id, { branchPrefix: "worker-only" }, a.gateway.workerId);
    expect(JSON.stringify(await b.store.query("SELECT fields FROM config_items"))).not.toContain("worker-only");
    expect(
      JSON.stringify(await b.store.query("SELECT fields FROM config_items WHERE kind='worktree_policy'")),
    ).not.toContain("/repo/");
    // Clearing an override is a new field value; inheritance works on the other computer too.
    const own = await a.gateway.api.getWorktreeSettings({ projectId: pa.project.id });
    await a.gateway.api.updateWorktreeSettings({
      projectId: pa.project.id,
      expectedVersion: own.version,
      settings: { location: "/repo/project-a" },
    });
    await wait(
      async () =>
        (await b.gateway.api.getWorktreeSettings({ projectId: pb.project.id })).settings?.cleanupInactiveDays ===
        undefined,
    );
  }, 30_000);

  test("concurrent edits converge, a field notice restores to both computers", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    await a.gateway.api.renameProject({ projectId: pa.project.id, name: "Name from A" });
    await b.gateway.api.renameProject({ projectId: pb.project.id, name: "Name from B" });
    await a.sharing(b.node, true);
    await wait(async () => (await named(a, pa.project.id)) === "Name from B");

    const notice = (await a.links.snapshot()).configNotices.find(
      (n) => n.kind === "project" && n.field === "name" && n.value === '"Name from A"',
    );

    expect(notice).toMatchObject({ localId: pa.project.id, itemName: "Name from B", nodeName: "Laptop B" });
    await a.gateway.api.manageConfigNotice({ id: notice!.id, action: "restore" });
    await wait(async () => (await named(b, pb.project.id)) === "Name from A");
  }, 30_000);

  test("sharing off transfers no new projects or policy; reconnect catches up", async () => {
    await b.sharing(a.node, false);
    await wait(() => !configAllowed(a.links, b.node));
    expect((await a.gateway.api.previewMove({ nodeId: b.node, everything: true })).shared).toEqual([]);
    const local = (await a.gateway.api.createProject({ name: "Private while apart" })).project!;
    await policy(a, "", { branchPrefix: "apart" });
    await Bun.sleep(1000);
    expect(await b.store.query("SELECT 1 FROM projects WHERE id=$1::uuid", [local.id])).toHaveLength(0);
    expect((await b.gateway.api.getWorktreeSettings({})).settings?.branchPrefix).toBe("shared");
    await b.sharing(a.node, true);
    await wait(async () => (await named(b, local.id)) === "Private while apart");
    await wait(async () => (await b.gateway.api.getWorktreeSettings({})).settings?.branchPrefix === "apart");
    expect((await a.gateway.api.previewMove({ nodeId: b.node, everything: true })).shared).toContain(
      "Private while apart",
    );
  }, 30_000);

  test("deletion has a durable tombstone and one Restore notice, retaining local workspaces", async () => {
    await a.gateway.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        projectTransaction(
          sql,
          sql`UPDATE projects SET config_deleted=true,archived_at=now() WHERE id=${pa.project.id}::uuid`,
        ),
      ),
    );
    await wait(async () => !(await named(b, pb.project.id)));
    const notice = (await b.links.snapshot()).configNotices.find((n) => n.kind === "project" && n.field === "deleted");
    expect(notice).toMatchObject({ reason: "deleted", localId: "", itemName: "Name from A" });
    await b.restart();
    expect(await named(b, pb.project.id)).toBeUndefined();
    await b.gateway.api.manageConfigNotice({ id: notice!.id, action: "restore" });
    await wait(async () => (await named(a, pa.project.id)) === "Name from A");
    expect((await projects(b)).find((p) => p.id === pb.project.id)?.workspaces[0]?.id).toBe(pb.workspace.id);
  }, 40_000);

  test("archiving propagates and another owner's project cannot be read or edited", async () => {
    const owner = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await a.store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      owner,
      `${owner}@example.test`,
    ]);
    await a.store.query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Foreign project','foreign')",
      [foreign, owner],
    );
    expect(await failure(a.gateway.api.renameProject({ projectId: foreign, name: "Stolen" }))).toContain("not found");
    expect(
      await failure(
        a.gateway.api.updateProjectSettings({ projectId: foreign, threadDefaults: { provider: Provider.CODEX } }),
      ),
    ).toContain("not found");

    const source = (
      await b.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='project' AND local_id=$1", [pb.project.id])
    )[0]!;

    const incoming = structuredClone(source);
    incoming.global_id = foreign;
    incoming.fields["origin"]!.value = "";
    await a.links.config!.receive(
      b.node,
      create(computerLink.ConfigUpdateSchema, { items: [wireItem(incoming)] }),
      () => true,
    );
    expect((await a.store.query("SELECT name FROM projects WHERE id=$1::uuid", [foreign]))[0]).toMatchObject({
      name: "Foreign project",
    });
    expect(
      (
        await a.store.query(
          "SELECT unsupported FROM config_items WHERE owner_user_id=$1::uuid AND kind='project' AND global_id=$2",
          [a.gateway.userId, foreign],
        )
      )[0],
    ).toMatchObject({ unsupported: "Not supported on this computer" });
    await a.gateway.api.archiveProject({ projectId: pa.project.id });
    await wait(async () => !(await named(b, pb.project.id)));
    expect(JSON.stringify(await b.store.query("SELECT fields FROM config_items"))).not.toContain("Foreign project");
    expect(await a.store.query("SELECT 1 FROM config_items WHERE owner_user_id=$1::uuid", [owner])).toHaveLength(0);
    expect(await b.store.query("SELECT 1 FROM projects WHERE name='Foreign project'")).toHaveLength(0);
  }, 30_000);

  test("adding a directory attaches to the shared origin before this computer has a workspace", async () => {
    const origin = "code.example.test/team/shared-before-directory";
    const source = await project(a, "Shared before directory", "/repo/shared-before-directory", origin);
    await wait(async () => (await named(b, source.project.id)) === "Shared before directory");
    const worker = await b.gateway.addWorker("Origin worker", ["/repo"]);

    const scripted = await b.gateway.connect(worker.workerId, worker.credential, "linux", {
      hello: { capabilities: ["workspace_origin"] },
    });

    scripted.handlers.set("readWorkspaceOrigin", (_value, reply) => reply(true, { workspaceOrigin: origin }));

    const response = await b.gateway.api.addProject({
      workerId: worker.workerId,
      source: { case: "directoryPath", value: "/repo/shared-directory" },
    });

    expect(response.attached).toBe(true);
    expect(response.project?.id).toBe(source.project.id);
    expect(response.workspace).toMatchObject({
      projectId: source.project.id,
      workerId: worker.workerId,
      gitOrigin: origin,
    });
  }, 30_000);

  test("ambiguous origins and projects without an origin keep separate identities", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    const origin = "code.example.test/team/ambiguous";
    const one = await project(a, "One", "/repo/one", origin);
    const two = await project(a, "Two", "/repo/two", origin);
    const third = await project(b, "Three", "/repo/three", origin);
    const plainA = (await a.gateway.api.createProject({ name: "Same name" })).project!;
    const plainB = (await b.gateway.api.createProject({ name: "Same name" })).project!;
    await a.sharing(b.node, true);
    await wait(
      async () =>
        (await named(b, one.project.id)) === "One" &&
        (await named(a, third.project.id)) === "Three" &&
        (await named(a, plainB.id)) === "Same name" &&
        (await named(b, plainA.id)) === "Same name",
    );

    for (const c of [a, b]) {
      expect(
        await c.store.query("SELECT * FROM config_aliases WHERE kind='project' AND alias_id=ANY($1::text[])", [
          [one.project.id, two.project.id, third.project.id, plainA.id, plainB.id],
        ]),
      ).toHaveLength(0);
      expect(
        (await projects(c)).filter((p) => [one.project.id, two.project.id, third.project.id].includes(p.id)),
      ).toHaveLength(3);
    }
  }, 30_000);

  test("a later duplicate origin stays separate after edits elsewhere; archiving it keeps the original active", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    const origin = "code.example.test/team/later-duplicate";
    const first = await project(a, "First local clone", "/repo/later-first", origin);
    const other = await project(b, "Other local clone", "/repo/later-other", origin);
    await a.sharing(b.node, true);
    await wait(async () => (await named(a, first.project.id)) === (await named(b, other.project.id)));
    const alias = [first.project.id, other.project.id].sort()[1]!;
    await wait(
      async () =>
        (await b.store.query("SELECT 1 FROM config_aliases WHERE kind='project' AND alias_id=$1", [alias])).length ===
        1,
    );
    const duplicate = await project(a, "Second local clone", "/repo/later-duplicate", origin);
    await wait(async () => (await named(b, duplicate.project.id)) === "Second local clone");
    await b.gateway.api.renameProject({ projectId: other.project.id, name: "Renamed elsewhere" });
    await wait(async () => (await named(a, first.project.id)) === "Renamed elsewhere");
    await Bun.sleep(1000);
    expect(await named(b, duplicate.project.id)).toBe("Second local clone");
    expect(
      await b.store.query("SELECT 1 FROM config_aliases WHERE kind='project' AND alias_id=$1", [duplicate.project.id]),
    ).toHaveLength(0);
    expect(
      (
        await b.store.query<{ fields: ConfigRow["fields"] }>(
          "SELECT fields FROM config_items WHERE kind='project' AND local_id=$1",
          [other.project.id],
        )
      )[0]?.fields[`originAmbiguous.${a.node}`]?.value,
    ).toBe(origin);
    await a.gateway.api.archiveProject({ projectId: duplicate.project.id });
    await wait(async () => !(await named(b, duplicate.project.id)));
    await b.gateway.api.renameProject({ projectId: other.project.id, name: "Original stays active" });
    await wait(async () => (await named(a, first.project.id)) === "Original stays active");
    expect(await named(b, other.project.id)).toBe("Original stays active");
    expect(
      await b.store.query("SELECT 1 FROM config_aliases WHERE kind='project' AND alias_id=$1", [duplicate.project.id]),
    ).toHaveLength(0);
  }, 30_000);

  test("an origin discovered after bootstrap joins the replica without changing local placement ids", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    const origin = "code.example.test/team/discovered";
    const first = await project(a, "First clone", "/repo/first");
    const second = await project(b, "Second clone", "/repo/second");
    await a.sharing(b.node, true);
    await wait(async () => !!(await named(a, second.project.id)) && !!(await named(b, first.project.id)));

    for (const [c, p] of [
      [a, first],
      [b, second],
    ] as const)
      await c.gateway.runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          projectTransaction(
            sql,
            sql`UPDATE project_workspaces SET git_origin=${origin} WHERE id=${p.workspace.id}::uuid`,
          ),
        ),
      );
    await a.gateway.api.renameProject({ projectId: first.project.id, name: "Discovered project" });
    await wait(async () => (await named(b, second.project.id)) === "Discovered project");
    expect((await projects(a)).find((p) => p.id === first.project.id)?.workspaces[0]?.id).toBe(first.workspace.id);
    expect((await projects(b)).find((p) => p.id === second.project.id)?.workspaces[0]?.id).toBe(second.workspace.id);
    expect((await projects(a)).filter((p) => p.workspaces.some((w) => w.gitOrigin === origin))).toHaveLength(1);
    expect((await projects(b)).filter((p) => p.workspaces.some((w) => w.gitOrigin === origin))).toHaveLength(1);
  }, 30_000);
});
