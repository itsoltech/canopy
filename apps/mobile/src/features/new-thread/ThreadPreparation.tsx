import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { Spinner } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { useReducedMotion } from "../../ui/motion";
import { font, useColors, useTypography } from "../../ui/theme";
import { useCopyText } from "../viewers/useCopyText";

const statuses = new Map([
  ["pending", "Pending"],
  ["running", "In progress"],
  ["completed", "Done"],
  ["skipped", "Skipped"],
  ["failed", "Failed"],
]);

const icons = new Map<string, IconName>([
  ["pending", "minus"],
  ["running", "clock"],
  ["completed", "check"],
  ["skipped", "minus"],
  ["failed", "x-mark"],
]);

/** The same preparation steps stay beneath the first message after the thread opens. */
export function ThreadPreparation({
  steps,
  done = false,
  active = true,
}: {
  steps: readonly ui.CreateThreadProgress[];
  done?: boolean;
  active?: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const failed = steps.some((step) => step.status === "failed");
  const complete = done || steps.some((step) => step.step === "start_thread" && step.status === "completed");

  return (
    <View style={layout.checklist}>
      <Text accessibilityRole="header" style={[type.chrome, { fontFamily: font.medium, color: c.text }]}>
        {complete ? "Thread prepared" : failed || !active ? "Thread preparation" : "Preparing thread…"}
      </Text>
      {steps.map((step) => (
        <PreparationStep key={step.step} step={step} active={active} />
      ))}
    </View>
  );
}

function PreparationStep({ step, active }: { step: ui.CreateThreadProgress; active: boolean }) {
  const c = useColors();
  const type = useTypography();
  const reduced = useReducedMotion();
  const failed = step.status === "failed";
  const color = failed ? c.danger : step.status === "running" ? c.text : c.muted;
  const status = statuses.get(step.status) ?? step.status;
  const detail = !failed ? step.detail : "";

  return (
    <View style={layout.step}>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        accessibilityLabel={[step.label, status, detail].filter(Boolean).join(". ")}
        style={layout.row}
      >
        <View accessible={false} style={[layout.indicator, { height: type.chrome.lineHeight }]}>
          {step.status === "running" && active && !reduced ? (
            <Spinner size={14} color={color} />
          ) : (
            <Icon name={icons.get(step.status) ?? "minus"} size={14} color={color} />
          )}
        </View>
        <View style={layout.label}>
          <Text style={[type.chrome, { color }]}>{step.label}</Text>
          {detail ? <Text style={[type.meta, { color: c.muted }]}>{detail}</Text> : null}
        </View>
        <Text style={[type.meta, { color, width: type.meta.fontSize * 6.5, textAlign: "right" }]}>{status}</Text>
      </View>
      {failed && step.detail ? <FailureDetails detail={step.detail} /> : null}
    </View>
  );
}

function FailureDetails({ detail }: { detail: string }) {
  const c = useColors();
  const type = useTypography();
  const [expanded, setExpanded] = useState(false);
  const { copy } = useCopyText(detail);

  return (
    <View style={layout.details}>
      <Button
        title={expanded ? "Hide details" : "Show details"}
        variant="text"
        size="sm"
        onPress={() => setExpanded(!expanded)}
      />
      {expanded && (
        <>
          <Text selectable style={[type.meta, { color: c.muted }]}>
            {detail}
          </Text>
          <Button title="Copy details" variant="text" size="sm" onPress={() => void copy()} />
        </>
      )}
    </View>
  );
}

const layout = StyleSheet.create({
  checklist: { gap: 8, minWidth: 0 },
  step: { gap: 4, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  indicator: { width: 16, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, minWidth: 0 },
  details: { paddingLeft: 24, gap: 4 },
});
