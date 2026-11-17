import { View } from "react-native";
import { Icon } from "../../ui/Icon";
import type { ModelChoice } from "./catalog";
import { PickerSheet } from "../../ui/Picker";

export function effectiveSpeed(choice: ModelChoice | undefined, value: string, inherited = "") {
  const tier = value || inherited;

  return tier === "default" || choice?.serviceTiers.includes(tier) ? tier : "";
}

export function speedLabel(choice: ModelChoice | undefined, value: string, inherited = "") {
  const tier = effectiveSpeed(choice, value, inherited);

  return tier === "default"
    ? "Standard"
    : choice?.serviceTierOptions.find((option) => option.id === tier)?.name || "Default";
}

/** Every mode keeps the same icon slot, including the two overlapping bolts. */
export function SpeedIcon({ value }: { value: string }) {
  const accelerated = Boolean(value && value !== "default");

  return (
    <View style={{ width: 24, height: 16, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
      {value === "ultrafast" ? (
        <>
          <View style={{ position: "absolute", left: 1 }}>
            <Icon name="bolt" size={14} />
          </View>
          <View style={{ position: "absolute", right: 1 }}>
            <Icon name="bolt" size={14} />
          </View>
        </>
      ) : (
        <Icon name={accelerated ? "bolt" : "clock"} size={14} />
      )}
    </View>
  );
}

/** Speed options belong to the selected model and provider account's live catalog. */
export function SpeedPickerSheet({
  visible,
  onClose,
  choice,
  value,
  onSelect,
  configured = false,
}: {
  visible: boolean;
  onClose: () => void;
  choice: ModelChoice | undefined;
  value: string;
  onSelect: (value: string) => void;
  configured?: boolean;
}) {
  if (!choice?.serviceTiers.length && !configured && !value) return null;

  return (
    <PickerSheet
      title="Speed"
      visible={visible}
      onClose={onClose}
      value={value}
      onSelect={onSelect}
      sections={[
        {
          options: [
            { value: "", label: "Default", leading: <SpeedIcon value="" /> },
            { value: "default", label: "Standard", leading: <SpeedIcon value="default" /> },
            ...(choice?.serviceTierOptions ?? [])
              .filter((tier) => tier.id !== "default")
              .map((tier) => ({
                value: tier.id,
                label: tier.name,
                leading: <SpeedIcon value={tier.id} />,
              })),
          ],
        },
      ]}
    />
  );
}
