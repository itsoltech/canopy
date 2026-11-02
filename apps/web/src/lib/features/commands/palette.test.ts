import { describe, expect, test } from "bun:test";
import { fuzzyMatch, matchCommand } from "./fuzzy.ts";
import { actionOf, enterLevel, flatEntries, leaveLevel, levelCommands, moveActive, paletteView } from "./palette.ts";
import { CommandRegistry, type Command } from "./registry.ts";

const titles = (commands: readonly { command: Command }[]) => commands.map((e) => e.command.title);
const rank = (query: string, items: string[]) =>
  items
    .map((title) => ({ title, match: fuzzyMatch(query, title) }))
    .filter((r) => r.match)
    .sort((a, b) => b.match!.score - a.match!.score)
    .map((r) => r.title);

describe("fuzzy matching", () => {
  test("matches the query's characters in order, case-insensitively, and returns their positions", () => {
    expect(fuzzyMatch("nt", "New thread")?.indices).toEqual([0, 4]);
    expect(fuzzyMatch("THEME", "Change theme")?.indices).toEqual([7, 8, 9, 10, 11]);
    expect(fuzzyMatch("tn", "New thread")).toBeUndefined();
    expect(fuzzyMatch("xyz", "New thread")).toBeUndefined();
    // Scattered over the insides of words: not a match.
    expect(fuzzyMatch("ocean", "navigation collapse expand hide show")).toBeUndefined();
    expect(fuzzyMatch("e", "New thread")).toBeUndefined();
    expect(fuzzyMatch("t", "New thread")?.indices).toEqual([4]);
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });

  test("word starts and runs rank above scattered matches", () => {
    expect(rank("nt", ["Interrupt", "New thread", "Print"])).toEqual(["New thread", "Interrupt", "Print"]);
    expect(rank("set", ["Settings", "Reset goal", "Change theme… sets"])[0]).toBe("Settings");
    expect(rank("cw", ["Chat width", "Copy working directory", "Crow"]).slice(0, 2).sort()).toEqual(["Chat width", "Copy working directory"]);
    expect(rank("tog", ["Toggle sidebar", "Photographs"])).toEqual(["Toggle sidebar", "Photographs"]);
  });

  test("prefers the word-start positions for highlighting", () => {
    // "sb" in "Toggle sidebar": the s of sidebar, then its b.
    expect(fuzzyMatch("sb", "Toggle sidebar")?.indices).toEqual([7, 11]);
    // "ct" in "Copy thread link": C at 0, t at the start of "thread".
    expect(fuzzyMatch("ct", "Copy thread link")?.indices).toEqual([0, 5]);
  });

  test("every word must match the title or the keywords; only title matches highlight", () => {
    const item = { title: "Fix the login bug", keywords: "open-agents laptop" };
    expect(matchCommand("login laptop", item)?.indices).toEqual([8, 9, 10, 11, 12]);
    expect(matchCommand("login nowhere", item)).toBeUndefined();
    expect(matchCommand("laptop", item)?.indices).toEqual([]);
  });
});

const command = (id: string, extra: Partial<Command> = {}): Command => ({ id, title: id, group: "actions", ...extra });

describe("registry", () => {
  test("lists the sources in order and only commands whose `when` holds", () => {
    const registry = new CommandRegistry();
    let onThread = false;
    registry.add(() => [command("New thread"), command("Toggle sidebar")]);
    const remove = registry.add(() => [command("Interrupt", { when: () => onThread })]);
    expect(registry.list().map((c) => c.id)).toEqual(["New thread", "Toggle sidebar"]);
    onThread = true;
    expect(registry.list().map((c) => c.id)).toEqual(["New thread", "Toggle sidebar", "Interrupt"]);
    remove();
    expect(registry.list().map((c) => c.id)).toEqual(["New thread", "Toggle sidebar"]);
  });
});

