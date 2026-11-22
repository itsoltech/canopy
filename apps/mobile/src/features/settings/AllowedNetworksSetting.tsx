import { useState } from "react";
import { View } from "react-native";
import { Button, Notice } from "../../ui/components";
import { PickerSheet } from "../../ui/Picker";
import { SettingsRow } from "./SettingsGroup";

const options = [
  { value: "tailscale", label: "Tailscale" },
  { value: "lan", label: "Local network" },
  { value: "public", label: "Public internet" },
  { value: "vpn", label: "Other VPNs" },
];

export function AllowedNetworksSetting({
  value,
  busy,
  onApply,
}: {
  value: string[];
  busy: boolean;
  onApply: (networks: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ initial: string[]; selected: string[] }>();
  const [failed, setFailed] = useState(false);
  const allowed = options.filter((option) => value.includes(option.value));
  const summary = allowed.length === options.length ? "All networks" : allowed.map((option) => option.label).join(", ");

  const changed =
    draft &&
    (draft.selected.length !== draft.initial.length ||
      draft.selected.some((network) => !draft.initial.includes(network)));

  function close() {
    setDraft(undefined);
    setFailed(false);
  }

  function toggle(network: string) {
    setFailed(false);
    setDraft((current) => {
      if (!current) return current;

      const selected = current.selected.includes(network)
        ? current.selected.filter((kind) => kind !== network)
        : [...current.selected, network];

      return { ...current, selected };
    });
  }

  async function apply() {
    if (!draft?.selected.length || !changed || busy) return;
    setFailed(false);

    if (await onApply(draft.selected)) close();
    else setFailed(true);
  }

  return (
    <>
      <SettingsRow
        title="Allowed networks"
        description={summary}
        inlineControl
        control={
          <Button
            title="Change"
            label="Change allowed networks"
            disabled={busy}
            onPress={() => {
              setFailed(false);
              setDraft({ initial: value, selected: value });
            }}
          />
        }
      />
      <PickerSheet
        title="Allowed networks"
        visible={!!draft}
        onClose={close}
        selected={draft?.selected ?? value}
        sections={[{ options: options.map((option) => ({ ...option, disabled: busy, wrapLabel: true })) }]}
        onSelect={toggle}
        footer={
          <View style={{ gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
            <Notice>
              Select at least one network. Devices on unchecked networks will disconnect and need an allowed network to
              reconnect.
            </Notice>
            {failed ? <Notice error>Could not apply network settings. Check the connection and retry.</Notice> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
              <Button title="Cancel" variant="ghost" disabled={busy} onPress={close} />
              <Button
                title="Apply"
                variant="primary"
                busy={busy}
                disabled={!draft?.selected.length || !changed}
                onPress={() => void apply()}
              />
            </View>
          </View>
        }
      />
    </>
  );
}
