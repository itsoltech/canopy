import { useMemo, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useSettingsResource } from "../settings/resource";
import type { LibraryChoices } from "./ImportLibraryChoices";

interface Filters {
  cli: string;
  days: number;
  search: string;
  directory: string;
  subagents: boolean;
}

const defaults: Filters = { cli: "", days: 30, search: "", directory: "", subagents: false };
const pageSize = 200;

/** Selection covers the full filtered scan, independently of its visible page. */
export function useImportDraft(scan: ui.ScanImportResponse, onStarted: () => void) {
  const { online } = useSession();
  const [filters, setFilters] = useState(defaults);
  const [offset, setOffset] = useState(0);
  const [all, setAll] = useState(true);
  const [included, setIncluded] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [mode, setMode] = useState("continue");
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<LibraryChoices>({});

  const filter = useMemo(
    () =>
      create(ui.ImportCandidateFilterSchema, {
        agentClis: filters.cli ? [filters.cli] : [],
        search: filters.search,
        directory: filters.directory,
        includeSubagents: filters.subagents,
        since: filters.days ? timestampFromMs(Date.now() - filters.days * 86_400_000) : undefined,
      }),
    [filters],
  );

  const resource = useSettingsResource(`import-candidates:${scan.scanId}:${JSON.stringify(filters)}:${offset}`, (api) =>
    api.listImportCandidates({ scanId: scan.scanId, filter, limit: pageSize, offset }),
  );

  const library = useSettingsResource(`import-library:${scan.scanId}`, (api) =>
    api.listImportLibrary({ scanId: scan.scanId }),
  );

  const result = resource.data;
  const count = all ? Math.max(0, (result?.importable ?? 0) - excluded.length) : included.length;
  const busy = resource.busy;
  const disabled = busy || !online;

  function refilter(patch: Partial<Filters>) {
    setFilters({ ...filters, ...patch });
    setOffset(0);
    setAll(true);
    setIncluded([]);
    setExcluded([]);
  }

  function toggle(key: string, selected: boolean) {
    if (all) setExcluded(selected ? excluded.filter((id) => id !== key) : [...new Set([...excluded, key])]);
    else setIncluded(selected ? [...new Set([...included, key])] : included.filter((id) => id !== key));
  }

  function selectAll(value: boolean) {
    setAll(value);
    setIncluded([]);
    setExcluded([]);
  }

  async function start() {
    if (disabled || !result || (!count && !Object.keys(choices).length)) return;

    const run = await resource.run((api) =>
      api.startImport(
        {
          scanId: scan.scanId,
          mode,
          selection: { allMatching: all, filter, included, excluded },
          mappings: Object.entries(targets).flatMap(([directory, target]) =>
            target
              ? [
                  {
                    directory,
                    target: target.startsWith("workspace:")
                      ? { kind: "workspace", workspaceId: target.slice(10) }
                      : { kind: target },
                  },
                ]
              : [],
          ),
          library: Object.entries(choices).map(([key, choice]) => ({ key, ...choice })),
        },
        { timeoutMs: 125_000 },
      ),
    );

    if (run) onStarted();
  }

  return {
    filters,
    refilter,
    result,
    resource,
    library,
    count,
    busy,
    disabled,
    all,
    excluded,
    included,
    toggle,
    selectAll,
    mode,
    setMode,
    targets,
    setTargets,
    choices,
    setChoices,
    offset,
    pageSize,
    setOffset,
    start,
  };
}
