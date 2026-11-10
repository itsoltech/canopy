import { useEffect, useState, useRef } from "react";
import { View } from "react-native";
import {
  callKey,
  diagnosticsRanges,
  diagnosticsSorts,
  diagnosticsKinds,
  DiagnosticsPages,
  sortCalls,
} from "@canopy/domain/diagnostics";
import { SettingChoice, SettingsGroup, SettingsActions } from "./SettingsGroup";
import { ResourceState } from "./resource";
import { useDiagnosticsResource } from "./diagnostics-resource";
import { DiagnosticsComputer, DiagnosticsFindings } from "./DiagnosticsComputer";
import { DiagnosticsCalls } from "./DiagnosticsCalls";
import { DiagnosticsGrants } from "./DiagnosticsGrants";
import { Button } from "../../ui/components";
import { MinimumTouchTarget } from "../../ui/density";

export function DiagnosticsSettings() {
  const [range, setRange] = useState("15");
  const [selected, setSelected] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState("p95");
  const [kind, setKind] = useState("unary");
  const pages = useRef(new DiagnosticsPages());
  const [order, setOrder] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);

  const overview = useDiagnosticsResource(`GetDiagnostics:${range}`, (api) =>
    api.getDiagnostics({ windowMinutes: Number(range) }),
  );

  const computer = selected || overview.data?.computers[0]?.computerId || "";
  const detailKey = `GetComputerDiagnostics:${computer}:${range}:${offset}:${sort}:${kind}`;

  const detail = useDiagnosticsResource(
    detailKey,
    async (api) =>
      pages.current.remember(
        detailKey,
        await api.getComputerDiagnostics({
          computerId: computer,
          windowMinutes: Number(range),
          offset,
          limit: 32,
          sortBy: sort,
          callKind: kind,
          methodKeys: pages.current.keys.get(detailKey) ?? [],
        }),
      ),
    Boolean(computer),
  );

  const data = detail.data?.computerId === computer ? detail.data : undefined;
  const scope = detailKey;

  useEffect(() => {
    setOrder([]);
  }, [scope]);
  useEffect(() => {
    if (!order.length && data?.calls.length) setOrder(sortCalls(data.calls, sort).map(callKey));
  }, [data, order.length, sort]);

  function select(value: string) {
    setSelected(value);
    setOffset(0);
  }

  function chooseSort(value: string) {
    setSort(value);
    setOffset(0);
    setOrder(sortCalls(data?.calls ?? [], value).map(callKey));
  }

  const ranks = new Map(order.map((key, index) => [key, index]));

  const calls = [...(data?.calls ?? [])].sort(
    (a, b) =>
      (ranks.get(callKey(a)) ?? Infinity) - (ranks.get(callKey(b)) ?? Infinity) || callKey(a).localeCompare(callKey(b)),
  );

  return (
    <MinimumTouchTarget.Provider value={48}>
      <ResourceState resource={overview}>
        <SettingsGroup title="Diagnostics" description="Check performance across your computers.">
          <SettingChoice
            title="Time range"
            value={range}
            options={diagnosticsRanges}
            onChange={(value) => {
              setRange(value);
              setOffset(0);
            }}
          />
          {overview.data ? (
            <SettingChoice
              title="Computer"
              value={computer}
              options={overview.data.computers.map((item) => ({ value: item.computerId, label: item.name }))}
              onChange={select}
            />
          ) : null}
        </SettingsGroup>
        {overview.data?.computers.map((item) => (
          <DiagnosticsComputer key={item.computerId} computer={item} onSelect={() => select(item.computerId)} />
        ))}
        {overview.data ? (
          <DiagnosticsFindings
            computers={overview.data.computers}
            expanded={expanded}
            onExpand={() => setExpanded(!expanded)}
          />
        ) : null}
        <ResourceState resource={detail}>
          <SettingsGroup>
            <SettingChoice title="Sort calls" value={sort} options={diagnosticsSorts} onChange={chooseSort} />
            <SettingChoice
              title="Call type"
              value={kind}
              options={diagnosticsKinds}
              onChange={(value) => {
                setKind(value);
                setOffset(0);
              }}
            />
          </SettingsGroup>
          {data ? <DiagnosticsCalls calls={calls} computer={data} /> : null}
          {offset || data?.nextOffset ? (
            <SettingsActions>
              <View style={{ minHeight: 48, justifyContent: "center" }}>
                <Button title="Previous" disabled={!offset} onPress={() => setOffset(Math.max(0, offset - 32))} />
              </View>
              <View style={{ minHeight: 48, justifyContent: "center" }}>
                <Button title="Next" disabled={!data?.nextOffset} onPress={() => setOffset(data?.nextOffset ?? 0)} />
              </View>
            </SettingsActions>
          ) : null}
        </ResourceState>
        <DiagnosticsGrants />
      </ResourceState>
    </MinimumTouchTarget.Provider>
  );
}
