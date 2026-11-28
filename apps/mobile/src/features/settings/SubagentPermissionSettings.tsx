import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { PickerSheet } from "../../ui/Picker";
import { permissionLabel, permissionLook, permissionModes, pickPermission } from "../threads/permissions";
import { SettingSelectRow, SettingsGroup } from "./SettingsGroup";
import { ResetSetting } from "./ResetSetting";

export function SubagentPermissionSettings({ settings }: { settings: ReturnType<typeof useAppearance> }) {
  const [open, setOpen] = useState(false);
  const defaults = create(ui.ThreadDefaultsSchema, settings.user?.threadDefaults);
  const value = defaults.subagentPermissionMode;

  const save = (subagentPermissionMode: PermissionMode) =>
    void settings.update({
      threadDefaults: create(ui.ThreadDefaultsSchema, { ...defaults, subagentPermissionMode }),
    });

  const disabled = !settings.user || settings.saving;

  return (
    <>
      <SettingsGroup
        title="Subagents"
        description="New subagents keep their mode when the parent’s permissions change."
      >
        <SettingSelectRow
          title="Permissions"
          label="Subagent permissions"
          description="A fixed mode can limit access, up to the parent’s current permissions."
          accessory={
            <ResetSetting
              label="Reset subagent permissions"
              changed={value !== PermissionMode.UNSPECIFIED}
              disabled={disabled}
              onReset={() => save(PermissionMode.UNSPECIFIED)}
            />
          }
          value={value === PermissionMode.UNSPECIFIED ? "Same as parent" : permissionLabel(value)}
          expanded={open}
          onPress={() => setOpen(true)}
          disabled={disabled}
        />
      </SettingsGroup>
      <PickerSheet
        title="Subagent permissions"
        visible={open}
        onClose={() => setOpen(false)}
        value={value}
        onSelect={(mode) => pickPermission(mode, value, save)}
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
