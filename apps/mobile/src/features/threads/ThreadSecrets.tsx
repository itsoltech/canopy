import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Text, View } from "react-native";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { TextInput } from "../../ui/TextInput";
import { useUpdateBlocker } from "../updates/useUpdateBlocker";

/** Values never enter snapshots, drafts or diagnostics. Closing the sheet unmounts the write-only input. */
export function ThreadSecrets({ secrets, disabled }: { secrets: readonly ui.ThreadSecret[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const { active } = useSession();
  const pending = secrets.filter((s) => s.status === "pending");

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  if (!pending.length) return null;

  return (
    <>
      <Button
        title={pending.length === 1 ? "Provide secret" : `Provide secrets (${pending.length})`}
        icon="lock-closed"
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      <Sheet title="Thread secrets" visible={open && active} onClose={() => setOpen(false)}>
        {open && active && (
          <>
            {pending.map((secret) => (
              <SecretRequest key={secret.requestId} secret={secret} disabled={disabled} />
            ))}
            <SecretGrants secrets={secrets} disabled={disabled} />
          </>
        )}
      </Sheet>
    </>
  );
}

function SecretRequest({ secret, disabled }: { secret: ui.ThreadSecret; disabled: boolean }) {
  const c = useColors();
  const { client } = useSession();
  const value = useRef("");
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const sending = useRef(false);
  useUpdateBlocker(() => sending.current || value.current.length > 0);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(
    () => () => {
      value.current = "";
    },
    [],
  );
  useEffect(() => {
    if (disabled) {
      value.current = "";
      input.current?.clear();
      setFilled(false);
    }
  }, [disabled]);

  async function send(decline: boolean) {
    if (!client || disabled || sending.current || (!decline && !value.current.length)) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const request = { requestId: secret.requestId, decline, value: decline ? "" : value.current };
    value.current = "";
    input.current?.clear();
    setFilled(false);

    try {
      await client.api.answerThreadSecret(request);
    } catch {
      setError(
        decline ? "Could not decline the request. Try again." : "Could not save the secret. Paste it again to retry.",
      );
    } finally {
      request.value = "";
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.body, { color: c.muted }]}>{secret.description}</Text>
      <Field
        ref={input}
        label={secret.label || "Secret"}
        placeholder={secret.placeholder || "Paste the secret"}
        secureTextEntry
        autoComplete="off"
        textContentType="none"
        importantForAutofill="noExcludeDescendants"
        autoCorrect={false}
        spellCheck={false}
        autoCapitalize="none"
        smartInsertDelete={false}
        editable={!disabled && !busy}
        onChangeText={(next) => {
          value.current = next;
          setFilled(Boolean(next.length));
        }}
      />
      <Text style={[styles.meta, { color: c.muted }]}>
        Kept out of the thread. The agent’s commands can read it for 24 hours. Revoke access at any time.
      </Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button
          title="Save securely"
          variant="primary"
          disabled={disabled || !filled}
          busy={busy}
          onPress={() => void send(false)}
        />
        <Button title="Decline" disabled={disabled || busy} onPress={() => void send(true)} />
      </View>
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}

/** Active grants contain metadata only; a saved value is never returned by the API. */
export function SecretGrants({ secrets, disabled }: { secrets: readonly ui.ThreadSecret[]; disabled: boolean }) {
  const c = useColors();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);
  const active = secrets.filter((s) => s.status === "saved" && (!s.expiresAt || timestampMs(s.expiresAt) > now));

  if (!active.length) return null;

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.label, { color: c.text }]}>Active secrets</Text>
      {active.map((secret) => (
        <SecretGrant key={secret.requestId} secret={secret} disabled={disabled} />
      ))}
    </View>
  );
}

function SecretGrant({ secret, disabled }: { secret: ui.ThreadSecret; disabled: boolean }) {
  const c = useColors();
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function revoke() {
    if (!client || disabled || busy) return;
    setBusy(true);
    setError("");

    try {
      await client.api.revokeThreadSecret({ requestId: secret.requestId });
    } catch {
      setError("Could not revoke access. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 6 }}>
      <View style={styles.row}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text numberOfLines={2} style={[styles.body, { color: c.text }]}>
            {secret.label || "Secret"}
          </Text>
          {secret.expiresAt && (
            <Text style={[styles.meta, { color: c.muted }]}>
              {`Expires ${new Date(timestampMs(secret.expiresAt)).toLocaleString()}`}
            </Text>
          )}
        </View>
        <Button title="Revoke" size="sm" busy={busy} disabled={disabled} onPress={() => void revoke()} />
      </View>
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}
