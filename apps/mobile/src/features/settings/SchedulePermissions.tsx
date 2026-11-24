import { useState } from "react";
import { PermissionMode, type ui } from "@canopy/contracts";
import { supportsThreadPermission } from "@canopy/domain/harnesses";
import { scheduledFullAccessDescription } from "@canopy/domain/schedule-display";
import { Button } from "../../ui/components";
import { PermissionPickerSheet, permissionLabel } from "../threads/permissions";
import { SettingChoice } from "./SettingsGroup";
import type { ScheduleSandboxChoices } from "./schedule-sandbox";

export function SchedulePermissions({
  draft,
  change,
  sandbox,
}: {
  draft: ui.NewThreadSchedule;
  change: (patch: Partial<ui.NewThreadSchedule>) => void;
  sandbox?: ScheduleSandboxChoices;
}) {
  const [permission, setPermission] = useState(false);

  function pickPermission(permissionMode: PermissionMode) {
    const sandboxProfileId =
      sandbox && permissionMode !== PermissionMode.FULL_AUTO ? sandbox.selectionId("") : draft.sandboxProfileId;

    change({ permissionMode, sandboxProfileId });
  }

  return (
    <>
      <Button title={`Permissions: ${permissionLabel(draft.permissionMode)}`} onPress={() => setPermission(true)} />
      <PermissionPickerSheet
        provider={draft.provider}
        visible={permission}
        onClose={() => setPermission(false)}
        value={draft.permissionMode}
        onSelect={pickPermission}
        fullAccessDescription={scheduledFullAccessDescription}
      />
      {sandbox && (sandbox.value || supportsThreadPermission(draft.provider, PermissionMode.FULL_AUTO)) ? (
        <SettingChoice
          title="Sandbox profile"
          value={sandbox.value}
          onChange={(id) => change({ sandboxProfileId: sandbox.selectionId(id) })}
          options={sandbox.options}
          description={sandbox.problem}
        />
      ) : null}
    </>
  );
}
