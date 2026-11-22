import type { ui } from "@canopy/contracts";
import { ComposerPill } from "./ComposerBox";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { useEffortLabel } from "../settings/display";
import { EffortPickerSheet, ModelPickerSheet } from "../models/ModelPicker";
import { SpeedIcon, SpeedPickerSheet, effectiveSpeed, speedLabel } from "../models/SpeedPicker";
import { PermissionPickerSheet } from "./permissions";
import type { useComposerSettings } from "./useComposerSettings";

export function ComposerControls({
  state,
  thread,
}: {
  state: ReturnType<typeof useComposerSettings>;
  thread: ui.Thread | undefined;
}) {
  const { setPicker, current, effort, serviceTier } = state;
  const effortLabel = useEffortLabel();

  return (
    <>
      <ComposerPill
        icon="cpu-chip"
        leading={thread ? <ProviderIcon provider={thread.provider} /> : undefined}
        title={current?.name || "Model"}
        loadingWidth={128}
        loading={!thread || (!current && !state.section?.choices.length)}
        onPress={() => setPicker("model")}
      />
      {!current || current.efforts.length ? (
        <ComposerPill
          icon="light-bulb"
          title={effortLabel(effort)}
          loadingWidth={72}
          loading={!current}
          onPress={() => setPicker("effort")}
        />
      ) : null}
      {current?.serviceTiers.length || state.hasConfiguredSpeed ? (
        <ComposerPill
          icon="bolt"
          leading={<SpeedIcon value={effectiveSpeed(current, serviceTier, state.inheritedServiceTier)} />}
          title={speedLabel(current, serviceTier, state.inheritedServiceTier)}
          accessibilityLabel={`Speed: ${speedLabel(current, serviceTier, state.inheritedServiceTier)}`}
          onPress={() => setPicker("speed")}
        />
      ) : null}
    </>
  );
}

export function ComposerPickers({
  state,
  allowPermission = true,
}: {
  state: ReturnType<typeof useComposerSettings>;
  allowPermission?: boolean;
}) {
  const { picker, setPicker, section, current, effort, serviceTier, permissionMode, update } = state;
  const close = () => setPicker(null);

  return (
    <>
      <ModelPickerSheet
        visible={picker === "model"}
        onClose={close}
        sections={section ? [section] : []}
        value={current?.key}
        onSelect={(choice) =>
          update({
            model: choice.model,
            // Keep the effort only when the new model takes it.
            effort: choice.efforts.includes(effort) ? effort : choice.defaultEffort,
            serviceTier: serviceTier === "default" || choice.serviceTiers.includes(serviceTier) ? serviceTier : "",
          })
        }
      />
      <EffortPickerSheet
        visible={picker === "effort"}
        onClose={close}
        choice={current}
        value={effort}
        onSelect={(next) => update({ effort: next })}
      />
      <SpeedPickerSheet
        visible={picker === "speed"}
        onClose={close}
        choice={current}
        value={serviceTier}
        configured={state.hasConfiguredSpeed}
        onSelect={(next) => update({ serviceTier: next })}
      />
      <PermissionPickerSheet
        visible={allowPermission && picker === "permission"}
        onClose={close}
        value={permissionMode}
        onSelect={(mode) => {
          if (allowPermission) update({ permissionMode: mode });
        }}
      />
    </>
  );
}
