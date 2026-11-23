import { useEffect, useState } from "react";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { useSharedQuery } from "../../state/queries";
import { useSession } from "../../state/session";
import { createSettingsViewState } from "./SettingsScroll";

const defaults = { scope: ui.MemoryNoteScope.UNSPECIFIED, projectId: "", workerId: "", query: "" };

const pageKey = (filters: typeof defaults, cursor: string) => `ListMemoryNotes:${JSON.stringify([filters, cursor])}`;

const useFilters = createSettingsViewState(defaults);
const useSearch = createSettingsViewState("");
const useCursors = createSettingsViewState<string[]>([]);
const useOptions = createSettingsViewState<ui.MemoryFilterOptions | undefined>(undefined);

export function useMemoryNotes() {
  const { client, queries } = useSession();
  const [filters, setFilters] = useFilters();
  const [search, setSearch] = useSearch();
  const [cursors, setCursors] = useCursors();
  const [options, setOptions] = useOptions();
  const [previous, setPrevious] = useState<{ data: ui.ListMemoryNotesResponse; cursors: string[] }>();
  const cursor = cursors.at(-1) ?? "";

  const page = useSharedQuery(
    pageKey(filters, cursor),
    async (signal) => {
      if (!client) return null;

      try {
        return await client.api.listMemoryNotes(
          { ...filters, cursor, limit: 20, includeFilterOptions: !cursor },
          { signal },
        );
      } catch (cause) {
        if (ConnectError.from(cause).code === Code.Unimplemented) return null;
        throw cause;
      }
    },
    Boolean(client),
    30_000,
  );

  useEffect(() => {
    if (!page.data) return;

    if (!cursor) {
      setOptions(page.data.filterOptions);

      if (!page.data.filterOptions && (filters.query || filters.projectId || filters.workerId)) {
        setFilters({ ...defaults, scope: filters.scope });
        setSearch("");
      }
    }
    // The last entry on a later page may have been deleted since the cursor was issued.
    else if (!page.data.notes.length) {
      const prior = cursors.slice(0, -1);
      queries.invalidate(pageKey(filters, prior.at(-1) ?? ""));
      setCursors(prior);
    }
  }, [page.data, cursor, cursors, filters, queries, setCursors, setOptions, setFilters, setSearch]);

  useEffect(() => {
    const query = search.trim();

    if (query === filters.query) return;

    const timer = setTimeout(() => {
      setPrevious(undefined);
      setCursors([]);
      setFilters((current) => ({ ...current, query }));
    }, 200);

    return () => clearTimeout(timer);
  }, [filters.query, search, setCursors, setFilters]);

  function change(patch: Partial<typeof defaults>) {
    const next = { ...filters, query: search.trim(), ...patch };
    setPrevious(undefined);
    setCursors([]);
    setFilters(next);

    if (patch.query !== undefined) setSearch(patch.query);
  }

  const data = page.data === undefined ? previous?.data : page.data;
  const shownCursors = page.data === undefined && previous ? previous.cursors : cursors;

  function go(forward: boolean) {
    if ((forward && !data?.nextCursor) || (!forward && !shownCursors.length)) return;
    const target = forward && data ? [...shownCursors, data.nextCursor] : shownCursors.slice(0, -1);

    if (page.error && (target.at(-1) ?? "") === cursor) {
      void page.reload().catch(() => {});

      return;
    }

    if (data) setPrevious({ data, cursors: shownCursors });
    setCursors(target);
  }

  function refresh() {
    setPrevious(undefined);
    setCursors([]);
    queries.forget((key) => key.startsWith("ListMemoryNotes:"));
  }

  return {
    page,
    data,
    number: shownCursors.length + 1,
    filters,
    filtered: Boolean(filters.scope || filters.projectId || filters.workerId || search.trim()),
    options: !cursor && page.data ? page.data.filterOptions : options,
    search,
    setSearch,
    change,
    go,
    refresh,
    clear: () => change(defaults),
  };
}
