import { useState } from "react";
import { View } from "react-native";
import type { bots } from "@canopy/contracts";
import { splitId, nodeRef } from "@canopy/domain/computers";
import { useOverview } from "../../state/overview";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { useModelCatalog, modelSections } from "../models/catalog";
import { ModelPickerSheet, EffortPickerSheet } from "../models/ModelPicker";
import { SpeedIcon, SpeedPickerSheet, effectiveSpeed, speedLabel } from "../models/SpeedPicker";
import { useWorkerOptions } from "../computers/worker-options";
import { Notice } from "../../ui/components";

export function BotModelSettings({
  bot,
  config,
  onChange,
  disabled,
  guided = false,
}: {
  bot: bots.Bot;
  config: bots.BotConfiguration;
  onChange: (c: bots.BotConfiguration) => void;
  disabled: boolean;
  guided?: boolean;
}) {
  const { workers } = useOverview();
  const workerOptions = useWorkerOptions();
  const [picker, setPicker] = useState(guided ? "model" : "");
  const homeWorkers = workers.filter((w) => splitId(w.id).node === (bot.nodeId ? nodeRef(bot.nodeId) : undefined));

  const worker = config.workerId
    ? homeWorkers.find((w) => w.id === config.workerId)
    : homeWorkers.find((w) => w.online);

  const catalog = useModelCatalog(worker?.id);
  const sections = modelSections(worker, catalog);

  const choice = sections
    .flatMap((s) => s.choices)
    .find(
      (m) =>
        m.provider === config.provider &&
        (m.profileId || "native") === config.providerInstance &&
        m.model === config.model,
    );

  return (
    <View style={{ gap: 12 }}>
      {guided && !config.model && <Notice>First, choose a model for this bot.</Notice>}
      <SelectField
        label="Runs on"
        value={config.workerId ? worker?.name || "Worker unavailable" : "Automatic"}
        disabled={disabled}
        onPress={() => setPicker("worker")}
      />
      <SelectField
        label="Model"
        value={choice?.name || config.model || "Default model"}
        disabled={disabled}
        onPress={() => setPicker("model")}
      />
      <SelectField
        label="Reasoning effort"
        value={config.effort || "Default"}
        disabled={disabled || !choice?.efforts.length}
        onPress={() => setPicker("effort")}
      />
      {choice?.serviceTiers.length || config.serviceTier ? (
        <SelectField
          label="Speed"
          value={speedLabel(choice, config.serviceTier)}
          leading={<SpeedIcon value={effectiveSpeed(choice, config.serviceTier)} />}
          disabled={disabled}
          onPress={() => setPicker("speed")}
        />
      ) : null}
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
        onSelect={(workerId) => onChange({ ...config, workerId, serviceTier: "" })}
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
