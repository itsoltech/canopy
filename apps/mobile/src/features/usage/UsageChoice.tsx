import { useState } from "react";
import { PickerSheet, SelectField, type PickerOption } from "../../ui/Picker";

export function UsageChoice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: PickerOption<T>[];
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <SelectField
        label={label}
        value={options.find((option) => option.value === value)?.label ?? String(value)}
        onPress={() => setOpen(true)}
      />
      <PickerSheet
        title={label}
        visible={open}
        onClose={() => setOpen(false)}
        value={value}
        sections={[{ options }]}
        onSelect={onChange}
      />
    </>
  );
}
