import { useRef, useState } from "react";
import { IconButton } from "../../ui/components";
import { PickerSheet, type PickerOption } from "../../ui/Picker";
import type { IconName } from "@canopy/ui/icons";

export interface GitHubAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  description?: string;
  icon?: IconName;
}

export function GitHubActions({
  name,
  actions,
  canopyActions = [],
}: {
  name: string;
  actions: GitHubAction[];
  canopyActions?: GitHubAction[];
}) {
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | undefined>(undefined);

  return (
    <>
      <IconButton icon="ellipsis-horizontal" label={`Actions for ${name}`} size="sm" onPress={() => setOpen(true)} />
      <PickerSheet
        title={name}
        visible={open}
        onClose={() => setOpen(false)}
        sections={[
          { title: "Canopy", options: canopyActions.map(actionOption) },
          {
            title: "GitHub",
            separator: true,
            options: actions.map((action, index) => actionOption(action, canopyActions.length + index)),
          },
        ]}
        onSelect={(value) => {
          pending.current = [...canopyActions, ...actions][value]?.run;
        }}
        onDismiss={() => {
          const run = pending.current;
          pending.current = undefined;
          run?.();
        }}
      />
    </>
  );
}

function actionOption(action: GitHubAction, value: number): PickerOption<number> {
  return {
    value,
    label: action.label,
    disabled: action.disabled,
    description: action.description,
    icon: action.icon,
    tone: action.danger ? "danger" : undefined,
  };
}
