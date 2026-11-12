import { useState } from "react";
import type { github } from "@canopy/contracts";
import { PickerSheet, SelectField } from "../../ui/Picker";

export function PullRequestPickerAccount({
  selection,
  disabled,
  onchoose,
}: {
  selection: github.GitHubRepositoryAccountResponse;
  disabled: boolean;
  onchoose: (accountId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = selection.candidates.find((a) => a.id === selection.accountId);

  return (
    <>
      <SelectField
        hideLabel
        label="GitHub account"
        value={current?.login ?? "Choose an account"}
        onPress={() => setOpen(true)}
        disabled={disabled}
      />
      <PickerSheet
        title="Choose an account"
        visible={open}
        onClose={() => setOpen(false)}
        value={selection.accountId}
        sections={[{ options: selection.candidates.map((a) => ({ value: a.id, label: a.login })) }]}
        onSelect={(id) => {
          setOpen(false);

          if (id !== selection.accountId) onchoose(id);
        }}
      />
    </>
  );
}
