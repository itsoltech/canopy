import { useState, useRef, type ComponentRef } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { createSettingsViewState, useRevealSettingsView } from "./SettingsScroll";
import { styles, useColors } from "../../ui/theme";
import {
  diagnosticsRanges,
  diagnosticsSorts,
  diagnosticsKinds,
  diagnosticsUnavailable,
  DiagnosticsPages,
} from "@canopy/domain/diagnostics";
import { SettingChoice, SettingsGroup, SettingsRow, SettingsActions } from "./SettingsGroup";
import { ResourceState } from "./resource";
import { useDiagnosticsResource, diagnosticsEpochs } from "./diagnostics-resource";
import { DiagnosticsClients } from "./DiagnosticsClients";
import { DiagnosticsCounters, DiagnosticsReports } from "./DiagnosticsActions";
import { DiagnosticsComputer, DiagnosticsFindings } from "./DiagnosticsComputer";
import { DiagnosticsCalls } from "./DiagnosticsCalls";
import { DiagnosticsGrants } from "./DiagnosticsGrants";
import { DiagnosticsMetrics } from "./DiagnosticsMetrics";
import { DiagnosticsLinks } from "./DiagnosticsLinks";
import { DiagnosticsTracing } from "./DiagnosticsTracing";
import { DiagnosticsStorage } from "./DiagnosticsStorage";
import { useAppearance } from "../../state/appearance";
import { ThreadSyncDiagnostics } from "./ThreadSyncDiagnostics";
import { SettingsTopics } from "./SettingsTopics";
import { Button, Notice } from "../../ui/components";
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

type Panel = ReturnType<typeof useDiagnosticsPanel>;

export function DiagnosticsSettings() {
  const panel = useDiagnosticsPanel();
  const picker = useRef<{ selectTopic(id: string): void }>(null);
  const top = useRef<ComponentRef<typeof View>>(null);
  const reveal = useRevealSettingsView();
  const { overview, view } = panel;

  return (
    <MinimumTouchTarget.Provider value={48}>
      <View ref={top} collapsable={false}>
        <SettingsTopics
          ref={picker}
          topics={[
            {
              id: "overview",
              label: "Overview",
              content: (
                <DiagnosticsOverview
                  panel={panel}
                  onSelect={(selected) => {
                    panel.change({ selected });
                    picker.current?.selectTopic("performance");
                    reveal(top.current);
                  }}
                />
              ),
            },
            { id: "performance", label: "Performance", content: <DiagnosticsDetails panel={panel} /> },
            {
              id: "calls-and-tracing",
              label: "Calls and tracing",
              content: <DiagnosticsDetails panel={panel} calls />,
            },
            {
              id: "reports-and-logs",
              label: "Reports and logs",
              content: (
                <ResourceState resource={overview}>
                  <SettingsGroup>
                    <RangeControl panel={panel} />
                  </SettingsGroup>
                  {overview.data && (
                    <DiagnosticsReports computers={overview.data.computers} range={Number(view.range)} />
                  )}
                  <DiagnosticsGrants />
                </ResourceState>
              ),
            },
          ]}
        />
      </View>
    </MinimumTouchTarget.Provider>
  );
}

function RangeControl({ panel }: { panel: Panel }) {
  return (
    <SettingChoice
      title="Time range"
      value={panel.view.range}
      options={diagnosticsRanges}
      onChange={(range) => panel.change({ range })}
    />
  );
}

function DiagnosticsOverview({ panel, onSelect }: { panel: Panel; onSelect(id: string): void }) {
  const { overview, computer } = panel;
  const { threadsEnabled } = useAppearance();
  const [expanded, setExpanded] = useFindingsExpanded();

  return (
    <>
      <ResourceState resource={overview}>
        <SettingsGroup
          title="Computer health"
          description="Check performance and Canopy storage across your computers."
        >
          <RangeControl panel={panel} />
        </SettingsGroup>
        {overview.data?.computers.length === 0 && <Notice>No computers are reporting diagnostics.</Notice>}
        {overview.data?.computers.map((item) => (
          <DiagnosticsComputer
            key={item.computerId}
            computer={item}
            selected={item.computerId === computer}
            onSelect={() => onSelect(item.computerId)}
          />
        ))}
        {overview.data && (
          <>
            <DiagnosticsFindings
              computers={overview.data.computers}
              expanded={expanded}
              onExpand={() => setExpanded(!expanded)}
            />
            <DiagnosticsStorage computers={overview.data.computers} />
          </>
        )}
      </ResourceState>
      {threadsEnabled && <ThreadSyncDiagnostics />}
    </>
  );
}

function DiagnosticsDetails({ panel, calls = false }: { panel: Panel; calls?: boolean }) {
  const { view, computer, change, overview, scope, reset, refresh, detail, page } = panel;
  const { data } = detail;

  return (
    <ResourceState resource={overview}>
      <SettingsGroup>
        <SettingChoice
          title="Computer"
          value={computer}
          disabled={!computer}
          options={(overview.data?.computers ?? []).map((item) => ({ value: item.computerId, label: item.name }))}
          onChange={(selected) => change({ selected })}
        />
        <RangeControl panel={panel} />
        {calls && (
          <>
            <SettingChoice
              title="Sort calls"
              disabled={!computer}
              value={view.sort}
              options={diagnosticsSorts}
              onChange={(sort) => change({ sort })}
            />
            <SettingChoice
              title="Call type"
              disabled={!computer}
              value={view.kind}
              options={diagnosticsKinds}
              onChange={(kind) => change({ kind })}
            />
          </>
        )}
      </SettingsGroup>
      {overview.data?.computers.length === 0 && <Notice>No computers are reporting diagnostics.</Notice>}
      {!!computer && (
        <ResourceState resource={detail}>
          {calls ? (
            <>
              {data && <DiagnosticsCalls key={scope} calls={data.calls} computer={data} />}
              {page && <CallPages {...page} />}
              {data && <DiagnosticsTracing key={computer} computer={data} onRefresh={refresh} />}
            </>
          ) : (
            data && (
              <>
                {data.detailsAvailable ? (
                  <>
                    <DiagnosticsMetrics computer={data} />
                    <DiagnosticsLinks computer={data} />
                    <DiagnosticsClients computer={data} />
                  </>
                ) : (
                  <SettingsGroup>
                    <SettingsRow
                      title={diagnosticsUnavailable(data)[0]}
                      description={diagnosticsUnavailable(data)[1]}
                    />
                  </SettingsGroup>
                )}
                <DiagnosticsCounters
                  key={computer}
                  localComputerId={overview.data?.computers[0]?.computerId}
                  computer={data}
                  onReset={reset}
                />
              </>
            )
          )}
        </ResourceState>
      )}
    </ResourceState>
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
