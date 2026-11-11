import { useRef, useState } from "react";
import { IconButton } from "../../ui/components";
import { PickerSheet } from "../../ui/Picker";

export interface GitHubAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export function GitHubActions({ name, actions }: { name: string; actions: GitHubAction[] }) {
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
          {
            options: actions.map((action, value) => ({
              value,
              label: action.label,
              disabled: action.disabled,
              tone: action.danger ? "danger" : undefined,
            })),
          },
        ]}
        onSelect={(value) => {
          pending.current = actions[value]?.run;
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