describe("palette view", () => {
  const themes = command("Change theme", {
    searchChildren: true,
    children: () => [command("Default", { checked: true }), command("Ocean"), command("Hidden", { when: () => false })],
  });
  const commands: Command[] = [
    command("Toggle sidebar"),
    command("New thread in Alpha", { rank: -10 }),
    themes,
    ...Array.from({ length: 12 }, (_, i) => command(`Thread ${i}`, { group: "threads", keywords: i === 3 ? "beta laptop" : "alpha" })),
    command("Alpha", { group: "projects", suggested: false }),
    command("Appearance", { group: "settings" }),
  ];

  test("empty query: suggested commands by group order and rank, recent threads limited", () => {
    const sections = paletteView(commands, "");
    expect(sections.map((s) => s.label)).toEqual(["Actions", "Recent threads", "Settings"]);
    expect(titles(sections[0]!.entries)).toEqual(["New thread in Alpha", "Toggle sidebar", "Change theme"]);
    expect(sections[1]!.entries).toHaveLength(8);
  });

  test("search: groups keep their order, rows rank by score, submenu entries are found with their parent", () => {
    const sections = paletteView(commands, "ocean");
    expect(sections.map((s) => s.group)).toEqual(["actions"]);
    expect(sections[0]!.entries[0]!.parent?.id).toBe("Change theme");
    expect(sections[0]!.entries[0]!.key).toBe("Change theme/Ocean");
    // Only by their own title: the parent's name alone does not list them.
    expect(titles(flatEntries(paletteView(commands, "change theme")))).toEqual(["Change theme"]);
    expect(flatEntries(paletteView(commands, "theme ocean")).map((e) => e.key)).toEqual(["Change theme/Ocean"]);
    // A hidden child (its `when` fails) is not found.
    expect(flatEntries(paletteView(commands, "hidden"))).toHaveLength(0);
    // Threads are found by their keywords (project, worker) too.
    expect(titles(flatEntries(paletteView(commands, "laptop")))).toEqual(["Thread 3"]);
    // Projects appear only when searched.
    expect(paletteView(commands, "alp").map((s) => s.group)).toEqual(["actions", "threads", "projects"]);
  });

  test("submenus: enter, list the available children, go back restoring the query", () => {
    let stack = enterLevel([], themes, "the");
    expect(levelCommands(commands, stack).map((c) => c.id)).toEqual(["Default", "Ocean"]);
    const nested = paletteView(levelCommands(commands, stack), "", { nested: true });
    expect(nested).toHaveLength(1);
    expect(nested[0]!.label).toBeUndefined();
    expect(titles(paletteView(levelCommands(commands, stack), "oc", { nested: true })[0]!.entries)).toEqual(["Ocean"]);
    const up = leaveLevel(stack);
    stack = up.stack;
    expect(stack).toEqual([]);
    expect(up.query).toBe("the");
    expect(levelCommands(commands, stack)).toBe(commands);
    expect(leaveLevel([])).toEqual({ stack: [], query: "" });
  });

  test("choosing: submenus enter, runnable commands run, disabled ones do nothing", () => {
    expect(actionOf(themes)).toBe("enter");
    expect(actionOf(command("Go", { href: "/settings" }))).toBe("run");
    expect(actionOf(command("Run", { run: () => {} }))).toBe("run");
    expect(actionOf(command("Muted", { run: () => {}, disabled: true }))).toBe("none");
  });

  test("keyboard movement: arrows wrap, pages and Home/End stop at the ends", () => {
    expect(moveActive(4, "next", 5)).toBe(0);
    expect(moveActive(0, "previous", 5)).toBe(4);
    expect(moveActive(-1, "next", 5)).toBe(0);
    expect(moveActive(2, "pageDown", 5)).toBe(4);
    expect(moveActive(2, "pageUp", 5)).toBe(0);
    expect(moveActive(2, "first", 5)).toBe(0);
    expect(moveActive(2, "last", 5)).toBe(4);
    expect(moveActive(0, "next", 0)).toBe(-1);
  });
});
