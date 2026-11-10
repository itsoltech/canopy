import type { ui } from "@canopy/contracts";
import type { IconName } from "#lib/shared/ui/icons.ts";

/** Where the new workspace comes from (docs/linked-computers.md, "Dodawanie projektu na dowolnym komputerze"). */
export type SourceKind = "directory" | "init" | "url" | "github";

export interface SourceChoice {
  readonly kind: SourceKind;
  readonly title: string;
  readonly detail: string;
  readonly icon?: IconName;
  /** A connector mark instead of the icon. */
  readonly mark?: string;
  /** Needs a worker that creates directories and clones (`Worker.project_sources`). */
  readonly creates: boolean;
}

export const SOURCES: readonly SourceChoice[] = [
  { kind: "init", title: "New project", detail: "Create a new directory with Git", icon: "plus", creates: true },
  {
    kind: "directory",
    title: "Existing directory",
    detail: "Browse a directory on this computer",
    icon: "folder-open",
    creates: false,
  },
  { kind: "url", title: "Git URL", detail: "Clone from a remote URL", icon: "link", creates: true },
  { kind: "github", title: "GitHub repository", detail: "Clone owner/repo from GitHub", mark: "github", creates: true },
];

/** One option of a list step. */
export interface Choice<V> {
  readonly key: string;
  readonly value: V;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly status?: string | undefined;
  readonly icon?: IconName | undefined;
  /** A connector mark (GitHub) instead of the icon. */
  readonly mark?: string | undefined;
  /** A presence dot instead of the icon: online or not. */
  readonly online?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

/** One step of the dialog; the stack is its history (Back pops it). */
export type Step =
  | { readonly kind: "worker" }
  | { readonly kind: "source"; readonly worker: ui.Worker }
  | { readonly kind: "remote"; readonly worker: ui.Worker; readonly source: SourceKind }
  | { readonly kind: "browse"; readonly worker: ui.Worker; readonly source: SourceKind; readonly remote: string };

/** What the browser adds: the open directory itself, or a new directory in it. */
export type BrowseMode = "add" | "create" | "clone";

const MODES = { directory: "add", init: "create", url: "clone", github: "clone" } satisfies Record<
  SourceKind,
  BrowseMode
>;

export const browseMode = (source: SourceKind): BrowseMode => MODES[source];

export const ACTION_LABELS: Record<BrowseMode, string> = {
  add: "Add directory",
  create: "Create project",
  clone: "Clone project",
};

export const BUSY_LABELS: Record<BrowseMode, string> = {
  add: "Adding…",
  create: "Creating…",
  clone: "Cloning…",
};

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

/** The clone URL of a remote source, or why the text is not one yet. */
export function remoteUrl(source: SourceKind, text: string): { url: string } | { error: string } {
  const value = text.trim();

  if (source === "github") {
    const repo = value.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "");

    return GITHUB_REPO.test(repo)
      ? { url: `https://github.com/${repo}.git` }
      : { error: "Enter the repository as owner/repo." };
  }

  if (/^[\w.-]+@[\w.-]+:\S+$/.test(value) || /^(https?|ssh|git|file):\/\/\S+$/i.test(value)) return { url: value };

  return { error: "Enter a URL that starts with https://, ssh:// or git@." };
}

/** The gateway request for a finished choice. */
export function addRequest(worker: ui.Worker, mode: BrowseMode, target: { dir: string; name: string }, url: string) {
  if (mode === "add") return { workerId: worker.id, directoryPath: target.dir };

  if (mode === "create") return { workerId: worker.id, init: { parentPath: target.dir, name: target.name } };

  return { workerId: worker.id, clone: { parentPath: target.dir, name: target.name, url } };
}

export type BrowseTarget = { readonly dir: string; readonly name: string } | { readonly reason: string };

/**
 * What the browser's action adds for the typed path. "add": the open directory, or the entry the filter names
 * exactly. "create"/"clone": a new directory named by the filter inside the open one. `names` is undefined while
 * the directory loads. An empty reason disables the action quietly (a filter still being typed).
 */
export function browseTarget(
  mode: BrowseMode,
  typed: { dir: string; filter: string },
  names: readonly string[] | undefined,
  sep: string,
): BrowseTarget | undefined {
  if (!typed.dir) return { reason: `Start the path with ~${sep} or ${sep}.` };

  if (!names) return undefined;
  const exact = names.includes(typed.filter);

  if (mode === "add") {
    if (!typed.filter) return { dir: typed.dir, name: "" };

    return exact ? { dir: `${typed.dir.replace(/[\\/]+$/, "")}${sep}${typed.filter}`, name: "" } : { reason: "" };
  }

  if (!typed.filter) return { reason: "Type a name for the new directory." };

  if (exact) return { reason: `“${typed.filter}” already exists here.` };

  if (typed.filter === "." || typed.filter === "..") return { reason: "Type a name for the new directory." };

  return { dir: typed.dir, name: typed.filter };
}
