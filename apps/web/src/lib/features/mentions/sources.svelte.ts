import { MentionKind, type MentionCatalogEntry } from "@canopy/contracts";
import { fuzzyRank } from "@canopy/domain";
import { HttpError } from "#lib/shared/http.ts";
import { listMentionCatalog, searchFiles, searchThreads, type MentionScope } from "./api.ts";
import type { TriggerChar } from "./editor.ts";
import type { MentionData } from "./kinds.ts";

/**
 * What the mention popup offers for a trigger (docs/ui-api.md, "Wzmianki"):
 * "/" commands and "$" skills and plugins from the provider's catalog (listed once per scope, filtered here),
 * "@" files and "#" threads searched as you type (debounced; a late answer for an older query is dropped).
 * Without a worker scope (no workspace yet) only threads are offered; an offline worker says so.
 */

export interface MentionOption {
  readonly key: string;
  readonly data: MentionData;
  readonly title: string;
  readonly detail: string;
  /** Group heading. */
  readonly group: string;
  /** Matched characters in `title` (highlighted). */
  readonly indices: readonly number[];
}

export interface MentionResults {
  readonly options: readonly MentionOption[];
  readonly loading: boolean;
  readonly error: string | undefined;
}

/** Editor contract, independent of worker catalogs. Each composer supplies only its own sources. */
export interface MentionSourceSet {
  readonly results: MentionResults;
  readonly catalog?: { readonly entries: readonly MentionCatalogEntry[] };
  readonly catalogState?: { readonly loading: boolean; readonly error: string | undefined };
  readonly presentation?: Partial<Record<TriggerChar, { readonly label: string; readonly empty: string }>>;
  readonly renderMention?: (mention: MentionData) => string;
  query(char: TriggerChar, query: string): void;
  close(): void;
}

const DEBOUNCE_MS = 120;
const LIMIT = 40;

const scopeKey = (scope: MentionScope | undefined) =>
  scope
    ? `${scope.threadId ?? ""}|${scope.workspaceId ?? ""}|${scope.provider ?? 0}|${scope.providerProfileId ?? ""}|${scope.cwd ?? ""}`
    : "";

export function problemOf(cause: unknown): string {
  if (cause instanceof HttpError && cause.status === 503)
    return cause.message.charAt(0).toUpperCase() + cause.message.slice(1);

  return cause instanceof Error ? cause.message : String(cause);
}

export interface CatalogState {
  loading: boolean;
  error: string | undefined;
}

export class MentionSources implements MentionSourceSet {
  readonly #scope: () => MentionScope | undefined;
  readonly #threadId: () => string;
  #catalogKey = "";
  catalog = $state<{ entries: readonly MentionCatalogEntry[]; error?: string; loading: boolean }>({
    entries: [],
    loading: false,
  });
  results = $state<MentionResults>({ options: [], loading: false, error: undefined });
  #run = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** `scope`: the worker side (thread or new thread); `threadId`: the current thread (not offered under "#"). */
  constructor(scope: () => MentionScope | undefined, threadId: () => string = () => "") {
    this.#scope = scope;
    this.#threadId = threadId;
  }

