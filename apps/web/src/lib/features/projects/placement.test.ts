import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@open-agents/contracts";
import { baseName, defaultProject, defaultWorkspace, workspacesByWorker } from "./placement.ts";

const ws = (id: string, projectId: string, workerId: string) => create(ui.WorkspaceSchema, { id, projectId, workerId, rootPath: `/code/${id}` });
const alpha = create(ui.ProjectSchema, { id: "alpha", name: "Alpha", workspaces: [ws("a1", "alpha", "laptop"), ws("a2", "alpha", "server")] });
const beta = create(ui.ProjectSchema, { id: "beta", name: "Beta", workspaces: [ws("b1", "beta", "server")] });
const empty = create(ui.ProjectSchema, { id: "empty", name: "Empty", workspaces: [] });
const thread = (id: string, projectId: string, workspaceId: string, ms: number, extra: { spawnedByAgent?: boolean; parentThreadId?: string } = {}) =>
  create(ui.ThreadSchema, { id, projectId, workspaceId, createdAt: timestampFromMs(ms), ...extra });

describe("new thread placement", () => {
  test("No project works without a regular project, and preserves explicit/default/recent choices", () => {
    const scratch = create(ui.ProjectSchema, { id: "scratch", name: "No project", kind: "scratch", workspaces: [ws("s1", "scratch", "laptop"), ws("s2", "scratch", "server")] });
    const projects = [scratch, alpha];
    expect(defaultProject({ projects, threads: [] })).toBe(scratch);
    expect(defaultProject({ projects: [scratch], threads: [] })).toBe(scratch);
    expect(defaultProject({ projects, threads: [], requested: alpha.id })).toBe(alpha);
    expect(defaultProject({ projects, threads: [], defaultWorkspaceId: "s2" })).toBe(scratch);
    expect(defaultProject({ projects, threads: [thread("t", "scratch", "s2", 10)] })).toBe(scratch);
    expect(defaultWorkspace({ project: scratch, threads: [], defaultWorkspaceId: "s2", online: () => false })?.workerId).toBe("server");
    expect(defaultWorkspace({ project: scratch, threads: [], online: (id) => id === "server" })?.id).toBe("s2");
  });
  test("project: requested, then your default workspace's, then last used, then the first with a worker", () => {
    const projects = [empty, alpha, beta];
    const threads = [thread("t1", "alpha", "a1", 1), thread("t2", "beta", "b1", 2)];
    expect(defaultProject({ projects, threads, requested: "empty", defaultWorkspaceId: "a1" })?.id).toBe("empty");
    expect(defaultProject({ projects, threads, requested: "gone", defaultWorkspaceId: "a2" })?.id).toBe("alpha");
    expect(defaultProject({ projects, threads })?.id).toBe("beta");
    // Side threads and agents' threads are not "yours".
    const spawned = [...threads, thread("t3", "alpha", "a1", 3, { spawnedByAgent: true }), thread("t4", "alpha", "a1", 4, { parentThreadId: "t1" })];
    expect(defaultProject({ projects, threads: spawned })?.id).toBe("beta");
    expect(defaultProject({ projects, threads: [] })?.id).toBe("alpha");
    expect(defaultProject({ projects: [empty], threads: [] })?.id).toBe("empty");
    expect(defaultProject({ projects: [], threads: [] })).toBeUndefined();
  });

  test("worker: the default workspace, then last used in the project, then the first online", () => {
    const online = (id: string) => id === "server";
    const threads = [thread("t1", "alpha", "a1", 5), thread("t2", "beta", "b1", 9)];
    expect(defaultWorkspace({ project: alpha, threads, defaultWorkspaceId: "a2", online })?.id).toBe("a2");
    // A default from another project does not apply.
    expect(defaultWorkspace({ project: alpha, threads, defaultWorkspaceId: "b1", online })?.id).toBe("a1");
    expect(defaultWorkspace({ project: alpha, threads: [], online })?.id).toBe("a2");
    expect(defaultWorkspace({ project: alpha, threads: [], online: () => false })?.id).toBe("a1");
    // A removed workspace (no longer listed) is skipped.
    expect(defaultWorkspace({ project: alpha, threads: [thread("t3", "alpha", "gone", 10)], online })?.id).toBe("a2");
    expect(defaultWorkspace({ project: empty, threads, online })).toBeUndefined();
  });

  test("helpers", () => {
    const two = create(ui.ProjectSchema, { id: "p", workspaces: [ws("x", "p", "w1"), ws("y", "p", "w2"), ws("z", "p", "w1")] });
    expect(workspacesByWorker(two).map((g) => [g.workerId, g.workspaces.map((w) => w.id)])).toEqual([
      ["w1", ["x", "z"]],
      ["w2", ["y"]],
    ]);
    expect([baseName("/home/me/app/"), baseName("C:\\code\\app"), baseName("/")]).toEqual(["app", "app", "/"]);
  });
});
