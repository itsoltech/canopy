import { useState, useRef, type ComponentRef } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { createSettingsViewState, useRevealSettingsView } from "./SettingsScroll";
import { styles, useColors } from "../../ui/theme";
import { diagnosticsRanges, diagnosticsSorts, diagnosticsKinds, DiagnosticsPages } from "@canopy/domain/diagnostics";
import { SettingChoice, SettingsGroup, SettingsActions } from "./SettingsGroup";
import { ResourceState } from "./resource";
import { useDiagnosticsResource, diagnosticsEpochs } from "./diagnostics-resource";
import { DiagnosticsClients } from "./DiagnosticsClients";
import { DiagnosticsActions } from "./DiagnosticsActions";
import { DiagnosticsComputer, DiagnosticsFindings } from "./DiagnosticsComputer";
import { DiagnosticsCalls } from "./DiagnosticsCalls";
import { DiagnosticsGrants } from "./DiagnosticsGrants";
import { DiagnosticsMetrics } from "./DiagnosticsMetrics";
import { DiagnosticsLinks } from "./DiagnosticsLinks";
import { DiagnosticsTracing } from "./DiagnosticsTracing";
import { DiagnosticsStorage } from "./DiagnosticsStorage";
import { Button } from "../../ui/components";
import { MinimumTouchTarget } from "../../ui/density";

const defaults = {
  range: "15",
  selected: "",
  sort: "p95",
  kind: "unary",
  computerOnPage: "",
  pageEpoch: "",
  offset: 0,
};

const useDiagnosticsView = createSettingsViewState(defaults);
const useFindingsExpanded = createSettingsViewState(false);

function useDiagnosticsPanel() {
  const [view, setView] = useDiagnosticsView();
  const { range, selected, sort, kind } = view;
  const [previous, setPrevious] = useState<{ scope: string; offset: number; data: ui.ComputerDiagnostics }>();
  const pages = useRef(new DiagnosticsPages());

  const overview = useDiagnosticsResource(`GetDiagnostics:${range}`, async (api) => {
    const value = await api.getDiagnostics({ windowMinutes: Number(range) });

    if (value.computers.some((computer) => !diagnosticsEpochs.accept(computer)))
      throw new Error("Diagnostics baseline changed; refresh again");

    return value;
  });

  const computers = overview.data?.computers ?? [];
  const summary = computers.find((item) => item.computerId === selected) ?? computers[0];
  const computer = summary?.computerId ?? "";
  const scope = JSON.stringify([computer, range, sort, kind]);
  const epoch = summary?.epoch ?? "";
  const offset = view.computerOnPage === computer && view.pageEpoch === epoch ? view.offset : 0;
  const detailKey = `GetComputerDiagnostics:${computer}:${range}:${offset}:${sort}:${kind}:${epoch}`;

  const detail = useDiagnosticsResource(
    detailKey,
    async (api) => {
      const value = await api.getComputerDiagnostics({
        computerId: computer,
        windowMinutes: Number(range),
        offset,
        limit: 32,
        sortBy: sort,
        callKind: kind,
        methodKeys: pages.current.keys.get(detailKey) ?? [],
      });

      if (!diagnosticsEpochs.accept(value)) throw new Error("Diagnostics baseline changed; refresh again");

      return pages.current.remember(detailKey, value);
    },
    Boolean(computer),
  );

  const current = detail.data?.computerId === computer ? detail.data : undefined;
  const fallback = previous?.scope === scope && previous.data.epoch === summary?.epoch ? previous : undefined;
  const data = current ?? fallback?.data;

  const shownOffset = current ? offset : (fallback?.offset ?? offset);

  function paginate(next: number) {
    if (next === offset && detail.error) {
      void detail.reload().catch(() => {});

      return;
    }

    if (data) setPrevious({ data, scope, offset: shownOffset });
    setView((old) => ({ ...old, computerOnPage: computer, pageEpoch: epoch, offset: next }));
  }

  async function refresh() {
    await Promise.all([overview.reload(), detail.reload()]);
  }

  function change(patch: Partial<Pick<typeof defaults, "range" | "selected" | "sort" | "kind">>) {
    setView((old) => ({ ...old, ...patch, offset: 0, computerOnPage: "" }));
    setPrevious(undefined);
  }

  async function reset() {
    pages.current.keys.clear();
    change({});
    await refresh();
  }

  return {
    view,
    computer,
    change,
    overview,
    scope,
    reset,
    refresh,
    detail: { ...detail, data, initialLoading: !data && detail.initialLoading },
    page:
      shownOffset || data?.nextOffset
        ? {
            data,
            offset: shownOffset,
            previous: shownOffset > 0 ? () => paginate(Math.max(0, shownOffset - 32)) : undefined,
            next: data?.nextOffset ? () => paginate(data.nextOffset) : undefined,
            loading: !current && !detail.error,
          }
        : undefined,
  };
}

