import { useRef, useState } from "react";
import type { IconName } from "@canopy/ui/icons";
import { Button, IconButton } from "../../ui/Button";
import { PickerSheet, type PickerOption } from "../../ui/Picker";

export type EnvironmentAction = Omit<PickerOption<number>, "value"> & { onPress: () => void };

export function EnvironmentActionMenu({
  title,
  label,
  buttonTitle,
  icon = "ellipsis-horizontal",
  actions,
  note,
  disabled,
}: {
  title: string;
  label: string;
  buttonTitle?: string;
  icon?: IconName;
  actions: EnvironmentAction[];
  note?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<boolean>();
  const pending = useRef<(() => void) | undefined>(undefined);
  const show = () => setOpen(true);

  return (
    <>
      {buttonTitle ? (
        <Button
          title={buttonTitle}
          label={label}
          size="sm"
          variant="text"
          icon={icon}
          disabled={disabled}
          onPress={show}
        />
      ) : (
        <IconButton icon={icon} label={label} size="sm" disabled={disabled} onPress={show} />
      )}
      {open !== undefined && (
        <PickerSheet
          title={title}
          visible={open}
          sections={[{ options: actions.map(({ onPress: _onPress, ...action }, value) => ({ ...action, value })) }]}
          note={note}
          onSelect={(index) => {
            pending.current = actions[index]?.onPress;
          }}
          onClose={() => setOpen(false)}
          onDismiss={() => {
            const action = pending.current;
            pending.current = undefined;
            setOpen((visible) => visible || undefined);
            action?.();
          }}
        />
      )}
    </>
  );
}
