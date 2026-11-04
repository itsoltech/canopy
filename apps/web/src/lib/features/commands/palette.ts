import { matchCommand } from "./fuzzy.ts";
import { childrenOf, commandGroups, groupLabels, type Command, type CommandGroup } from "./registry.ts";

/**
 * What the command palette lists for a query, and how its submenus nest. Pure, so the ranking and the
 * navigation are tested without a DOM (palette.test.ts); CommandPalette.svelte renders it.
 */

/** One listed row: the command, the submenu it comes from when found from the top level, the highlight. */
export interface PaletteEntry {
  readonly key: string;
  readonly command: Command;
  readonly parent?: Command | undefined;
  /** Matched positions of the title. */
  readonly indices: readonly number[];
}

export interface PaletteSection {
  /** No group inside a submenu (one unlabeled list). */
  readonly group?: CommandGroup | undefined;
  readonly label?: string | undefined;
  readonly entries: readonly PaletteEntry[];
}

/** How many rows a group shows at most: on an empty query (`suggested`) and while searching. */
export interface PaletteLimits {
  readonly suggested: Partial<Record<CommandGroup, number>>;
  readonly search: Partial<Record<CommandGroup, number>>;
}

export const defaultLimits: PaletteLimits = {
  suggested: { threads: 8 },
  search: { threads: 30, projects: 10 },
};

const byRank = (commands: readonly Command[]) =>
  commands
    .map((command, index) => ({ command, index }))
    .sort((a, b) => (a.command.rank ?? 0) - (b.command.rank ?? 0) || a.index - b.index);

/**
 * Sections for `query` over `commands` (the available ones of a level). At the top level the groups
 * keep their order (Actions, Recent threads, Projects, Settings); inside a submenu (`nested`) it is one
 * list. Searching ranks by score inside each group and also finds the entries of `searchChildren`
 * submenus whose own title matches, labelled with their parent.
 */
export function paletteView(
  commands: readonly Command[],
  query: string,
  { nested = false, limits = defaultLimits }: { nested?: boolean; limits?: PaletteLimits } = {},
): PaletteSection[] {
  const q = query.trim();

  if (!q) {
    const entries = byRank(nested ? commands : commands.filter((c) => c.suggested !== false)).map(({ command }) => ({
      key: command.id,
      command,
      indices: [],
    }));

    return sectioned(entries, nested, limits.suggested);
  }

  const candidates: { command: Command; parent?: Command }[] = commands.map((command) => ({ command }));

  if (!nested) {
    for (const parent of commands)
      if (parent.searchChildren) for (const command of childrenOf(parent)) candidates.push({ command, parent });
  }

  const scored = candidates
    .map((candidate, index) => {
      const match = matchCommand(q, {
        title: candidate.command.title,
        keywords: [candidate.parent?.title, candidate.command.keywords].filter(Boolean).join(" "),
      });

      // A submenu's entry needs its own name in the query ("ocean", "theme ocean"), not just the parent's.
      if (!match || (candidate.parent && match.indices.length === 0)) return undefined;

      return { ...candidate, match, index };
    })
    .filter((s) => s !== undefined)
    .sort(
      (a, b) => b.match.score - a.match.score || (a.command.rank ?? 0) - (b.command.rank ?? 0) || a.index - b.index,
    );

  const entries = scored.map(({ command, parent, match }) => ({
    key: parent ? `${parent.id}/${command.id}` : command.id,
    command,
    parent,
    indices: match.indices,
  }));

  return sectioned(entries, nested, limits.search);
}

function sectioned(entries: PaletteEntry[], nested: boolean, limits: PaletteLimits["suggested"]): PaletteSection[] {
  if (nested) return entries.length > 0 ? [{ entries }] : [];

  return commandGroups
    .map((group) => {
      const inGroup = entries.filter((e) => (e.parent ?? e.command).group === group);
      const limit = limits[group];

      return { group, label: groupLabels[group], entries: limit === undefined ? inGroup : inGroup.slice(0, limit) };
    })
    .filter((section) => section.entries.length > 0);
}

/** The rows of the sections in order (the listbox's options; the active one is an index into it). */
export const flatEntries = (sections: readonly PaletteSection[]): PaletteEntry[] => sections.flatMap((s) => s.entries);

// --- Submenus ----------------------------------------------------------------------------------------

/** A submenu entered, with the query the level above had (restored on the way back). */
export interface PaletteLevel {
  readonly command: Command;
  readonly query: string;
}

export const enterLevel = (stack: readonly PaletteLevel[], command: Command, query: string): PaletteLevel[] => [
  ...stack,
  { command, query },
];

export interface LeftLevel {
  stack: PaletteLevel[];
  query: string;
}

/** One level up: the stack without the last submenu and the query to restore. */
export function leaveLevel(stack: readonly PaletteLevel[]): LeftLevel {
  return { stack: stack.slice(0, -1), query: stack.at(-1)?.query ?? "" };
}

/** The commands of the current level: the top level's, or the open submenu's available entries. */
export const levelCommands = (top: readonly Command[], stack: readonly PaletteLevel[]): readonly Command[] => {
  const open = stack.at(-1);

  return open ? childrenOf(open.command) : top;
};

/** What choosing a command does: open its submenu, run it (or follow its link), or nothing (disabled). */
export function actionOf(command: Command): "enter" | "run" | "none" {
  if (command.disabled) return "none";

  if (command.children) return "enter";

  return command.run || command.href ? "run" : "none";
}

/** The next active row for a key: arrows wrap, pages stop at the ends. */
export function moveActive(
  index: number,
  key: "next" | "previous" | "first" | "last" | "pageDown" | "pageUp",
  length: number,
  page = 8,
): number {
  if (length === 0) return -1;

  switch (key) {
    case "first":
      return 0;
    case "last":
      return length - 1;
    case "next":
      return index < 0 ? 0 : (index + 1) % length;
    case "previous":
      return index < 0 ? length - 1 : (index - 1 + length) % length;
    case "pageDown":
      return Math.min(length - 1, Math.max(0, index) + page);
    case "pageUp":
      return Math.max(0, index - page);
  }
}
