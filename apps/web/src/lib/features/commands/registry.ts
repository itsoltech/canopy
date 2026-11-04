import { getContext, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import type { IconName } from "#lib/shared/ui/icons.ts";
import type { ProviderKey } from "#lib/features/threads/providers.ts";

/** Groups of the palette, in the order they are listed. */
export const commandGroups = ["actions", "threads", "projects", "settings"] as const;

export type CommandGroup = (typeof commandGroups)[number];

export const groupLabels: Record<CommandGroup, string> = {
  actions: "Actions",
  threads: "Recent threads",
  projects: "Projects",
  settings: "Settings",
};

/** What a thread row shows under its title (T3 layout): where it lives and runs, and when it last moved. */
export interface ThreadMeta {
  readonly projectKind?: string | undefined;
  readonly projectName: string;
  readonly workerName: string;
  readonly provider?: ProviderKey | undefined;
  readonly activityAt?: Timestamp | undefined;
}

/**
 * One entry of the command palette. Features contribute them (`contributeCommands`); the palette
 * lists those whose `when` holds. An entry either runs (`run`), navigates (`href`, a real link, so
 * whatever handles links handles it) or opens a submenu in place (`children`).
 */
export interface Command {
  /** Unique among the commands listed together. */
  readonly id: string;
  readonly title: string;
  readonly group: CommandGroup;
  readonly icon?: IconName | undefined;
  /** Extra words it is found by (matched, not shown). */
  readonly keywords?: string | undefined;
  /** Shortcut shown on the right; the palette binds it globally while the command is available. */
  readonly hotkey?: string | undefined;
  /** Listed (and its hotkey bound) only while this holds. */
  readonly when?: (() => boolean) | undefined;
  /** Shown muted and not chosen (for discoverability: why it is not available now). */
  readonly disabled?: boolean | undefined;
  /** The current choice of a submenu (✓). */
  readonly checked?: boolean | undefined;
  /** Order inside its group on an empty query (lower first; default 0, then contribution order). */
  readonly rank?: number | undefined;
  /** Listed on an empty query (default true); false = only found by searching. */
  readonly suggested?: boolean | undefined;
  /** Runs it (after the palette closed); a returned promise is awaited. */
  readonly run?: (() => unknown) | undefined;
  readonly href?: string | undefined;
  readonly children?: (() => readonly Command[]) | undefined;
  /** Search placeholder of the submenu. */
  readonly placeholder?: string | undefined;
  /** Searching from the top level also finds the submenu's entries ("Change theme › Ocean"). */
  readonly searchChildren?: boolean | undefined;
  /** Leading mark instead of the icon: a project's avatar (its name). */
  readonly projectName?: string | undefined;
  readonly projectKind?: string | undefined;
  readonly thread?: ThreadMeta | undefined;
}

/** A function returning commands; it may read reactive state (it is called when the palette lists). */
export type CommandSource = () => readonly Command[];

/**
 * The commands of the app. Sources are added by features and pages for as long as they are mounted
 * (`contributeCommands`) and read on demand, so commands follow the state they close over.
 */
export class CommandRegistry {
  readonly #sources = new SvelteMap<symbol, CommandSource>();

  /** Adds a source; returns its removal. */
  add(source: CommandSource): () => void {
    const key = Symbol("commands");
    this.#sources.set(key, source);

    return () => this.#sources.delete(key);
  }

  /** Every available command (its `when` holds), in contribution order. */
  list(): Command[] {
    return [...this.#sources.values()].flatMap((source) => source()).filter(available);
  }
}

export const available = (command: Command): boolean => !command.when || command.when();

/** Available entries of a submenu. */
export const childrenOf = (command: Command): Command[] => (command.children?.() ?? []).filter(available);

const KEY = Symbol("commands");
export const provideCommands = (registry: CommandRegistry) => setContext(KEY, registry);
export const useCommands = (): CommandRegistry | undefined => getContext<CommandRegistry | undefined>(KEY);
