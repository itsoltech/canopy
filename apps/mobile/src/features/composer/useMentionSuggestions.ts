import { useEffect, useEffectEvent, useState } from "react";
import { MentionKind, type MentionCatalogEntry, type Mention, type ui } from "@canopy/contracts";
import { fuzzyRank } from "@canopy/domain/mentions";
import { ConnectError } from "@connectrpc/connect";
import type { ActiveTrigger } from "./mention-trigger";
import { useSession } from "../../state/session";

export interface MentionOption {
  readonly key: string;
  readonly mention: Pick<Mention, "kind" | "name" | "label" | "path" | "source" | "isDir" | "issue">;
  readonly title: string;
  readonly detail: string;
  readonly group: string;
}

const LIMIT = 40;

const failure = (cause: unknown) => ConnectError.from(cause).rawMessage;

function fromCatalog(entries: readonly MentionCatalogEntry[], char: "/" | "$", query: string): MentionOption[] {
  const offered = entries.filter((e) =>
    char === "/" ? e.kind === MentionKind.COMMAND : e.kind === MentionKind.SKILL || e.kind === MentionKind.PLUGIN,
  );

  const ranked = fuzzyRank(query, offered, (e) => [e.label || e.name, e.name, ...e.aliases, e.description], LIMIT);
  // The platform's commands, then the harness's; skills before plugins; best match first in each.
  const order = (e: MentionCatalogEntry) => (e.source === "platform" ? 0 : e.kind === MentionKind.PLUGIN ? 2 : 1);

  return ranked
    .sort((a, b) => order(a.item) - order(b.item))
    .map(({ item }) => ({
      key: `${item.kind}:${item.name}`,
      mention: {
        kind: item.kind,
        name: item.name,
        label: item.label,
        path: item.path,
        source: item.source,
        isDir: false,
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
    }));
}

/** A scope's commands and skills, shared by its composers. */
const CATALOG_MAX_AGE_MS = 60_000;

/** Reopening a file search reuses its results briefly. */
const SEARCH_MAX_AGE_MS = 8000;

/**
 * What the mention list offers for a trigger (docs/ui-api.md, "Wzmianki"): "/" commands and "$" skills and plugins
 * from the thread's catalog (listed once), "@" files searched as you type.
 */
export function useMentionSuggestions(scope: ui.MentionScope | undefined, trigger: ActiveTrigger | undefined) {
  const { client, queries, searches } = useSession();
  const [catalog, setCatalog] = useState<{ key: string; entries: readonly MentionCatalogEntry[]; error?: string }>();
  const [found, setFound] = useState<{ key: string; options: MentionOption[]; error?: string }>();

  // The folder is part of the scope: a catalog of one cwd is not another's.
  const scopeKey = scope
    ? `${scope.threadId}|${scope.workspaceId}|${scope.provider}|${scope.providerProfileId}|${scope.cwd}`
    : "";

  const wantsCatalog = trigger?.char === "/" || trigger?.char === "$";
  const searchKey = trigger?.char === "@" ? `${scopeKey}|${trigger.char}|${trigger.query}` : "";

  const listCatalog = useEffectEvent(async () => {
    if (!client || !scope) return [];

    // Composers of one scope share a listing for a minute; skill changes invalidate it sooner.
    const listed = await queries.read(
      `ListMentionCatalog:${scopeKey}`,
      () => client.api.listMentionCatalog({ scope }, { timeoutMs: 50_000 }),
      CATALOG_MAX_AGE_MS,
    );

    return listed.catalog?.entries ?? [];
  });

  // The catalog is listed once per scope, when "/" or "$" first opens the list.
  const needsCatalog = wantsCatalog && Boolean(scopeKey) && catalog?.key !== scopeKey;

  useEffect(() => {
    if (!needsCatalog) return;
    let active = true;

    void listCatalog()
      .then((entries) => active && setCatalog({ key: scopeKey, entries }))
      .catch((cause: unknown) => active && setCatalog({ key: scopeKey, entries: [], error: failure(cause) }));

    return () => {
      active = false;
    };
  }, [needsCatalog, scopeKey]);

  // Reads the current scope and trigger; the effect below runs again only when the search key changes.
  const search = useEffectEvent(async (): Promise<MentionOption[]> => {
    if (!client || !scope || trigger?.char !== "@") return [];

    const { result } = await searches.read(
      `SearchFiles:${scopeKey}:${trigger.query}`,
      () => client.api.searchFiles({ scope, query: trigger.query, limit: LIMIT }, { timeoutMs: 25_000 }),
      SEARCH_MAX_AGE_MS,
    );

    return (result?.matches ?? []).map((m) => {
      const slash = m.path.lastIndexOf("/");

      return {
        key: `file:${m.path}`,
        mention: { kind: MentionKind.FILE, name: m.path, label: "", path: "", source: "", isDir: m.isDir },
        title: m.path.slice(slash + 1),
        detail: slash > 0 ? m.path.slice(0, slash) : "",
        group: "Files",
      };
    });
  });

  useEffect(() => {
    if (!searchKey) return;
    let active = true;

    const timer = setTimeout(
      () =>
        void search()
          .then((options) => active && setFound({ key: searchKey, options }))
          .catch((cause: unknown) => active && setFound({ key: searchKey, options: [], error: failure(cause) })),
      searchKey.endsWith("|") ? 0 : 120,
    );

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [searchKey]);

  if (!trigger) return { options: [], loading: false, error: undefined };

  if (wantsCatalog) {
    const ready = catalog?.key === scopeKey;

    return {
      options: ready ? fromCatalog(catalog.entries, trigger.char === "/" ? "/" : "$", trigger.query) : [],
      loading: !ready,
      error: ready ? catalog.error : undefined,
    };
  }

  const ready = found?.key === searchKey;

  const previous = found?.key.startsWith(`${scopeKey}|${trigger.char}|`) ? found.options : [];

  return { options: ready ? found.options : previous, loading: !ready, error: ready ? found.error : undefined };
}
