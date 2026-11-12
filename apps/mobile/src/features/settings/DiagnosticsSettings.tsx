import { useState, useRef } from "react";
import { View } from "react-native";
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
import { Button } from "../../ui/components";
import { MinimumTouchTarget } from "../../ui/density";

export function DiagnosticsSettings() {
  const [range, setRange] = useState("15");
  const [selected, setSelected] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState("p95");
  const [kind, setKind] = useState("unary");
  const pages = useRef(new DiagnosticsPages());
  const [expanded, setExpanded] = useState(false);

  const overview = useDiagnosticsResource(`GetDiagnostics:${range}`, async (api) => {
    const value = await api.getDiagnostics({ windowMinutes: Number(range) });

    if (value.computers.some((computer) => !diagnosticsEpochs.accept(computer)))
      throw new Error("Diagnostics baseline changed; refresh again");

    return value;
  });

  const computer = selected || overview.data?.computers[0]?.computerId || "";
  const detailKey = `GetComputerDiagnostics:${computer}:${range}:${offset}:${sort}:${kind}`;

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

  const data = detail.data?.computerId === computer ? detail.data : undefined;

  function select(value: string) {
    setSelected(value);
    setOffset(0);
  }

  function chooseSort(value: string) {
    setSort(value);
    setOffset(0);
  }

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
        {overview.data ? (
          <DiagnosticsActions
            computers={overview.data.computers}
            range={Number(range)}
            computer={data}
            onReset={async () => {
              await overview.reload();
              await detail.reload();
            }}
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
          {data ? <DiagnosticsMetrics computer={data} /> : null}
          {data ? <DiagnosticsLinks computer={data} /> : null}
          {data ? <DiagnosticsClients computer={data} /> : null}
          {data ? <DiagnosticsCalls calls={data.calls} computer={data} /> : null}
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