  /** The catalog of the current scope, listed once (refresh: again, e.g. after a new skill). */
  async loadCatalog(refresh = false): Promise<void> {
    const scope = this.#scope();
    const key = scopeKey(scope);

    if (!scope || (!refresh && key === this.#catalogKey && (this.catalog.loading || this.catalog.entries.length > 0)))
      return;
    this.#catalogKey = key;
    this.catalog = { entries: [], loading: true };

    try {
      const { catalog } = await listMentionCatalog(scope, refresh);

      if (key === this.#catalogKey) this.catalog = { entries: catalog?.entries ?? [], loading: false };
    } catch (error) {
      if (key === this.#catalogKey) {
        this.catalog = { entries: [], loading: false, error: problemOf(error) };
        this.#catalogKey = "";
      }
    }
  }

  /** Options for a trigger and its query; `results` follows (at once for the catalog, debounced for searches). */
  query(char: TriggerChar, query: string): void {
    const run = ++this.#run;
    clearTimeout(this.#timer);

    if (char === "/" || char === "$") {
      void this.loadCatalog();
      this.results = { options: this.#fromCatalog(char, query), loading: false, error: undefined };

      return;
    }

    this.results = { ...this.results, loading: true, error: undefined };
    this.#timer = setTimeout(
      async () => {
        try {
          const options = char === "@" ? await this.#files(query) : await this.#threads(query);

          if (run === this.#run) this.results = { options, loading: false, error: undefined };
        } catch (error) {
          if (run === this.#run) this.results = { options: [], loading: false, error: problemOf(error) };
        }
      },
      query ? DEBOUNCE_MS : 0,
    );
  }

  /** The catalog's state for the open trigger (loading, offline). */
  get catalogState(): CatalogState {
    return {
      loading: this.catalog.loading,
      error:
        this.catalog.error ?? (this.#scope() ? undefined : "Choose a worker to mention its commands, skills and files"),
    };
  }

  close(): void {
    this.#run++;
    clearTimeout(this.#timer);
  }

  #fromCatalog(char: "/" | "$", query: string): MentionOption[] {
    const entries = this.catalog.entries.filter((e) =>
      char === "/" ? e.kind === MentionKind.COMMAND : e.kind === MentionKind.SKILL || e.kind === MentionKind.PLUGIN,
    );

    const ranked = fuzzyRank(query, entries, (e) => [e.label || e.name, e.name, ...e.aliases, e.description], LIMIT);
    // Groups in a fixed order (the platform's commands, the harness's; skills before plugins), best match first in each (stable sort).
    const order = (e: MentionCatalogEntry) => (e.source === "platform" ? 0 : e.kind === MentionKind.PLUGIN ? 2 : 1);

    return ranked
      .sort((a, b) => order(a.item) - order(b.item))
      .map(({ item, match }) => ({
        key: `${item.kind}:${item.name}`,
        data: {
          kind: item.kind,
          name: item.name,
          label: item.label,
          path: item.path,
          source: item.source,
          isDir: false,
          ...(item.icon && { icon: item.icon }),
        },
        title: char === "/" ? `/${item.name}` : item.label || item.name,
        detail: [item.argumentHint, item.description].filter(Boolean).join(" · "),
        group:
          item.source === "platform"
            ? "Canopy"
            : item.kind === MentionKind.PLUGIN
              ? "Plugins"
              : char === "/"
                ? "Commands"
                : "Skills",
        indices: char === "/" || !item.label ? match.indices.map((i) => i + (char === "/" ? 1 : 0)) : match.indices,
      }));
  }

  async #files(query: string): Promise<MentionOption[]> {
    const scope = this.#scope();

    if (!scope) throw new Error("Choose a worker to mention files from its folder");
    const { result } = await searchFiles(scope, query, LIMIT);

    return (result?.matches ?? []).map((m) => {
      const slash = m.path.lastIndexOf("/");

      return {
        key: `file:${m.path}`,
        data: { kind: MentionKind.FILE, name: m.path, label: "", path: "", source: "", isDir: m.isDir },
        title: m.path.slice(slash + 1),
        detail: slash > 0 ? m.path.slice(0, slash) : "",
        group: "Files",
        indices: m.indices.filter((i) => i > slash).map((i) => i - slash - 1),
      };
    });
  }

  async #threads(query: string): Promise<MentionOption[]> {
    const { threads } = await searchThreads(query, this.#threadId(), LIMIT);

    return threads.map((t) => ({
      key: `thread:${t.id}`,
      data: { kind: MentionKind.THREAD, name: t.id, label: t.title || "Untitled", path: "", source: "", isDir: false },
      title: t.title || "Untitled",
      detail: t.status,
      group: "Threads",
      indices: [],
    }));
  }
}
