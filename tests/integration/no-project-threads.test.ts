import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Provider, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("no-project threads", () => {
  let gw: TestGateway;
  let project: ui.Project;
  let workspace: ui.Workspace;
  const createThread = async (title: string, extra: MessageInitShape<typeof ui.CreateThreadRequestSchema> = {}) => {
    const thread = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX, title, ...extra })).thread!;
    return (await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle")).thread!;
  };
  beforeAll(async () => {
    gw = await startTestGateway();
    const overview = await eventually(() => gw.api.getOverview({}), (o) => o.workers[0]!.appliedVersion > 0n);
    project = overview.projects.find((p) => p.kind === "scratch")!;
    workspace = project.workspaces.find((w) => w.workerId === gw.workerId)!;
  }, 60_000);
  afterAll(async () => { await gw?.close(); });

  test("without any user project: one system project, a workspace per accessible worker, unique cwd per thread", async () => {
    expect(project).toMatchObject({ name: "No project", kind: "scratch" });
    expect(workspace.rootPath).toBe(`/repo/.open-agents/scratch/${gw.userId}`);
    expect((await gw.api.getOverview({})).projects).toHaveLength(1);
    const concurrent = await Promise.all([gw.api.getOverview({}), gw.api.getOverview({})]);
    expect(concurrent.every((o) => o.projects[0]?.id === project.id && o.projects[0]?.workspaces.length === 1)).toBe(true);
    const first = await createThread("Configure laptop", { initialMessage: "hello" });
    const second = await createThread("Another conversation");
    expect(first.cwd).toBe(`${workspace.rootPath}/${first.id}`);
    expect(second.cwd).toBe(`${workspace.rootPath}/${second.id}`);
    expect(first.cwd).not.toBe(second.cwd);
    expect(first).toMatchObject({ projectId: project.id, workspaceId: workspace.id, workerId: gw.workerId });
    const spec = gw.worker.commands.find((c) => c.case === "createThread" && c.value.thread?.threadId === first.id);
    expect(spec?.case === "createThread" && spec.value.thread).toMatchObject({ scratch: true, cwd: first.cwd });
    expect(gw.worker.inputs.get(first.id)).toEqual(["hello"]);
    expect(await failure(gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX, cwd: workspace.rootPath }))).toContain("own scratch directory");
    const worker = await gw.addWorker("scratch-server", ["/srv"]);
    const refreshed = (await gw.api.getOverview({})).projects.find((p) => p.id === project.id)!;
    expect(refreshed.workspaces.find((w) => w.workerId === worker.workerId)?.rootPath).toBe(`/srv/.open-agents/scratch/${gw.userId}`);
  });

  test("side threads, spawn_thread and forks retain the same directory and tree rules", async () => {
    const parent = await createThread("Scratch parent", { initialMessage: "prepare" });
    const child = await createThread("Scratch child", { parentThreadId: parent.id });
    expect(child).toMatchObject({ cwd: parent.cwd, workspaceId: parent.workspaceId, rootThreadId: parent.id, parentThreadId: parent.id });
    const spawned = await gw.worker.callTool({ threadId: parent.id, tool: "spawn_thread", args: { title: "Helper", prompt: "inspect", notify: false } });
    expect(spawned.isError).toBe(false);
    const spawnedId = (JSON.parse(spawned.content) as { thread_id: string }).thread_id;
    expect((await gw.api.getThread({ threadId: spawnedId })).thread).toMatchObject({ cwd: parent.cwd, projectId: project.id, spawnedByAgent: true });
    const turns = await gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(parent.id)));
    const fork = (await gw.api.createThread({ forkThreadId: parent.id, forkAtTurnId: turns[0]!.id })).thread!;
    expect(fork).toMatchObject({ cwd: parent.cwd, workspaceId: parent.workspaceId, rootThreadId: fork.id, forkSourceThreadId: parent.id });
    expect(fork.cwd).not.toEndWith(fork.id);
  });

  test("listing, project filter, search, mentions, defaults, archive and soft delete retain scratch identity", async () => {
    const thread = await createThread("Find this scratch conversation");
    expect((await gw.api.listThreads({ projectId: project.id })).threads.some((t) => t.id === thread.id)).toBe(true);
    const settings = (await gw.api.getSettings({})).user!;
    const saved = (await gw.api.updateUserSettings({ expectedVersion: settings.version,
      threadDefaults: { workspaceId: workspace.id }, sidebar: { projectIds: [project.id] } })).settings!;
    expect(saved.threadDefaults?.workspaceId).toBe(workspace.id);
    expect(saved.sidebar?.projectIds).toEqual([project.id]);
    const mentions = await gw.api.searchThreads({ query: "Find this scratch" });
    expect(mentions.threads.some((t) => t.id === thread.id)).toBe(true);
    await gw.api.setThreadArchived({ threadId: thread.id, archived: true });
    expect((await gw.api.listArchivedThreads({ projectIds: [project.id], query: "No project" })).threads.some((t) => t.id === thread.id)).toBe(true);
    expect((await gw.api.listArchivedThreads({ projectIds: [project.id], query: "Find this scratch" })).threads.some((t) => t.id === thread.id)).toBe(true);
    await gw.api.setThreadArchived({ threadId: thread.id, archived: false });
    await gw.api.deleteThread({ threadId: thread.id });
    expect((await gw.api.listThreads({ projectId: project.id })).threads.some((t) => t.id === thread.id)).toBe(false);
    await gw.api.restoreThread({ threadId: thread.id });
    expect((await gw.api.getThread({ threadId: thread.id })).thread?.cwd).toBe(thread.cwd);
    expect(await failure(gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo/custom" }))).toContain("automatically");
    expect(await failure(gw.api.removeWorkspace({ workspaceId: workspace.id }))).toContain("workspace not found");
  });

  test("draft mentions do not create folders; an existing thread scopes files and catalogs to its cwd", async () => {
    const requested: string[] = [];
    gw.worker.handlers.set("listMentionCatalog", (value, reply) => {
      requested.push((value as { cwd: string }).cwd);
      reply(true, { mentionCatalog: { entries: [] } });
    });
    gw.worker.handlers.set("searchFiles", (value, reply) => {
      requested.push((value as { cwd: string }).cwd);
      reply(true, { fileSearch: { matches: [{ path: "notes.txt" }], source: "walk" } });
    });
    const scope = { workspaceId: workspace.id, provider: Provider.CODEX };
    expect((await gw.api.searchFiles({ scope, query: "" })).result?.matches).toEqual([]);
    await gw.api.listMentionCatalog({ scope, refresh: true });
    expect(requested).toEqual(["/repo"]);
    const thread = await createThread("Scratch mentions");
    await gw.api.searchFiles({ scope: { threadId: thread.id }, query: "notes" });
    await gw.api.listMentionCatalog({ scope: { threadId: thread.id }, refresh: true });
    expect(requested.slice(1)).toEqual([thread.cwd, thread.cwd]);
    gw.worker.handlers.delete("listMentionCatalog");
    gw.worker.handlers.delete("searchFiles");
  });

  test("a new_thread schedule targets No project and gets a fresh directory each run", async () => {
    const schedule = (await gw.api.createSchedule({ target: "new_thread", name: "Machine maintenance", prompt: "Check machine",
      when: { case: "cron", value: "*/5 * * * *" }, maxRuns: 2,
      newThread: { projectId: project.id, placement: "specific", workspaceId: workspace.id, provider: Provider.CODEX },
    })).schedule!;
    const cwds: string[] = [];
    let at = schedule.nextRunAt!;
    for (let index = 0; index < 2; index++) {
      await gw.core.scheduler.tick(timestampDate(at));
      const current = (await gw.api.listSchedules({ includeFinished: true })).schedules.find((s) => s.id === schedule.id)!;
      expect(current.runs).toBe(index + 1);
      const run = current.recentRuns[0]!;
      const thread = (await eventually(() => gw.api.getThread({ threadId: run.threadId }), (r) => r.thread?.status === "idle")).thread!;
      expect(thread).toMatchObject({ projectId: project.id, workspaceId: workspace.id, workerId: gw.workerId, scheduleId: schedule.id });
      expect(thread.cwd).toBe(`${workspace.rootPath}/${thread.id}`);
      const turns = await eventually(() => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id))), (rows) => rows[0]?.status === "completed");
      expect(turns[0]?.status).toBe("completed");
      cwds.push(thread.cwd);
      at = current.nextRunAt ?? timestampFromDate(new Date());
    }
    expect(new Set(cwds).size).toBe(2);
  });

  test("system projects and worker placements remain isolated by owner", async () => {
    const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other-scratch@test", "Other")));
    const projects = await gw.runtime.runPromise(GatewayStore.use((s) => s.listProjects(other)));
    expect(projects[0]?.id).not.toBe(project.id);
    expect(projects[0]?.workspaces).toEqual([]);
    const denied = await gw.runtime.runPromiseExit(GatewayStore.use((s) => s.createThread(other, create(ui.CreateThreadRequestSchema, { projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX }))));
    expect(denied._tag).toBe("Failure");
  });
});
