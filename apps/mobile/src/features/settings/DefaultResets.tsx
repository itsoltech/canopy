import type { ReactNode } from "react";
import { PermissionMode, Provider, type ui } from "@canopy/contracts";
import { SettingsRowScope } from "./SettingsGroup";
import { ResetSetting } from "./ResetSetting";

export function DefaultResets({
  value,
  onChange,
  inherited = false,
  disabled,
  children,
}: {
  value: ui.ThreadDefaults;
  onChange: (patch: Partial<ui.ThreadDefaults>) => void;
  inherited?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const workspace = { changed: !!value.workspaceId, patch: { workspaceId: "" } };

  const fields = {
    "Project and worker": workspace,
    Worker: workspace,
    Agent: {
      changed: value.provider !== Provider.UNSPECIFIED,
      patch: { provider: Provider.UNSPECIFIED, providerProfileId: "" },
    },
    Permissions: {
      changed:
        value.permissionMode !== PermissionMode.UNSPECIFIED &&
        (inherited || value.permissionMode !== PermissionMode.ASK),
      patch: { permissionMode: PermissionMode.UNSPECIFIED },
    },
  };

  return (
    <SettingsRowScope.Provider
      value={{
        reset: (title) => {
          const field = Object.entries(fields).find(([key]) => key === title)?.[1];

          return field ? (
            <ResetSetting
              label={`Reset ${title.toLowerCase()}`}
              changed={field.changed}
              disabled={disabled}
              onReset={() => onChange(field.patch)}
            />
          ) : undefined;
        },
      }}
    >
      {children}
    </SettingsRowScope.Provider>
  );
}