export function DiagnosticsSettings() {
  const { view, computer, change, overview, scope, reset, refresh, detail, page } = useDiagnosticsPanel();
  const { data } = detail;
  const details = useRef<ComponentRef<typeof View>>(null);
  const reveal = useRevealSettingsView();
  const [expanded, setExpanded] = useFindingsExpanded();

  return (
    <MinimumTouchTarget.Provider value={48}>
      <ResourceState resource={overview}>
        <SettingsGroup title="Diagnostics" description="Check performance and Canopy storage across your computers.">
          <SettingChoice
            title="Time range"
            value={view.range}
            options={diagnosticsRanges}
            onChange={(value) => change({ range: value })}
          />
        </SettingsGroup>
        {overview.data?.computers.map((item) => (
          <DiagnosticsComputer
            key={item.computerId}
            computer={item}
            selected={item.computerId === computer}
            onSelect={() => {
              change({ selected: item.computerId });
              reveal(details.current);
            }}
          />
        ))}
        {overview.data ? <DiagnosticsStorage computers={overview.data.computers} /> : null}
        {overview.data ? (
          <DiagnosticsFindings
            computers={overview.data.computers}
            expanded={expanded}
            onExpand={() => setExpanded(!expanded)}
          />
        ) : null}
        {overview.data ? (
          <DiagnosticsActions
            computers={overview.data.computers}
            range={Number(view.range)}
            computer={data}
            onReset={reset}
          />
        ) : null}
        {!!computer && (
          <View ref={details} collapsable={false} style={{ gap: 24 }}>
            <SettingsGroup>
              <SettingChoice
                title="Computer"
                value={computer}
                options={(overview.data?.computers ?? []).map((item) => ({ value: item.computerId, label: item.name }))}
                onChange={(selected) => change({ selected })}
              />
              <SettingChoice
                title="Sort calls"
                value={view.sort}
                options={diagnosticsSorts}
                onChange={(value) => change({ sort: value })}
              />
              <SettingChoice
                title="Call type"
                value={view.kind}
                options={diagnosticsKinds}
                onChange={(value) => change({ kind: value })}
              />
            </SettingsGroup>
            <ResourceState resource={detail}>
              {data && <DiagnosticsTracing key={computer} computer={data} onRefresh={refresh} />}
              {data ? <DiagnosticsMetrics computer={data} /> : null}
              {data ? <DiagnosticsLinks computer={data} /> : null}
              {data ? <DiagnosticsClients computer={data} /> : null}
              {data ? <DiagnosticsCalls key={scope} calls={data.calls} computer={data} /> : null}
              {page && <CallPages {...page} />}
            </ResourceState>
          </View>
        )}
        <DiagnosticsGrants />
      </ResourceState>
    </MinimumTouchTarget.Provider>
  );
}

function CallPages({
  data,
  offset,
  previous,
  next,
  loading,
}: {
  data?: ui.ComputerDiagnostics;
  offset: number;
  previous?: () => void;
  next?: () => void;
  loading: boolean;
}) {
  const c = useColors();

  return (
    <SettingsActions>
      {data && data.calls.length > 0 && (
        <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
          {offset + 1}–{offset + data.calls.length} of {data.totalMethods}
        </Text>
      )}
      <Button title="Previous" disabled={loading || !previous} onPress={() => previous?.()} />
      <Button title="Next" disabled={loading || !next} onPress={() => next?.()} />
    </SettingsActions>
  );
}
