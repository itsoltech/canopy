import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { PickerSheet } from "../../ui/Picker";
import { SettingSelectRow } from "./SettingsGroup";

export function EnvironmentTags({
  title,
  description,
  workers,
  tags,
  onChange,
}: {
  title: string;
  description?: string;
  workers: ui.EnvironmentWorker[];
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const counts = new Map(tags.map((tag) => [tag, 0]));

  for (const worker of workers) {
    for (const tag of new Set([...worker.automaticTags, ...worker.manualTags])) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const options = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, count]) => ({
      value: tag,
      label: tag,
      description: `${count} ${count === 1 ? "computer" : "computers"}`,
    }));

  const tag = query.trim().toLowerCase();

  if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag) && !counts.has(tag)) {
    options.push({ value: tag, label: `Create “${tag}”`, description: "" });
  }

  return (
    <SettingSelectRow
      title={title}
      description={description}
      value={tags.join(", ") || "Find or create a tag"}
      expanded={open}
      onPress={() => setOpen(true)}
    >
      <PickerSheet
        title={title}
        search="Find or create a tag"
        onQueryChange={setQuery}
        visible={open}
        selected={tags}
        sections={[{ options }]}
        onSelect={(value) => onChange(tags.includes(value) ? tags.filter((item) => item !== value) : [...tags, value])}
        onClose={() => setOpen(false)}
      />
    </SettingSelectRow>
  );
}
