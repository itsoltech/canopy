import { PickerSheet } from "../../ui/Picker";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { type ModelChoice, type ModelSection } from "./catalog";
import { useEffortLabel } from "../settings/display";

/** Models grouped by provider instance, with search once the list gets long. */
export function ModelPickerSheet({
  visible,
  onClose,
  sections,
  value,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  sections: ModelSection[];
  /** `ModelChoice.key` of the current model. */
  value: string | undefined;
  onSelect: (choice: ModelChoice) => void;
}) {
  const choices = sections.flatMap((s) => s.choices);

  return (
    <PickerSheet
      title="Model"
      visible={visible}
      onClose={onClose}
      search={choices.length > 6 ? "Search models" : undefined}
      value={value}
      onSelect={(key) => {
        const picked = choices.find((c) => c.key === key);

        if (picked) onSelect(picked);
      }}
      note={choices.length ? undefined : "The worker has not listed its models yet."}
      sections={sections.map((section) => ({
        title: sections.length > 1 ? section.title : undefined,
        options: section.choices.map((c) => ({
          value: c.key,
          label: c.name,
          badge: c.isDefault ? "Default" : undefined,
          leading: <ProviderIcon provider={c.provider} size={18} />,
          keywords: `${c.model} ${section.title}`,
        })),
      }))}
    />
  );
}

/** Reasoning efforts of one model, lowest first; "Default" follows the model's own default. */
export function EffortPickerSheet({
  visible,
  onClose,
  choice,
  value,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  choice: ModelChoice | undefined;
  value: string;
  onSelect: (effort: string) => void;
}) {
  const effortLabel = useEffortLabel();

  return (
    <PickerSheet
      title="Reasoning effort"
      visible={visible}
      onClose={onClose}
      value={value}
      onSelect={onSelect}
      sections={[
        {
          options: (choice?.efforts ?? []).map((id) => ({
            value: id,
            label: effortLabel(id),
            badge: id === choice?.defaultEffort ? "Default" : undefined,
            icon: "light-bulb" as const,
          })),
        },
      ]}
    />
  );
}
