import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { qualifyId } from "./computers.ts";
import {
  replaceComputerProjects,
  replaceComputerRows,
  retainLinkedRows,
  retainProjects,
  upsertLinkedRows,
} from "./linked-snapshot.ts";
import { projectChoices } from "./projects.ts";

const nodeId = "abcdef0123456789abcdef0123456789";
const computers = [create(ui.LinkedComputerSchema, { nodeId })];
const workerId = qualifyId("11111111-1111-4111-8111-111111111111", nodeId);
const projectId = qualifyId("22222222-2222-4222-8222-222222222222", nodeId);
const workspace = create(ui.WorkspaceSchema, { id: "workspace", projectId, workerId });
const remote = create(ui.ProjectSchema, { id: projectId, nodeId, name: "Example", workspaces: [workspace] });

describe("linked overview identity across snapshots", () => {
  test("aggregate snapshots and retained rows contain each stable id once", () => {
    const worker = create(ui.WorkerSchema, { id: workerId, nodeId });
    const renamed = create(ui.WorkerSchema, { ...worker, name: "Updated worker" });
    expect(retainLinkedRows([], [worker, renamed], computers)).toEqual([renamed]);
    expect(retainLinkedRows([worker, renamed], [], computers)).toEqual([renamed]);
    expect(retainProjects([], [remote, remote], computers)).toEqual([remote]);
    expect(retainProjects([remote, remote], [], computers)).toEqual([remote]);
  });

  test("one directory on one computer remains one choice while its configuration is replicated", () => {
    const globalId = "shared-project";
    const own = create(ui.ProjectSchema, { id: "local-replica", globalId, name: "Example" });
    const peer = create(ui.ProjectSchema, { ...remote, globalId });
    const scratch = create(ui.ProjectSchema, { id: "scratch", kind: "scratch", name: "No project" });
    const peerScratch = create(ui.ProjectSchema, { ...scratch, id: "peer-scratch", nodeId });
    const choices = projectChoices(retainProjects([], [scratch, peer, peerScratch, own, peer], computers));
    expect(choices).toHaveLength(2);
    const project = choices.find((choice) => choice.kind !== "scratch")!;
    expect(project.projectIds).toEqual([own.id, peer.id]);
    expect(project.workspaces).toEqual([workspace]);
    expect(choices.filter((choice) => choice.kind === "scratch")).toHaveLength(1);

    // The aggregate now includes the peer workspace under a local alias, while retention keeps the old peer id.
    const currentWorkspace = create(ui.WorkspaceSchema, { ...workspace, rootPath: "/repo/current" });
    const aggregate = create(ui.ProjectSchema, { ...own, workspaces: [currentWorkspace] });
    const refreshed = projectChoices(retainProjects([peer], [aggregate], computers));
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.workspaces).toEqual([currentWorkspace]);
  });

  test("partial refreshes keep incoming workspace order ahead of retained peer workspaces", () => {
    const local = create(ui.WorkspaceSchema, { id: "local-workspace", workerId: "local-worker", projectId });
    const previous = create(ui.ProjectSchema, { ...remote, nodeId: "", workspaces: [local, workspace, workspace] });
    const incoming = create(ui.ProjectSchema, { ...previous, workspaces: [local, local] });
    const retained = retainProjects([previous], [incoming], computers);

    expect(retained[0]?.workspaces).toEqual([local, workspace]);
    expect(retainProjects([previous], [incoming], [])[0]?.workspaces).toEqual([local]);
    expect(previous.workspaces).toEqual([local, workspace, workspace]);
  });

  test("replayed home snapshots and legacy upserts keep shared projects and reconcile deletions", () => {
    const own = create(ui.WorkspaceSchema, { id: "own-workspace", workerId: "own-worker", projectId: "shared" });

    const other = create(ui.WorkspaceSchema, {
      id: "other-workspace",
      workerId: "worker~0123456789abcdef",
      projectId: "shared",
    });

    const peerWorkspace = create(ui.WorkspaceSchema, { ...workspace, projectId: "shared" });

    const shared = create(ui.ProjectSchema, {
      id: "shared",
      name: "Local name",
      workspaces: [own, other, peerWorkspace],
    });

    const peerShared = create(ui.ProjectSchema, {
      ...shared,
      nodeId,
      name: "Peer name",
      workspaces: [peerWorkspace, peerWorkspace],
    });

    const sharedChoices = projectChoices([shared, peerShared, peerShared]);
    expect(sharedChoices).toHaveLength(1);
    expect(sharedChoices[0]?.projectIds).toEqual(["shared"]);
    expect(sharedChoices[0]?.workspaces).toEqual([own, other, peerWorkspace]);

    const removed = create(ui.ProjectSchema, { id: "removed", nodeId });
    let projects = [shared, remote, removed];
    let workers = [create(ui.WorkerSchema, { id: "own-worker" }), create(ui.WorkerSchema, { id: "removed", nodeId })];
    const worker = create(ui.WorkerSchema, { id: workerId, nodeId });

    for (let reconnect = 0; reconnect < 3; reconnect++) {
      projects = replaceComputerProjects(projects, [peerShared, remote, remote], nodeId);
      workers = replaceComputerRows(workers, [worker, worker], nodeId);
      // Gateways also emit individual updates for clients predating computer_snapshot.
      projects = upsertLinkedRows(projects, [remote]);
      workers = upsertLinkedRows(workers, [worker]);
      expect(projects.map((project) => project.id)).toEqual(["shared", projectId]);
      expect(projects[0]?.name).toBe("Local name");
      expect(projects[0]?.workspaces).toEqual([own, other, peerWorkspace]);
      expect(workers.map((worker) => worker.id)).toEqual(["own-worker", workerId]);
    }

    const empty = replaceComputerProjects(projects, [], nodeId);
    expect(empty.map((project) => project.id)).toEqual(["shared"]);
    expect(empty[0]?.workspaces).toEqual([own, other]);
    expect(shared.workspaces).toEqual([own, other, peerWorkspace]);
    expect(retainProjects(projects, [shared], computers)[0]?.workspaces).toEqual(shared.workspaces);
  });
});
