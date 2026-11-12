import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { permissionLabel, permissionLook, permissionModes, pickPermission } from "../threads/permissions";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";

export function SubagentPermissionSettings({ settings }: { settings: ReturnType<typeof useAppearance> }) {
  const [open, setOpen] = useState(false);
  const defaults = create(ui.ThreadDefaultsSchema, settings.user?.threadDefaults);
  const value = defaults.subagentPermissionMode;

  return (
    <>
      <SettingsGroup
        title="Subagents"
        description="New subagents keep their mode when the parent’s permissions change."
      >
        <SettingsRow
          title="Permissions"
          description="A fixed mode can limit access, up to the parent’s current permissions."
          control={
            <SelectField
              label="Subagent permissions"
              hideLabel
              value={value === PermissionMode.UNSPECIFIED ? "Same as parent" : permissionLabel(value)}
              onPress={() => setOpen(true)}
              disabled={!settings.user || settings.saving}
            />
          }
        />
      </SettingsGroup>
      <PickerSheet
        title="Subagent permissions"
        visible={open}
        onClose={() => setOpen(false)}
        value={value}
        onSelect={(mode) =>
          pickPermission(mode, value, (subagentPermissionMode) => {
            void settings.update({
              threadDefaults: create(ui.ThreadDefaultsSchema, { ...defaults, subagentPermissionMode }),
            });
          })
        }
        sections={[
          {
            options: [
              { value: PermissionMode.UNSPECIFIED, label: "Same as parent" },
              ...permissionModes.map((mode) => ({
                value: mode.mode,
                label: mode.label,
                description: mode.description,
                ...permissionLook(mode.mode),
              })),
            ],
          },
        ]}
      />
    </>
  );
}
