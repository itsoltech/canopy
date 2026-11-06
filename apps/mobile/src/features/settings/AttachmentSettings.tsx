import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { View } from "react-native";
import { useAppearance } from "../../state/appearance";
import { Button, Field, Notice } from "../../ui/components";
import { SettingsGroup } from "./SettingsGroup";

export function AttachmentSettings() {
  const settings = useAppearance();
  const [draft, setDraft] = useState<{ file: string; message: string; files: string }>();
  const limits = settings.user?.attachmentLimits ?? settings.limits;

  const values = draft ?? {
    file: String(Number(limits?.maxFileBytes ?? 20n * 1024n ** 2n) / 1024 ** 2),
    message: String(Number(limits?.maxMessageBytes ?? 50n * 1024n ** 2n) / 1024 ** 2),
    files: String(limits?.maxFiles ?? 10),
  };

  const valid =
    [values.file, values.message, values.files].every((v) => /^\d+$/.test(v) && Number(v) > 0) &&
    Number(values.file) <= 30 &&
    Number(values.message) <= 1024 &&
    Number(values.files) <= 100;

  return (
    <SettingsGroup title="Attachments" description="Limits apply to new uploads and messages on this computer.">
      <View style={{ padding: 12, gap: 12 }}>
        {(
          [
            { key: "file", label: "Per file (MiB)" },
            { key: "message", label: "Per message (MiB)" },
            { key: "files", label: "Files per message" },
          ] as const
        ).map(({ key, label }) => (
          <Field
            key={key}
            label={label}
            keyboardType="number-pad"
            value={values[key]}
            onChangeText={(value) => setDraft({ ...values, [key]: value })}
          />
        ))}
        {!valid && <Notice error>Use whole numbers: 1–30 MiB per file, 1–1024 MiB per message and 1–100 files.</Notice>}
        <Button
          title="Save limits"
          disabled={!limits || !valid}
          busy={settings.saving}
          onPress={() =>
            void settings.update({
              attachmentLimits: create(ui.AttachmentLimitsSchema, {
                maxFileBytes: BigInt(values.file) * 1024n ** 2n,
                maxMessageBytes: BigInt(values.message) * 1024n ** 2n,
                maxFiles: Number(values.files),
              }),
            })
          }
        />
      </View>
    </SettingsGroup>
  );
}
