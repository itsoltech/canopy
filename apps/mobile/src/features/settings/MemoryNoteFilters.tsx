import { useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { memoryScopes } from "@canopy/domain/memory-scopes";
import { Button } from "../../ui/Button";
import { PickerSheet, SelectField, type PickerOption } from "../../ui/Picker";
import { SearchField } from "../../ui/SearchField";
import { SettingsGroupHeader } from "./SettingsGroup";
import type { useMemoryNotes } from "./use-memory-notes";

const scopes = memoryScopes.map(({ scope, label }) => ({ value: scope, label }));

const filterChoices = (all: string, options: ui.MemoryFilterOption[]) => [
  { value: "", label: all },
  ...options.map(({ id, label }) => ({ value: id, label })),
];

export function MemoryNoteFilters({ notes }: { notes: ReturnType<typeof useMemoryNotes> }) {
  const { options, filters, change } = notes;
  const [width, setWidth] = useState(0);
  const cell = { flexBasis: width >= 544 ? 0 : "46%", flexGrow: 1, minWidth: 0 } as const;

  return (
    <View style={{ gap: 12 }}>
      <SettingsGroupHeader title="Memory" description="Notes that agents and bots save for future turns." />
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}
      >
        {options && (
          <SearchField
            label="Search notes"
            value={notes.search}
            onChange={(value) => notes.setSearch(value.slice(0, 200))}
            style={{ flexBasis: width >= 768 ? 0 : "100%", flexGrow: 2, minWidth: 0 }}
          />
        )}
        <View style={cell}>
          <FilterPicker label="Scope" value={filters.scope} options={scopes} onChange={(scope) => change({ scope })} />
        </View>
        {options && (
          <>
            <View style={cell}>
              <FilterPicker
                label="Project"
                search="Find a project"
                value={filters.projectId}
                options={filterChoices("All projects", options.projects)}
                onChange={(projectId) => change({ projectId })}
              />
            </View>
            <View style={cell}>
              <FilterPicker
                label="Worker"
                search="Find a worker"
                value={filters.workerId}
                options={filterChoices("All workers", options.workers)}
                onChange={(workerId) => change({ workerId })}
              />
            </View>
            <View style={[cell, { alignItems: "flex-end" }]}>
              <Button variant="ghost" title="Clear filters" disabled={!notes.filtered} onPress={notes.clear} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

function FilterPicker<T extends number | string>({
  label,
  value,
  options,
  search,
  onChange,
}: {
  label: string;
  value: T;
  options: PickerOption<T>[];
  search?: string;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((item) => item.value === value)?.label ?? `${label} ${String(value).slice(0, 8)}`;

  return (
    <>
      <SelectField hideLabel label={label} value={current} expanded={open} onPress={() => setOpen(true)} />
      <PickerSheet
        title={label}
        value={value}
        visible={open}
        search={search}
        sections={[{ options }]}
        onClose={() => setOpen(false)}
        onSelect={onChange}
      />
    </>
  );
}
