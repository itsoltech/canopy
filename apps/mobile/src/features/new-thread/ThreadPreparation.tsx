import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { Rule, Spinner } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Chevron } from "../../ui/MotionViews";
import { useAnchoredToggle } from "../../ui/feed-anchor";
import { useReducedMotion } from "../../ui/motion";
import { font, useColors, useTypography } from "../../ui/theme";
import { TimelineDisclosure } from "../timeline/TimelineDisclosure";
import { useCopyText } from "../viewers/useCopyText";
import type { ThreadCreation } from "./thread-creations";

const prepared = "Thread prepared";

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
export function ThreadPreparation({ job }: { job: ThreadCreation }) {
  const c = useColors();
  const type = useTypography();
  const active = !job.done && !job.uncertain && !job.confirmed;
  const failed = (!job.confirmed && job.done && !job.uncertain) || job.steps.some((step) => step.status === "failed");

  const steps = (
    <View style={layout.checklist}>
      {job.steps.map((step) => (
        <PreparationStep key={step.step} step={step} active={active} />
      ))}
    </View>
  );

  if (job.confirmed && !failed && job.steps.length)
    return (
      <PreparedChecklist key={job.id} job={job}>
        {steps}
      </PreparedChecklist>
    );

  const heading = failed
    ? "Could not start thread"
    : job.confirmed
      ? prepared
      : active
        ? "Preparing thread…"
        : "Thread preparation";

  return (
    <View style={layout.checklist}>
      <Text accessibilityRole="header" style={[type.chrome, { fontFamily: font.medium, color: c.text }]}>
        {heading}
      </Text>
      {job.steps.length > 0 && steps}
    </View>
  );
}

function PreparedChecklist({ job, children }: { job: ThreadCreation; children: React.ReactNode }) {
  const c = useColors();
  const type = useTypography();
  const { header, toggle } = useAnchoredToggle();
  const [open, setOpen] = useState(job.preparationExpanded ?? false);

  const flip = () => {
    job.preparationExpanded = !job.preparationExpanded;
    setOpen(job.preparationExpanded);
  };

  return (
    <View>
      <Animated.View ref={header} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={prepared}
          accessibilityState={{ expanded: open }}
          onPress={() => toggle(flip)}
          style={layout.summary}
        >
          <Chevron open={open} color={c.faint} />
          <Text style={[type.chrome, layout.title, { fontFamily: font.medium, color: c.muted }]}>{prepared}</Text>
          <Rule />
        </Pressable>
      </Animated.View>
      <TimelineDisclosure open={open} style={layout.details}>
        {children}
      </TimelineDisclosure>
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
  summary: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingVertical: 8 },
  title: { flexShrink: 1, marginRight: 4 },
  step: { gap: 4, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  indicator: { width: 16, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, minWidth: 0 },
  details: { paddingLeft: 24, gap: 4 },
});
