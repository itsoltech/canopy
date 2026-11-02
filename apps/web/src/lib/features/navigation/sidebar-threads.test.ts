import { describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { collapsedArchivedThread, sidebarThreads } from "./sidebar-threads.ts";
import { groupSideThreads } from "../threads/thread-tree.ts";
import { threadActions } from "../threads/thread-actions.ts";

const thread = (id: string, change: Omit<MessageInitShape<typeof ui.ThreadSchema>, "$typeName"> = {}) => create(ui.ThreadSchema, {
  id, projectId: "a", title: id, status: "idle", kind: ui.ThreadKind.MAIN, createdAt: { seconds: 1n }, ...change,
});
const settings = (change: MessageInitShape<typeof ui.SidebarSettingsSchema> = {}) => create(ui.SidebarSettingsSchema, change);
const names = (id: string) => id === "a" ? "Alpha" : "Beta";

describe("sidebar visibility and ordering", () => {
  test("multi-project filter encloses title, project and side-thread search", () => {
    const all = [thread("parent"), thread("match", { kind: ui.ThreadKind.SIDE, parentThreadId: "parent" }), thread("other", { projectId: "b" })];
    expect(sidebarThreads(all, settings({ projectIds: ["a"] }), "match", names).roots.map((t) => t.id)).toEqual(["parent"]);
    expect(sidebarThreads(all, settings({ projectIds: ["b"] }), "match", names).roots).toEqual([]);
    expect(sidebarThreads(all, settings({ projectIds: ["a", "b"] }), "Beta", names).roots.map((t) => t.id)).toEqual(["other"]);
    expect(sidebarThreads(all, settings(), "", names).roots).toHaveLength(2);
  });

  test("pins precede attention and activity; a pinned side is independently reachable", () => {
    const all = [thread("new", { createdAt: { seconds: 10n } }), thread("attention", { status: "waiting_input" }), thread("old"), thread("side", { kind: ui.ThreadKind.SIDE, parentThreadId: "old" })];
    const result = sidebarThreads(all, settings({ pinnedThreadIds: ["side", "old"] }), "", names);
    expect(result.roots.map((t) => t.id)).toEqual(["old", "side", "attention", "new"]);
    expect(sidebarThreads(all, settings({ projectIds: ["b"], pinnedThreadIds: ["side"] }), "", names).roots).toEqual([]);
  });

  test("archived trees never leak sides into active roots, even when pinned or waiting for cascade events", () => {
    const all = [thread("archived", { status: "archived" }), thread("side", { parentThreadId: "archived" }), thread("deleted", { deletedAt: { seconds: 5n } })];
    expect(sidebarThreads(all, settings(), "", names).roots).toEqual([]);
    expect(sidebarThreads(all, settings({ pinnedThreadIds: ["side"] }), "", names).roots).toEqual([]);
    expect(sidebarThreads([thread("orphan", { parentThreadId: "unloaded" })], settings(), "", names).roots.map((t) => t.id)).toEqual(["orphan"]);
    expect(sidebarThreads(all, settings({ archived: true }), "", names).roots).toEqual([]); // old view setting is ignored
  });

  test("collapsed current archive respects project/search, expansion and Previous agents grouping", () => {
    const parent = thread("parent");
    const archived = thread("archived", { status: "archived" });
    const side = thread("side", { parentThreadId: parent.id, status: "archived" });
    const all = new Map([parent, archived, side].map((t) => [t.id, t]));
    const show = (current: ui.Thread | undefined, expanded = false, projects: string[] = [], q = "") => collapsedArchivedThread(current, expanded, all, projects, q, names);
    expect(show(archived)?.id).toBe("archived");
    expect(show(archived, true)).toBeUndefined();
    expect(show(parent)).toBeUndefined();
    expect(show(undefined)).toBeUndefined();
    expect(show(side)).toBeUndefined();
    expect(show(archived, false, ["b"])).toBeUndefined();
    expect(show(archived, false, [], "Beta")).toBeUndefined();
    expect(show(archived, false, [], "Alpha")?.id).toBe("archived");
    all.set("parent", { ...parent, status: "archived" });
    expect(show(side)?.id).toBe("side");
  });

  test("Previous agents contains archived children only, newest archive first", () => {
    const grouped = groupSideThreads([thread("active"), thread("earlier", { status: "archived", archivedAt: { seconds: 2n } }), thread("later", { status: "archived", archivedAt: { seconds: 3n } }), thread("deleted", { status: "archived", deletedAt: { seconds: 4n } })]);
    expect(grouped.active.map((t) => t.id)).toEqual(["active"]);
    expect(grouped.previous.map((t) => t.id)).toEqual(["later", "earlier"]);
    expect(groupSideThreads(grouped.previous).active).toEqual([]);
  });

  test("menu availability follows unread, title generation, pin and archive state", () => {
    const active = threadActions(thread("a", { lastSeq: 1n }), "Alpha", false);
    expect(active.find((a) => a.id === "read")?.label).toBe("Mark as unread");
    expect(active.find((a) => a.id === "regenerate")?.disabled).toBe(false);
    const archived = threadActions(thread("a", { status: "archived", markedUnread: true }), "Alpha", true);
    expect(archived.find((a) => a.id === "archive")?.label).toBe("Unarchive");
    expect(archived.find((a) => a.id === "pin")?.label).toBe("Unpin thread");
    expect(archived.find((a) => a.id === "read")?.label).toBe("Mark as read");
    expect(archived.filter((a) => a.disabled).map((a) => a.id)).toEqual(["rename", "regenerate"]);
    expect(threadActions(thread("a", { titleGenerating: true }), "Alpha", false).find((a) => a.id === "regenerate")?.disabled).toBe(true);
    expect(threadActions(thread("a", { deletedAt: { seconds: 1n } }), "Alpha", false)).toEqual([]);
  });
});
