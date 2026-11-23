import { MentionKind, type MentionCatalogEntry, type ui } from "@canopy/contracts";
import { QueryCache } from "@canopy/domain/shared-query";
import { queries } from "#lib/shared/queries.svelte.ts";
import { fuzzyRank } from "@canopy/domain";
import { HttpError } from "#lib/shared/http.ts";
import { listMentionCatalog, searchFiles, searchIssues, searchThreads, type MentionScope } from "./api.ts";
import { issueResults } from "./issues.ts";
import type { TriggerChar } from "./editor.ts";
import type { MentionData } from "./kinds.ts";

/**
 * What the mention popup offers for a trigger (docs/ui-api.md, "Wzmianki"):
 * "/" commands and "$" skills and plugins from the provider's catalog (listed once per scope, filtered here),
 * "@" searches files. "#" searches threads and the issues and pull requests available to the project.
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
  readonly empty?: string | undefined;
}

interface TriggerPresentation {
  readonly label: string;
  readonly empty: string;
}

export const triggerPresentation: Record<TriggerChar, TriggerPresentation> = {
  "/": { label: "Commands", empty: "No commands match" },
  $: { label: "Skills and plugins", empty: "No skills or plugins match" },
  "@": { label: "Files", empty: "No files match" },
  "#": { label: "Issues, pull requests and threads", empty: "No matches. Try another title, key or number." },
};

/** Editor contract, independent of worker catalogs. Each composer supplies only its own sources. */
export interface MentionSourceSet {
  readonly results: MentionResults;
  readonly catalog?: { readonly entries: readonly MentionCatalogEntry[] };
  readonly catalogState?: { readonly loading: boolean; readonly error: string | undefined };
  readonly presentation?: Partial<Record<TriggerChar, TriggerPresentation>>;
  readonly renderMention?: (mention: MentionData) => string;
  query(char: TriggerChar, query: string): void;
  close(): void;
}

const DEBOUNCE_MS = 120;
const LIMIT = 40;

/** A scope's commands and skills are shared by its composers; skill changes invalidate them sooner. */
const CATALOG_MAX_AGE_MS = 60_000;

/** Files and threads change outside Canopy: a search is reused only briefly. */
const SEARCH_MAX_AGE_MS = 8000;

/** Recent searches of the tab, apart from the shared reads so they never push those out of the LRU. */
const searches = new QueryCache({ idle: 64 });

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
  readonly #issueScope: () => MentionScope | undefined;
  readonly #threadId: () => string;
  #catalogKey = "";
  catalog = $state<{ entries: readonly MentionCatalogEntry[]; error?: string; loading: boolean }>({
    entries: [],
    loading: false,
  });
  results = $state<MentionResults>({ options: [], loading: false, error: undefined });
  #run = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #issueSearch: AbortController | undefined;

  /** `scope`: the worker side (thread or new thread); `threadId`: the current thread (not offered under "#"). */
  constructor(scope: () => MentionScope | undefined, threadId: () => string = () => "", issueScope = scope) {
    this.#scope = scope;
    this.#issueScope = issueScope;
    this.#threadId = threadId;
  }

  /** The catalog of the current scope, listed once (refresh: again, e.g. after a new skill). */
  async loadCatalog(refresh = false): Promise<void> {
    const scope = this.#scope();
    const key = scopeKey(scope);

    if (!scope || (!refresh && key === this.#catalogKey && (this.catalog.loading || !this.catalog.error))) return;
    this.#catalogKey = key;
    const shared = `ListMentionCatalog:${key}`;
    const current = queries.snapshot<ui.ListMentionCatalogResponse>(shared);
    // Another composer of this scope already listed it: show that at once (an empty catalog is listed too).
    this.catalog = { entries: current.data?.catalog?.entries ?? [], loading: !current.loaded };

    try {
      if (refresh) queries.invalidate(shared);
      const { catalog } = await queries.read(shared, () => listMentionCatalog(scope, refresh), CATALOG_MAX_AGE_MS);

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
    this.close();
    const run = this.#run;

    if (char === "/" || char === "$") {
      void this.loadCatalog();
      this.results = { options: this.#fromCatalog(char, query), loading: false, error: undefined };

      return;
    }

    const scope = char === "#" ? this.#issueScope() : undefined;
    this.results = { options: [], loading: true, error: undefined };
    this.#timer = setTimeout(
      async () => {
        if (char === "#") {
          this.#references(scope, query, run);

          return;
        }

        try {
          const options = await this.#files(query);

          if (run === this.#run) this.results = { options, loading: false, error: undefined };
        } catch (error) {
          if (run === this.#run) this.results = { options: [], loading: false, error: problemOf(error) };
        }
      },
      query ? DEBOUNCE_MS : 0,
    );
  }

  #references(scope: MentionScope | undefined, query: string, run: number): void {
    const scoped = scope?.threadId || scope?.workspaceId;
    const pages: MentionResults[] = [];

    // Append completed groups. Even the default highlight stays on the same option when a slower source arrives.
    const publish = (page: MentionResults) => {
      if (run !== this.#run) return;
      pages.push(page);
      this.results = {
        options: pages.flatMap((p) => p.options),
        loading: Boolean(scoped && pages.length < 2),
        error: pages.flatMap((p) => (p.error ? [p.error] : [])).join("\n") || undefined,
        empty: scoped ? pages.find((p) => p.empty)?.empty : "No threads match",
      };
    };

    void this.#threads(query).then(
      (options) => publish({ options, loading: false, error: undefined }),
      () => publish({ options: [], loading: false, error: "Could not search threads. Edit the search to try again." }),
    );

    if (!scoped || !scope) return;
    this.#issueSearch = new AbortController();
    void searchIssues(scope, query, LIMIT, this.#issueSearch.signal).then(
      (response) => publish(issueResults(response, query)),
      (cause) =>
        publish({
          options: [],
          loading: false,
          error:
            cause instanceof HttpError && cause.status === 426
              ? problemOf(cause)
              : "Could not search connected accounts. Edit the search to try again.",
        }),
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
    this.#issueSearch?.abort();
    this.#issueSearch = undefined;
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

    // Reopening the picker with the same text reuses a search of the last few seconds.
    const { result } = await searches.read(
      `SearchFiles:${scopeKey(scope)}:${query}`,
      () => searchFiles(scope, query, LIMIT),
      SEARCH_MAX_AGE_MS,
    );

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
    const { threads } = await searches.read(
      `SearchThreads:${this.#threadId()}:${query}`,
      () => searchThreads(query, this.#threadId(), LIMIT),
      SEARCH_MAX_AGE_MS,
    );

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
