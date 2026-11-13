import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { SettingsDisclosure } from "../settings/SettingsDisclosure";
import { UpdateDetails } from "./UpdateDetails";
import { useUpdates } from "./state";
import { bulkUpdatesAvailable, updateLabel } from "./model";

/** Loading and action errors share the same recovery controls in settings and the sheet. */
export function UpdateFeedback() {
  const { snapshot, error, details, reload, pending, dismissError } = useUpdates();
  const c = useColors();

  if (error)
    return (
      <View style={{ gap: 8, paddingVertical: 8 }}>
        <Text accessibilityRole="alert" style={[styles.overlayMeta, { color: c.danger }]}>
          {error}
        </Text>
        {!!details && <UpdateDetails text={details} />}
        <Button
          title="Reload updates"
          size="sm"
          disabled={!!pending}
          onPress={() => {
            dismissError();
            void reload();
          }}
        />
      </View>
    );

  if (snapshot) return null;

  return (
    <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted, paddingVertical: 12 }]}>
      Loading updates…
    </Text>
  );
}

export function UpdateRun({ run }: { run: ui.UpdateRun | undefined }) {
  const c = useColors();
  const { snapshot, pending, manage } = useUpdates();

  if (!run?.steps.length) return null;

  return (
    <SettingsDisclosure
      title={`Update all · ${run.state === "succeeded" ? "Complete" : updateLabel(run.state)}`}
      initiallyOpen={run.state === "running"}
    >
      <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted }]}>
        {run.steps.filter((step) => step.state === "succeeded").length}/
        {run.steps.filter((step) => step.state !== "skipped").length} updated
      </Text>
      {["failed", "blocked"].includes(run.state) && (
        <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
          {snapshot && bulkUpdatesAvailable(snapshot) && (
            <Button
              title="Request again"
              size="sm"
              disabled={!!pending}
              onPress={() => void manage({ action: "update_all" })}
            />
          )}
          <Button
            title="Dismiss"
            size="sm"
            disabled={!!pending}
            onPress={() => void manage({ action: "dismiss_run", desktopRequestId: run.id })}
          />
        </View>
      )}
      {run.steps.map((step, index) => (
        <View key={index} style={{ paddingVertical: 4, gap: 4 }}>
          <Text numberOfLines={2} style={[styles.overlay, { color: c.text }]}>
            {step.label} · {updateLabel(step.state)}
          </Text>
          {!!step.version && (
            <Text selectable style={[styles.overlayMeta, { color: c.muted }]}>
              {step.version}
            </Text>
          )}
          {!!step.reason && <UpdateDetails text={step.reason} />}
          {run.state !== "running" && ["failed", "blocked"].includes(step.state) && (
            <Button
              title="Retry update"
              size="sm"
              disabled={!!pending}
              onPress={() => void manage({ action: "retry_step", desktopRequestId: run.id, updateStepIndex: index })}
            />
          )}
        </View>
      ))}
    </SettingsDisclosure>
  );
}
