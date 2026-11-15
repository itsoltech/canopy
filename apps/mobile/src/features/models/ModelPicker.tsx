import { useState } from "react";
import { PickerSheet } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
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
  preferFavorites = false,
}: {
  visible: boolean;
  onClose: () => void;
  sections: ModelSection[];
  /** `ModelChoice.key` of the current model. */
  value: string | undefined;
  onSelect: (choice: ModelChoice) => void;
  preferFavorites?: boolean;
}) {
  const choices = sections.flatMap((s) => s.choices);
  const hasFavorites = choices.some((choice) => choice.favorite);
  const [filter, setFilter] = useState<"favorites" | "all">();
  const [query, setQuery] = useState("");
  const activeFilter = hasFavorites ? (filter ?? (preferFavorites ? "favorites" : "all")) : "all";

  const shown = sections
    .map((section) => ({
      ...section,
      choices: section.choices.filter((choice) => query.trim() || activeFilter === "all" || choice.favorite),
    }))
    .filter((section) => section.choices.length);

  return (
    <PickerSheet
      title="Model"
      visible={visible}
      onClose={onClose}
      search={choices.length > 6 ? "Search models" : undefined}
      onQueryChange={setQuery}
      value={value}
      header={
        hasFavorites ? (
          <Segmented
            compact
            style={{ marginHorizontal: 16, marginVertical: 8 }}
            options={[
              { value: "favorites", label: "Favorites" },
              { value: "all", label: "All" },
            ]}
            value={activeFilter}
            onChange={setFilter}
          />
        ) : undefined
      }
      onSelect={(key) => {
        const picked = choices.find((c) => c.key === key);

        if (picked) onSelect(picked);
      }}
      note={choices.length ? undefined : "The worker has not listed its models yet."}
      sections={shown.map((section) => ({
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
