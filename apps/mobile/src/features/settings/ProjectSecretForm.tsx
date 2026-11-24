import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field, Notice } from "../../ui/components";
import { TextInput } from "../../ui/TextInput";
import { styles, useColors, useTypography } from "../../ui/theme";
import { useUpdateBlocker } from "../updates/useUpdateBlocker";
import { secretNameError, secretValueError } from "./project-secret-rules";
import { ProjectSecretValueField } from "./ProjectSecretValueField";

/**
 * Adds a project secret, or replaces the value of `name`. The value is write only: it lives in a ref and the
 * native field until it is sent, never in React state, snapshots, drafts or diagnostics, and is cleared on unmount.
 */
export function ProjectSecretForm({
  projectId,
  name,
  taken,
  onSaved,
  onBusy,
}: {
  projectId: string;
  name?: string;
  taken: readonly string[];
  onSaved: (secret: ui.ProjectSecret) => void;
  onBusy: (busy: boolean) => void;
}) {
  const c = useColors();
  const type = useTypography();
  const { client } = useSession();
  const value = useRef("");
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const sending = useRef(false);
  useUpdateBlocker(() => sending.current || value.current.length > 0);
  const [draftName, setDraftName] = useState("");
  const [filled, setFilled] = useState(false);
  // A new round remounts the value field: an unsent paste or entry is gone after each send.
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState("");
  const [valueError, setValueError] = useState("");
  const [error, setError] = useState("");

  useEffect(
    () => () => {
      value.current = "";
    },
    [],
  );

  async function save() {
    if (!client || sending.current) return;
    const target = name ?? draftName;
    const nextNameError = name === undefined ? secretNameError(target, taken) : "";
    const nextValueError = secretValueError(value.current);
    setNameError(nextNameError);
    setValueError(nextValueError);

    if (nextNameError || nextValueError) return;
    sending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    const request = { projectId, name: target, value: value.current };
    value.current = "";
    input.current?.clear();
    setFilled(false);
    setRound((current) => current + 1);

    try {
      const response = await client.api.putProjectSecret(request);

      if (response.secret) onSaved(response.secret);
    } catch {
      setError("Could not save the secret. Enter it again to retry.");
    } finally {
      request.value = "";
      sending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      {name === undefined ? (
        <View style={{ gap: 4 }}>
          <Field
            label="Name"
            value={draftName}
            placeholder="API_TOKEN"
            autoComplete="off"
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            maxLength={128}
            editable={!busy}
            style={{ fontFamily: type.mono.fontFamily }}
            onChangeText={(next) => {
              setDraftName(next);
              setNameError("");
            }}
          />
          <FieldHint error={nameError} hint="Agents ask for the secret by this exact name." />
        </View>
      ) : (
        <Text style={[styles.body, { color: c.muted }]}>
          {`Canopy revokes the old value of “${name}” in threads that use it. Agents ask again to get the new value.`}
        </Text>
      )}
      <ProjectSecretValueField
        key={round}
        value={value}
        input={input}
        label={name === undefined ? "Value" : "New value"}
        editable={!busy}
        error={valueError}
        onChange={(next) => {
          setFilled(next);
          setValueError("");
        }}
      />
      <Button
        title={name === undefined ? "Add secret" : "Replace value"}
        variant="primary"
        icon="lock-closed"
        disabled={!filled || (name === undefined && !draftName)}
        busy={busy}
        onPress={() => void save()}
      />
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}

/** A field's hint, replaced by its validation error (announced) until the field changes. */
function FieldHint({ error, hint }: { error: string; hint: string }) {
  const c = useColors();

  return (
    <Text accessibilityRole={error ? "alert" : undefined} style={[styles.meta, { color: error ? c.danger : c.muted }]}>
      {error || hint}
    </Text>
  );
}
