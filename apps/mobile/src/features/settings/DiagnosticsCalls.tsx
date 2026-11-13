import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  bytes,
  byteRate,
  messageClasses,
  callKey,
  duration,
  errorCount,
  grpcCodes,
  measured,
  diagnosticsUnavailable,
  histogramHelp,
} from "@canopy/domain/diagnostics";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { styles, useColors } from "../../ui/theme";
import { DiagnosticsDatabase } from "./DiagnosticsMetrics";

export function DiagnosticsCalls({
  calls,
  computer,
}: {
  calls: ui.DiagnosticsCall[];
  computer: ui.ComputerDiagnostics;
}) {
  const c = useColors();
  const [selected, setSelected] = useState("");

  return (
    <SettingsGroup
      title="Calls"
      description={`${computer.name} · ${computer.totalMethods} methods · ${computer.resolutionSeconds} s resolution`}
    >
      {!computer.detailsAvailable ? (
        <SettingsRow title={diagnosticsUnavailable(computer)[0]} description={diagnosticsUnavailable(computer)[1]} />
      ) : !calls.length ? (
        <SettingsRow title="No calls yet" description="Use Canopy to collect performance data." />
      ) : null}
      {calls.map((call) => (
        <View key={callKey(call)} style={{ gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: selected === callKey(call) }}
            onPress={() => setSelected(selected === callKey(call) ? "" : callKey(call))}
            style={{ minHeight: 48, gap: 4, justifyContent: "center" }}
          >
            <Text style={[styles.chrome, { color: c.text }]}>{call.method.split("/").at(-1)}</Text>
            <Text style={[styles.workMeta, { color: c.muted }]}>
              {call.layer} · {call.stream ? "Stream lifetime" : "Unary"}
            </Text>
            <Text style={[styles.workMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
              {call.callsPerMinute.toFixed(1)} calls/min · p95 {measured(call.durationMs)} ·{" "}
              {errorCount(call).toString()} errors · {call.inFlight} in flight
            </Text>
            <Text style={[styles.workMeta, { color: c.muted }]}>
              {selected === callKey(call) ? "Hide details" : "RPC details"}
            </Text>
          </Pressable>
          {selected === callKey(call) ? <CallEvidence call={call} observed={computer.observedSeconds} /> : null}
        </View>
      ))}
    </SettingsGroup>
  );
}

function CallEvidence({ call, observed }: { call: ui.DiagnosticsCall; observed: number }) {
  const c = useColors();

  const rows = [
    ["Started / completed", `${call.started} / ${call.completed}`],
    ["In flight / peak", `${call.inFlight} / ${call.maxInFlight}`],
    ["p50", measured(call.durationMs, "p50")],
    ["p99", measured(call.durationMs, "p99")],
    ["Max", measured(call.durationMs, "max")],
    ["Request size p95", bytes(call.requestBytes)],
    ["Response size p95", bytes(call.responseBytes)],
  ];

  if (call.stream)
    rows.push(
      ["Request bytes/s", byteRate(call.requestBytes, observed)],
      ["Response bytes/s", byteRate(call.responseBytes, observed)],
      ["Request messages", messageClasses(call, "request")],
      ["Response messages", messageClasses(call, "response")],
      ["First message p95", measured(call.firstMessageMs)],
      ["Oldest active", duration(call.oldestActiveMs)],
      [
        "Request / response messages/s",
        observed
          ? `${(Number(call.requestMessages) / observed).toFixed(2)} / ${(Number(call.responseMessages) / observed).toFixed(2)}`
          : "Not enough data",
      ],
    );
  call.codes.forEach((count, code) => {
    if (count) rows.push([grpcCodes[code] ?? "Unknown", count.toString()]);
  });

  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.workMeta, { color: c.muted }]}>{call.method}</Text>
      {rows.map(([label, value]) => (
        <View key={label} style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
          <Text style={[styles.workMeta, { color: c.muted }]}>{label}</Text>
          <Text style={[styles.workMeta, { color: c.text, fontVariant: ["tabular-nums"] }]}>{value}</Text>
        </View>
      ))}
      <Text style={[styles.workMeta, { color: c.muted }]}>
        {histogramHelp}
        {call.incomplete ? " Some measurements are missing." : ""}
      </Text>
      <DiagnosticsDatabase families={call.database} linked />
    </View>
  );
}
