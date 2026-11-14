import { useState } from "react";
import { Text, View } from "react-native";
import {
  ACCESS_SEARCH_THRESHOLD,
  accessSummary,
  accessToggled,
  accessWithAll,
  sameAccess,
  type AccessChoice,
} from "@canopy/domain/access-picker";
import { PickerSheet, SelectField, type PickerSection } from "../../ui/Picker";
import { Switch } from "../../ui/Switch";
import { font, styles, useColors } from "../../ui/theme";
import { SettingsRow } from "./SettingsGroup";

export interface AccessOption {
  id: string;
  name: string;
  /** Heading of consecutive options (a linked computer); shown when there is more than one. */
  group?: string;
  online?: boolean;
  /** Why it cannot be changed here. */
  readOnly?: string;
}

/**
 * Who may use something, as one settings row: a summary ("All workers", "3 of 12 workers") that opens a
 * checklist sheet with an "All" switch and a search for long lists. `onChange` gets the choice once, when the
 * sheet closes; the caller saves it. Same model as the web access picker.
 */
export function SettingAccess({
  title,
  description,
  noun = title.toLowerCase(),
  options,
  all = false,
  ids,
  allowAll = true,
  disabled,
  onChange,
}: {
  title: string;
  description?: string;
  noun?: string;
  options: AccessOption[];
  all?: boolean;
  ids: readonly string[];
  allowAll?: boolean;
  disabled?: boolean;
  onChange: (next: AccessChoice) => void;
}) {
  const current: AccessChoice = { all: allowAll && all, ids };
  const [draft, setDraft] = useState<AccessChoice>();
  const shown = draft ?? current;
  const selectable = options.filter((o) => !o.readOnly).map((o) => o.id);
  const allOn = allowAll && shown.all;

  function close() {
    if (draft && !sameAccess(draft, current)) onChange({ all: draft.all, ids: [...draft.ids] });
    setDraft(undefined);
  }

  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <>
          <SelectField
            hideLabel
            label={title}
            value={accessSummary(shown, options, noun)}
            disabled={disabled}
            onPress={() => setDraft({ all: current.all, ids: [...current.ids] })}
          />
          <PickerSheet
            title={title}
            visible={!!draft}
            onClose={close}
            sections={accessSections(options, allOn)}
            selected={allOn ? options.map((o) => o.id) : shown.ids}
            onSelect={(id) => setDraft(accessToggled(shown, id, !shown.ids.includes(id)))}
            search={options.length > ACCESS_SEARCH_THRESHOLD ? `Search ${noun}` : undefined}
            note={options.length ? undefined : `No ${noun} yet.`}
            header={
              allowAll ? (
                <AllRow
                  noun={noun}
                  value={shown.all}
                  onChange={(on) => setDraft(accessWithAll(shown, on, selectable))}
                />
              ) : undefined
            }
          />
        </>
      }
    />
  );
}

function accessSections(options: AccessOption[], allOn: boolean): PickerSection<string>[] {
  const grouped = new Set(options.map((o) => o.group)).size > 1;
  const sections: PickerSection<string>[] = [];

  for (const option of options) {
    const title = grouped ? option.group : undefined;
    let section = sections.at(-1);

    if (!section || section.title !== title) {
      section = { id: `${title ?? ""}-${sections.length}`, title, options: [] };
      sections.push(section);
    }

    section.options.push({
      value: option.id,
      label: option.name,
      online: option.online,
      badge: option.readOnly ? "Read-only" : undefined,
      disabled: allOn || !!option.readOnly,
    });
  }

  return sections;
}

function AllRow({ noun, value, onChange }: { noun: string; value: boolean; onChange: (on: boolean) => void }) {
  const c = useColors();

  return (
    <View style={[styles.row, { gap: 12, paddingHorizontal: 16, paddingVertical: 8 }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[styles.overlay, { fontFamily: font.medium, color: c.strong }]}>All {noun}</Text>
        <Text style={[styles.overlayMeta, { color: c.muted }]}>Includes {noun} added later.</Text>
      </View>
      <Switch label={`All ${noun}`} value={value} onChange={onChange} />
    </View>
  );
}
