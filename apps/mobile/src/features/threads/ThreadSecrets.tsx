import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Text, View } from "react-native";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { styles, useColors, useTypography } from "../../ui/theme";
import { useCompactControls } from "../../ui/density";
import { ThreadPanelSection } from "./ThreadPanelSection";
import { TextInput } from "../../ui/TextInput";
import { useUpdateBlocker } from "../updates/useUpdateBlocker";
import { useLiveTime } from "../../ui/time";

/** Values never enter snapshots, drafts or diagnostics. Closing the sheet unmounts the write-only input. */
export function ThreadSecrets({ secrets, disabled }: { secrets: readonly ui.ThreadSecret[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const { active } = useSession();
  const pending = secrets.filter((s) => s.status === "pending");

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  if (!pending.length) return null;
  const logins = pending.every((secret) => secret.kind === "login");
  const noun = logins ? "Review login request" : "Provide secret";
  const nouns = logins ? "Review login requests" : "Provide secrets";

  return (
    <>
      <Button
        title={pending.length === 1 ? noun : `${nouns} (${pending.length})`}
        icon="lock-closed"
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      <Sheet title="Thread secrets" visible={open && active} onClose={() => setOpen(false)}>
        {open && active && (
          <>
            {pending.map((secret) =>
              secret.kind === "login" ? (
                <LoginRequest key={secret.requestId} secret={secret} disabled={disabled} />
              ) : (
                <SecretRequest key={secret.requestId} secret={secret} disabled={disabled} />
              ),
            )}
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

/** A project login set to ask each time: the agent waits until the owner allows it for this turn or declines. */
function LoginRequest({ secret, disabled }: { secret: ui.ThreadSecret; disabled: boolean }) {
  const c = useColors();
  const type = useTypography();
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const site = secret.origin.replace(/^https:\/\//, "") || "a website";
  const file = secret.access === "file";

  async function send(decline: boolean) {
    if (!client || disabled || busy) return;
    setBusy(true);
    setError("");

    try {
      await client.api.answerThreadSecret({ requestId: secret.requestId, decline, value: "" });
    } catch {
      setError("Could not send your answer. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.body, { color: c.text }]}>
        {file ? "Give login " : "Use login "}
        <Text style={{ fontFamily: type.mono.fontFamily }}>{secret.projectSecret}</Text>
        {file ? " to the agent’s commands?" : "?"}
      </Text>
      <Text style={[styles.body, { color: c.muted }]}>
        {file
          ? "The agent wants it as a private file for scripts or API tests. Its commands can read the password."
          : `The agent wants to sign in on ${site}. Canopy enters the password. The agent never sees it.`}
      </Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button
          title="Allow for this turn"
          variant="primary"
          disabled={disabled}
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
  const now = useLiveTime(secrets.some((secret) => secret.status === "saved" && !!secret.expiresAt));
  const active = secrets.filter((s) => s.status === "saved" && (!s.expiresAt || timestampMs(s.expiresAt) > now));

  if (!active.length) return null;

  return (
    <ThreadPanelSection title="Active secrets" count={active.length}>
      {active.map((secret) => (
        <SecretGrant key={secret.requestId} secret={secret} disabled={disabled} />
      ))}
    </ThreadPanelSection>
  );
}

function SecretGrant({ secret, disabled }: { secret: ui.ThreadSecret; disabled: boolean }) {
  const c = useColors();
  const type = useTypography();
  const compact = useCompactControls();
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A project secret shows its name; Revoke ends only this thread's access (Project settings deletes it).
  const name = secret.projectSecret || secret.label || "Secret";

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
          <Text
            numberOfLines={compact ? 1 : 2}
            style={[
              compact ? type.chrome : styles.body,
              secret.projectSecret ? { fontFamily: type.mono.fontFamily } : null,
              { color: c.text },
            ]}
          >
            {name}
          </Text>
          {secret.projectSecret ? (
            <Text style={[styles.meta, { color: c.muted }]}>
              {secret.kind !== "login"
                ? "Project secret"
                : secret.access === "file"
                  ? "Project login · file for this turn"
                  : `Project login · ${secret.origin.replace(/^https:\/\//, "") || "browser"} for this turn`}
            </Text>
          ) : null}
          {secret.expiresAt && (
            <Text style={[styles.meta, { color: c.muted }]}>
              {`Expires ${new Date(timestampMs(secret.expiresAt)).toLocaleString()}`}
            </Text>
          )}
        </View>
        <Button
          title="Revoke"
          label={secret.projectSecret ? `Revoke ${name} in this thread` : `Revoke ${name}`}
          size="sm"
          busy={busy}
          disabled={disabled}
          onPress={() => void revoke()}
        />
      </View>
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}
