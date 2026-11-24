import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Provider, type bots } from "@canopy/contracts";
import { splitId, nodeRef } from "@canopy/domain/computers";
import { useOverview } from "../../state/overview";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { useModelCatalog, modelSections, type ModelChoice } from "../models/catalog";
import { ModelPickerSheet, EffortPickerSheet } from "../models/ModelPicker";
import { SpeedIcon, SpeedPickerSheet, effectiveSpeed, speedLabel } from "../models/SpeedPicker";
import { useWorkerOptions } from "../computers/worker-options";
import { ProviderIcon } from "../../ui/ProviderIcon";

export function BotModelSettings({
  bot,
  config,
  onChange,
  disabled,
  renderFields,
}: {
  bot: bots.Bot;
  config: bots.BotConfiguration;
  onChange: (c: bots.BotConfiguration) => void;
  disabled: boolean;
  renderFields?: (fields: { model: ReactNode; runtime: ReactNode }) => ReactNode;
}) {
  const { workers } = useOverview();
  const workerOptions = useWorkerOptions();
  const [picker, setPicker] = useState("");
  const homeWorkers = workers.filter((w) => splitId(w.id).node === (bot.nodeId ? nodeRef(bot.nodeId) : undefined));
  const automaticWorker = homeWorkers.find((w) => w.online);
  const worker = config.workerId ? homeWorkers.find((w) => w.id === config.workerId) : automaticWorker;

  const catalog = useModelCatalog(worker?.id);
  const sections = modelSections(worker, catalog);
  const creating = !!renderFields;

  const choice = sections
    .flatMap((s) => s.choices)
    .find(
      (m) =>
        m.provider === config.provider &&
        (m.profileId || "native") === config.providerInstance &&
        m.model === config.model,
    );

  const workerField = (
    <SelectField
      label="Runs on"
      value={config.workerId ? worker?.name || "Worker unavailable" : "Automatic"}
      disabled={disabled}
      onPress={() => setPicker("worker")}
    />
  );

  const modelField = (
    <SelectField
      label="Model"
      value={choice?.name || config.model || (creating ? "Choose a model" : "Default model")}
      leading={creating && config.provider ? <ProviderIcon provider={config.provider} size={18} /> : undefined}
      disabled={disabled}
      expanded={picker === "model"}
      onPress={() => setPicker("model")}
    />
  );

  const tuning = <BotTuningFields config={config} choice={choice} disabled={disabled} onPick={setPicker} />;

  return (
    <View style={{ gap: creating ? 16 : 12 }}>
      {renderFields ? (
        renderFields({
          model: modelField,
          runtime: (
            <View style={{ gap: 12 }}>
              {workerField}
              {tuning}
            </View>
          ),
        })
      ) : (
        <>
          {workerField}
          {modelField}
          {tuning}
        </>
      )}
      <PickerSheet
        title="Runs on"
        visible={picker === "worker"}
        onClose={() => setPicker("")}
        value={config.workerId}
        sections={[
          {
            options: [{ value: "", label: "Automatic", badge: undefined }, ...workerOptions(homeWorkers)],
          },
        ]}
        onSelect={(workerId) =>
          onChange(workerConfiguration(config, workerId, creating, (workerId || automaticWorker?.id) === worker?.id))
        }
      />
      <ModelPickerSheet
        visible={picker === "model"}
        onClose={() => setPicker("")}
        sections={sections}
        value={choice?.key}
        onSelect={(m) =>
          onChange({
            ...config,
            provider: m.provider,
            providerInstance: m.profileId || "native",
            model: m.model,
            effort: m.defaultEffort,
            serviceTier:
              m.provider === config.provider &&
              (m.profileId || "native") === config.providerInstance &&
              (config.serviceTier === "default" || m.serviceTiers.includes(config.serviceTier))
                ? config.serviceTier
                : "",
          })
        }
      />
      <SpeedPickerSheet
        visible={picker === "speed"}
        onClose={() => setPicker("")}
        choice={choice}
        value={config.serviceTier}
        onSelect={(serviceTier) => onChange({ ...config, serviceTier })}
      />
      <EffortPickerSheet
        visible={picker === "effort"}
        onClose={() => setPicker("")}
        choice={choice}
        value={config.effort}
        onSelect={(effort) => onChange({ ...config, effort })}
      />
    </View>
  );
}

function workerConfiguration(config: bots.BotConfiguration, workerId: string, creating: boolean, sameWorker: boolean) {
  if (!creating) return { ...config, workerId, serviceTier: "" };

  if (sameWorker) return { ...config, workerId };

  return {
    ...config,
    workerId,
    provider: Provider.UNSPECIFIED,
    providerInstance: "native",
    model: "",
    effort: "",
    serviceTier: "",
  };
}

function BotTuningFields({
  config,
  choice,
  disabled,
  onPick,
}: {
  config: bots.BotConfiguration;
  choice: ModelChoice | undefined;
  disabled: boolean;
  onPick: (picker: "effort" | "speed") => void;
}) {
  return (
    <>
      <SelectField
        label="Reasoning effort"
        value={config.effort || "Default"}
        disabled={disabled || !choice?.efforts.length}
        onPress={() => onPick("effort")}
      />
      {choice?.serviceTiers.length || config.serviceTier ? (
        <SelectField
          label="Speed"
          value={speedLabel(choice, config.serviceTier)}
          leading={<SpeedIcon value={effectiveSpeed(choice, config.serviceTier)} />}
          disabled={disabled}
          onPress={() => onPick("speed")}
        />
      ) : null}
    </>
  );
}
