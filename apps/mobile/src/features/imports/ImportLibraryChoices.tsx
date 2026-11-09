import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Checkbox } from "../../ui/Checkbox";
import { Notice } from "../../ui/components";
import { SettingChoice, SettingsGroup } from "../settings/SettingsGroup";
import { SettingsValue } from "../settings/SettingsValue";

export type LibraryChoices = Record<string, { action: string; secrets: string[] }>;

export function ImportLibraryChoices({
  items,
  choices,
  onChange,
  disabled,
}: {
  items: readonly ui.ImportLibraryCandidate[];
  choices: LibraryChoices;
  onChange: (choices: LibraryChoices) => void;
  disabled: boolean;
}) {
  function toggle(item: ui.ImportLibraryCandidate, selected: boolean) {
    const next = { ...choices };

    if (selected) {
      next[item.key] = { action: item.status === "conflict" ? item.actions[0] || "replace" : "import", secrets: [] };

      for (const other of items) {
        if (other.key === item.key || other.name !== item.name) continue;

        if (
          item.name === "Permissions of new threads" ||
          (["skill", "command"].includes(item.kind) && ["skill", "command"].includes(other.kind))
        )
          delete next[other.key];
      }
    } else delete next[item.key];
    onChange(next);
  }

  return (
    <SettingsGroup title="Settings and library">
      {!items.length && <Notice>No settings or library items found.</Notice>}
      {items.map((item) => (
        <View key={item.key} style={{ gap: 8 }}>
          <Checkbox
            label={item.name}
            description={[item.agentCli, item.reason].filter(Boolean).join(" · ")}
            checked={!!choices[item.key]}
            disabled={disabled || !["new", "conflict"].includes(item.status)}
            onChange={(value) => toggle(item, value)}
          />
          {item.current && <SettingsValue title="Current" value={item.current} />}
          {item.proposed && <SettingsValue title="After import" value={item.proposed} />}
          {item.detail ? <Notice>{item.detail}</Notice> : null}
          {item.warnings.map((warning, index) => (
            <Notice key={index}>{warning}</Notice>
          ))}
          {choices[item.key] && item.status === "conflict" && (
            <SettingChoice
              title={`Import ${item.name}`}
              value={choices[item.key]!.action}
              disabled={disabled}
              options={item.actions.map((action) => ({
                value: action,
                label: action === "replace" ? "Replace existing" : "Keep both",
              }))}
              onChange={(action) => onChange({ ...choices, [item.key]: { ...choices[item.key]!, action } })}
            />
          )}
          {choices[item.key] &&
            item.slots.map((slot) =>
              slot.kind === "literal" ? (
                <Checkbox
                  key={slot.name}
                  label={`Copy ${slot.name} from this computer`}
                  description="The value stays in the gateway. It is never shown on this phone."
                  checked={choices[item.key]!.secrets.includes(slot.name)}
                  disabled={disabled}
                  onChange={(on) => {
                    const choice = choices[item.key]!;
                    onChange({
                      ...choices,
                      [item.key]: {
                        ...choice,
                        secrets: on
                          ? [...choice.secrets, slot.name]
                          : choice.secrets.filter((name) => name !== slot.name),
                      },
                    });
                  }}
                />
              ) : (
                <Notice key={slot.name}>
                  Enter {slot.variable} for {slot.name} in Settings → Connectors after import.
                </Notice>
              ),
            )}
        </View>
      ))}
    </SettingsGroup>
  );
}
