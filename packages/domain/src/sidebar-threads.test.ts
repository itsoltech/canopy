import { describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { projectChoices } from "./projects.ts";
import { changesArchived, indexChangesArchived } from "./archived-threads.ts";
import { sidebarEntries } from "./sidebar-entries.ts";
import { sameSidebarRow, sidebarRows } from "./sidebar-rows.ts";
import {
  collapsedArchivedThread,
  isArchivedSidebarThread,
  sidebarChildren,
  sidebarThreads,
} from "./sidebar-threads.ts";

const thread = (id: string, patch: MessageInitShape<typeof ui.ThreadSchema> = {}) =>
  create(ui.ThreadSchema, {
    id,
    title: id,
    projectId: "project",
    status: "idle",
    createdAt: timestampFromMs(1000),
    ...patch,
  });

const settings = (patch: MessageInitShape<typeof ui.SidebarSettingsSchema> = {}) =>
  create(ui.SidebarSettingsSchema, patch);

const projectName = (id: string) => (id === "project" ? "Canopy" : "Other");
const ids = (threads: readonly ui.Thread[]) => threads.map((t) => t.id);

describe("shared sidebar trees", () => {
  test("subagents never become roots, even pinned or missing their parent; user sides remain discoverable", () => {
    const rows = [
      thread("parent"),
      thread("side", { parentThreadId: "parent" }),
      thread("finished", { parentThreadId: "parent", spawnedByAgent: true, unseenResult: "completed" }),
      thread("orphan-agent", { parentThreadId: "missing", spawnedByAgent: true }),
      thread("orphan-side", { parentThreadId: "missing" }),
    ];

    const filtered = sidebarThreads(rows, settings({ pinnedThreadIds: ["finished", "orphan-agent"] }), "", projectName);

    expect(ids(filtered.roots)).toEqual(["parent", "orphan-side"]);
    expect(ids(sidebarChildren(filtered.sides.get("parent") ?? []).sides.active)).toEqual(["side"]);
  });

  test("search matches a parent through side titles, including archived sides and subagents, never cwd", () => {
    const rows = [
      thread("parent", { cwd: "/needle" }),
      thread("side", { title: "Needle review", parentThreadId: "parent", status: "archived" }),
      thread("subagent", { title: "Agent result", parentThreadId: "parent", spawnedByAgent: true }),
    ];

    expect(ids(sidebarThreads(rows, settings(), " NEEDLE ", projectName).roots)).toEqual(["parent"]);
    expect(ids(sidebarThreads(rows, settings(), "AGENT RESULT", projectName).roots)).toEqual(["parent"]);
    expect(ids(sidebarThreads(rows, settings(), "canopy", projectName).roots)).toEqual(["parent"]);
    expect(sidebarThreads([rows[0]!], settings(), "needle", projectName).roots).toEqual([]);
    expect(sidebarThreads(rows, settings({ projectIds: ["other"] }), "needle", projectName).roots).toEqual([]);
  });

  test("pins are flat roots once, and an archived parent suppresses its side roots during cascade", () => {
    const rows = [
      thread("parent"),
      thread("pinned-side", { parentThreadId: "parent" }),
      thread("archived", { status: "archived" }),
      thread("late-side", { parentThreadId: "archived" }),
    ];

    const filtered = sidebarThreads(rows, settings({ pinnedThreadIds: ["pinned-side", "late-side"] }), "", projectName);

    expect(ids(filtered.roots)).toEqual(["pinned-side", "parent"]);
    expect(sidebarChildren(filtered.sides.get("parent") ?? [], new Set(ids(filtered.roots))).sides.active).toEqual([]);
  });

  test("only questions routed to the user surface on the parent, once per subagent", () => {
    const rows = [
      thread("parent", { status: "running" }),
      thread("user-question", {
        parentThreadId: "parent",
        spawnedByAgent: true,
        status: "waiting_input",
        pendingInteractions: 3,
      }),
      thread("agent-question", {
        parentThreadId: "parent",
        spawnedByAgent: true,
        status: "waiting_input",
        interactionRoute: "parent",
      }),
      thread("deleted-question", {
        parentThreadId: "parent",
        spawnedByAgent: true,
        status: "waiting_input",
        deletedAt: { seconds: 2n },
      }),
    ];

    const filtered = sidebarThreads(rows, settings({ workingSection: true, groupByProject: true }), "", projectName);
    const children = sidebarChildren(filtered.sides.get("parent") ?? []);
    const entries = sidebarEntries(filtered, settings({ workingSection: true, groupByProject: true }), [], true);

    expect(ids(children.subagentsNeedingInput)).toEqual(["user-question"]);
    expect(children.sides.active).toEqual([]);
    expect(entries.map((e) => e.heading ?? e.thread?.id)).toEqual(["Needs attention", "parent"]);
  });

  test("working, pinned and project sections are disjoint and use whole-tree activity", () => {
    const rows = [
      thread("working", { status: "running" }),
      thread("pinned", { status: "running" }),
      thread("calm-child", {
        parentThreadId: "working",
        spawnedByAgent: true,
        status: "waiting_input",
        interactionRoute: "parent",
      }),
      thread("result-parent"),
      thread("result", { parentThreadId: "result-parent", spawnedByAgent: true, unseenResult: "completed" }),
      thread("old-parent"),
      thread("recent-side", { parentThreadId: "old-parent", lastActivityAt: { seconds: 100n } }),
    ];

    const prefs = settings({ workingSection: true, pinnedThreadIds: ["pinned"], groupByProject: true });
    const filtered = sidebarThreads(rows, prefs, "", projectName);
    const projects = projectChoices([create(ui.ProjectSchema, { id: "project", name: "Canopy" })]);
    const entries = sidebarEntries(filtered, prefs, projects, true);

    expect(entries.map((e) => e.heading ?? e.thread?.id)).toEqual([
      "Pinned",
      "pinned",
      "Needs attention",
      "result-parent",
      "Canopy",
      "old-parent",
      "Working (1)",
      "working",
    ]);
    expect(sidebarEntries(filtered, prefs, projects, false).filter((e) => e.thread?.id === "working")).toEqual([]);
  });

  test("archived current threads respect filters and active parents; archived sides stay in Previous agents", () => {
    const parent = thread("parent");
    const side = thread("side", { parentThreadId: "parent", status: "archived", archivedAt: { seconds: 2n } });
    const archived = thread("archived", { status: "archived" });
    const subagent = thread("subagent", { parentThreadId: "archived", spawnedByAgent: true, status: "archived" });
    const all = new Map([parent, side, archived, subagent].map((t) => [t.id, t]));

    expect(collapsedArchivedThread(side, false, all, [], "", projectName)).toBeUndefined();
    expect(collapsedArchivedThread(archived, false, all, [], "canopy", projectName)).toBe(archived);
    expect(collapsedArchivedThread(archived, true, all, [], "", projectName)).toBeUndefined();
    expect(collapsedArchivedThread(archived, false, all, ["other"], "", projectName)).toBeUndefined();
    expect(collapsedArchivedThread(subagent, false, all, [], "", projectName)).toBeUndefined();
    expect(ids([archived, subagent].filter(isArchivedSidebarThread))).toEqual(["archived"]);
    expect(ids(sidebarChildren([side]).sides.previous)).toEqual(["side"]);
  });
});

describe("live sidebar updates", () => {
  const lookup = { project: () => undefined, worker: () => undefined };

  const rowsOf = (rows: ui.Thread[], open?: string) => {
    const filtered = sidebarThreads(rows, settings(), "", projectName);

    return sidebarRows(sidebarEntries(filtered, settings(), [], false), filtered, open, lookup);
  };

  test("a rebuilt index keeps unchanged rows equal; the changed thread, its tree and the open tree differ", () => {
    const rows = [thread("a"), thread("b"), thread("side", { parentThreadId: "b" })];
    const before = rowsOf(rows);
    const after = rowsOf([rows[0]!, create(ui.ThreadSchema, { ...rows[1]!, status: "running" }), rows[2]!]);
    const changed = after.filter((row, at) => !sameSidebarRow(before[at]!, row)).map((row) => row.key);

    expect(after.map((row) => row.key)).toEqual(before.map((row) => row.key));
    expect(changed).toEqual(["b"]);

    const side = create(ui.ThreadSchema, { ...rows[2]!, title: "Renamed" });
    const sideChanged = rowsOf([rows[0]!, rows[1]!, side]).filter((row, at) => !sameSidebarRow(before[at]!, row));
    expect(sideChanged.map((row) => row.key)).toEqual(["b"]);

    const opened = rowsOf(rows, "b").filter((row, at) => !sameSidebarRow(before[at]!, row));
    expect(opened.map((row) => [row.key, row.open])).toEqual([["b", true]]);
  });

  test("only updates that can reach the archive refresh its pages", () => {
    const active = thread("active", { status: "running" });
    const archived = thread("archived", { status: "archived" });
    const side = thread("side", { parentThreadId: "archived" });
    const index = new Map([active, archived, side].map((t) => [t.id, t]));
    const known = (id: string) => index.get(id);

    const update = (base: ui.Thread, patch: Partial<ui.Thread>): ui.Thread => ({ ...base, ...patch });

    expect(changesArchived(update(active, { status: "idle", title: "Renamed" }), known)).toBe(false);
    expect(changesArchived(update(active, { status: "archived" }), known)).toBe(true);
    expect(changesArchived(update(archived, { status: "idle" }), known)).toBe(true);
    expect(changesArchived(update(archived, { title: "Renamed" }), known)).toBe(true);
    expect(changesArchived(update(side, { status: "running" }), known)).toBe(true);
    expect(changesArchived(thread("restored-or-new"), known)).toBe(true);
    expect(changesArchived(update(active, { deletedAt: timestampFromMs(2000) }), known)).toBe(true);

    const list = [...index.values()];
    expect(indexChangesArchived(index, list)).toBe(false);
    expect(indexChangesArchived(index, [update(active, { status: "idle" }), archived, side])).toBe(false);
    expect(indexChangesArchived(index, [active, update(archived, { title: "Renamed" }), side])).toBe(true);
    expect(indexChangesArchived(index, [active, archived])).toBe(true);
    expect(indexChangesArchived(index, [...list, thread("new")])).toBe(true);
  });
});
