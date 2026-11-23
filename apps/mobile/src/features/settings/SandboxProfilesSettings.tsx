import { useState } from "react";
import { Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { create, equals } from "@bufbuild/protobuf";
import { SandboxProfileSchema, type SandboxProfile } from "@canopy/contracts";
import { normalizeSandboxProfile } from "@canopy/domain/sandbox-profile-validation";
import { useAppearance } from "../../state/appearance";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { useSettingsAction } from "./resource";

type Edit = { mode: "add" } | { mode: "edit" | "delete"; profile: SandboxProfile };

export function SandboxProfilesSettings() {
  const { user, saving } = useAppearance();
  const [edit, setEdit] = useState<Edit>();

  return (
    <>
      <SettingsGroup
        title="Sandbox profiles"
        description="A thread can use these shell network rules only if its agent CLI and worker support them."
        actions={
          <Button title="Add profile" icon="plus" disabled={!user || saving} onPress={() => setEdit({ mode: "add" })} />
        }
      >
        {(user?.sandboxProfiles?.profiles ?? []).map((profile) => (
          <SettingsRow
            key={profile.id}
            title={profile.name}
            description={
              profile.allowedDomains.length
                ? `Allows ${profile.allowedDomains.slice(0, 3).join(", ")}${profile.allowedDomains.length > 3 ? ` and ${profile.allowedDomains.length - 3} more` : ""}.`
                : "Blocks all outbound shell connections."
            }
            control={
              <SettingsActions>
                <Button
                  size="sm"
                  title="Edit"
                  label={`Edit profile “${profile.name}”`}
                  onPress={() => setEdit({ mode: "edit", profile })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  title="Delete"
                  label={`Delete profile “${profile.name}”`}
                  onPress={() => setEdit({ mode: "delete", profile })}
                />
              </SettingsActions>
            }
          />
        ))}
        {!user?.sandboxProfiles?.profiles.length && <SettingsRow title="No sandbox profiles yet" />}
      </SettingsGroup>
      {edit && (
        <SandboxProfileSheet
          edit={edit}
          onClose={() => setEdit((current) => (current === edit ? undefined : current))}
        />
      )}
    </>
  );
}

function readProfile(id: string, name: string, domains: string, profiles: SandboxProfile[]) {
  const profile = normalizeSandboxProfile(
    create(SandboxProfileSchema, {
      id,
      name,
      allowedDomains: domains
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    }),
  );

  if (profiles.some((item) => item.id !== id && item.name.toLowerCase() === profile.name.toLowerCase()))
    throw new Error("A sandbox profile already uses this name. Choose another name.");

  return profile;
}

function SandboxProfileSheet({ edit, onClose }: { edit: Edit; onClose: () => void }) {
  const { user, reload, saving } = useAppearance();
  const resource = useSettingsAction({ reload, error: "" });
  const original = edit.mode === "add" ? undefined : edit.profile;
  const [id] = useState(() => original?.id ?? randomUUID());
  const [name, setName] = useState(original?.name ?? "");
  const [domains, setDomains] = useState(original?.allowedDomains.join("\n") ?? "");
  const [error, setError] = useState("");
  const profiles = user?.sandboxProfiles?.profiles ?? [];
  const current = profiles.find((item) => item.id === id);
  const stale = original && (!current || !equals(SandboxProfileSchema, original, current));
  const deleting = edit.mode === "delete";
  const disabled = !user || resource.busy || saving;
  const title = deleting ? "Delete sandbox profile?" : original ? "Edit sandbox profile" : "Add sandbox profile";
  const c = useColors();
  const type = useTypography();

  async function submit() {
    if (!user || stale || disabled) return;
    let parsed: SandboxProfile | undefined;
    setError("");

    try {
      if (!deleting) parsed = readProfile(id, name, domains, profiles);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the name and allowed domains.");

      return;
    }

    const draft = parsed;

    const next = draft
      ? original
        ? profiles.map((item) => (item.id === id ? draft : item))
        : [...profiles, draft]
      : profiles.filter((item) => item.id !== id);

    const response = await resource.run((api) =>
      api.updateUserSettings({
        expectedVersion: user.version,
        sandboxProfiles: { profiles: next },
      }),
    );

    if (!response) return;
    const saved = response.settings?.sandboxProfiles?.profiles.find((item) => item.id === id);

    if (draft ? saved && equals(SandboxProfileSchema, draft, saved) : !saved) onClose();
    else setError("The gateway did not apply this change. Check for gateway updates and try again.");
  }

  return (
    <Sheet
      title={title}
      visible
      onClose={onClose}
      footer={
        <SettingsActions>
          <Button title="Cancel" disabled={resource.busy} onPress={onClose} />
          <Button
            title={deleting ? "Delete profile" : original ? "Save changes" : "Add profile"}
            variant={deleting ? "danger" : "primary"}
            busy={resource.busy}
            disabled={disabled || !!stale}
            onPress={() => void submit()}
          />
        </SettingsActions>
      }
    >
      {deleting ? (
        <Text style={[type.body, { color: c.text }]}>
          This permanently deletes “{original?.name}” from your sandbox profiles.
        </Text>
      ) : (
        <View style={{ gap: 16 }}>
          <Field
            label="Name"
            value={name}
            onChangeText={(text) => {
              setName(text);
              setError("");
            }}
            editable={!disabled && !stale}
            maxLength={64}
          />
          <Field
            label="Allowed domains"
            value={domains}
            onChangeText={(text) => {
              setDomains(text);
              setError("");
            }}
            multiline
            editable={!disabled && !stale}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="api.example.com"
            style={{ minHeight: 100, textAlignVertical: "top" }}
          />
          <Text style={[type.meta, { color: c.muted }]}>
            Enter one exact domain per line. List each subdomain separately. Leave blank to block all outbound shell
            connections.
          </Text>
        </View>
      )}
      {stale && !resource.busy ? (
        <Notice>
          {current
            ? "This profile changed. Close and reopen it to see the latest settings."
            : "This profile was deleted. Close to return to the list."}
        </Notice>
      ) : error || resource.error ? (
        <Notice error>{error || resource.error}</Notice>
      ) : null}
    </Sheet>
  );
}
