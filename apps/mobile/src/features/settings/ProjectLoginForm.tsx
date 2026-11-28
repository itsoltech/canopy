import { useEffect, useRef, useState, type ComponentRef, type RefObject } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { parseLoginWebsites } from "@canopy/domain/project-logins";
import { useSession } from "../../state/session";
import { Button, Field, Notice, Segmented } from "../../ui/components";
import { TextInput } from "../../ui/TextInput";
import { styles, useColors, useTypography } from "../../ui/theme";
import { useUpdateBlocker } from "../updates/useUpdateBlocker";
import { secretNameError, secretValueError } from "./project-secret-rules";
import { ProjectSecretValueField } from "./ProjectSecretValueField";
import { SettingToggle } from "./SettingsGroup";

interface LoginDetails {
  websites: string;
  username: string;
  showUsername: boolean;
  notes: string;
  use: "automatic" | "ask";
  outsideBrowser: boolean;
  removeCode: boolean;
}

interface DetailFields {
  details: LoginDetails;
  update: (patch: Partial<LoginDetails>) => void;
  busy: boolean;
}

function initialDetails(saved: ui.ProjectLogin | undefined): LoginDetails {
  return {
    websites: saved?.websites.join("\n") ?? "",
    username: saved?.username ?? "",
    showUsername: saved?.showUsername ?? true,
    notes: saved?.notes ?? "",
    use: saved?.askEachTime ? "ask" : "automatic",
    outsideBrowser: saved?.outsideBrowser ?? false,
    removeCode: false,
  };
}

function loginRequest(projectId: string, name: string, details: LoginDetails, password: string, setup: string) {
  return {
    projectId,
    name,
    login: {
      websites: details.websites.split("\n").filter((line) => line.trim()),
      username: details.username.trim(),
      showUsername: details.showUsername,
      notes: details.notes,
      askEachTime: details.use === "ask",
      outsideBrowser: details.outsideBrowser,
      oneTimeCode: false,
    },
    password: password || undefined,
    oneTimeCodeSetup: details.removeCode ? "" : setup.trim() || undefined,
  };
}

/**
 * Adds or edits a project login. The password and setup key are write only: they live in refs and native fields
 * until sent, never in React state, and are cleared on unmount (docs/mobile.md).
 */
export function ProjectLoginForm({
  projectId,
  login,
  taken,
  onSaved,
  onBusy,
}: {
  projectId: string;
  login?: ui.ProjectSecret;
  taken: readonly string[];
  onSaved: (secret: ui.ProjectSecret) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { client } = useSession();
  const saved = login?.login;
  const password = useRef("");
  const setup = useRef("");
  const passwordInput = useRef<ComponentRef<typeof TextInput>>(null);
  const setupInput = useRef<ComponentRef<typeof TextInput>>(null);
  const sending = useRef(false);
  useUpdateBlocker(() => sending.current || password.current.length > 0 || setup.current.length > 0);
  const [name, setName] = useState("");
  const [details, setDetails] = useState(() => initialDetails(saved));
  const update = (patch: Partial<LoginDetails>) => setDetails((current) => ({ ...current, ...patch }));
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({ name: "", websites: "", password: "" });
  const [error, setError] = useState("");

  useEffect(
    () => () => {
      password.current = "";
      setup.current = "";
    },
    [],
  );

  function validate(lines: string[]) {
    const next = {
      name: login ? "" : secretNameError(name, taken),
      websites: parseLoginWebsites(lines) ? "" : "Add 1–20 websites, one per line, such as https://app.example.com.",
      password: login && !password.current ? "" : secretValueError(password.current),
    };

    setErrors(next);

    return !next.name && !next.websites && !next.password;
  }

  async function save() {
    const lines = details.websites.split("\n").filter((line) => line.trim());

    if (!client || sending.current || !validate(lines)) return;
    sending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    const request = loginRequest(projectId, login?.name ?? name, details, password.current, setup.current);

    password.current = "";
    setup.current = "";
    passwordInput.current?.clear();
    setupInput.current?.clear();
    setRound((current) => current + 1);

    try {
      const response = await client.api.putProjectLogin(request);

      if (response.secret) onSaved(response.secret);
    } catch {
      setError("Could not save the login. Enter the password and setup key again, if you changed them.");
    } finally {
      request.password = undefined;
      request.oneTimeCodeSetup = undefined;
      sending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      {!login && (
        <LoginNameField
          name={name}
          error={errors.name}
          busy={busy}
          onChange={(next) => {
            setName(next);
            setErrors((current) => ({ ...current, name: "" }));
          }}
        />
      )}
      <LoginIdentityFields
        details={details}
        update={(patch) => {
          update(patch);

          if (patch.websites !== undefined) setErrors((current) => ({ ...current, websites: "" }));
        }}
        websitesError={errors.websites}
        busy={busy}
      />
      <LoginSecretFields
        round={round}
        password={password}
        passwordInput={passwordInput}
        setup={setup}
        setupInput={setupInput}
        editing={Boolean(login)}
        savedCode={Boolean(saved?.oneTimeCode)}
        removeCode={details.removeCode}
        onRemoveCode={(removeCode) => update({ removeCode })}
        passwordError={errors.password}
        onPassword={() => setErrors((current) => ({ ...current, password: "" }))}
        busy={busy}
      />
      <LoginUseFields details={details} update={update} busy={busy} />
      <Button
        title={login ? "Save login" : "Add login"}
        variant="primary"
        icon="lock-closed"
        busy={busy}
        onPress={() => void save()}
      />
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}

function LoginUseFields({ details, update, busy }: DetailFields) {
  const c = useColors();

  return (
    <>
      <Field
        label="Notes for agents (optional)"
        value={details.notes}
        multiline
        maxLength={2000}
        editable={!busy}
        onChangeText={(notes) => update({ notes })}
      />
      <View style={{ gap: 4 }}>
        <Text style={[styles.meta, { color: c.muted }]}>Agent use</Text>
        <Segmented
          options={[
            { value: "automatic", label: "Automatic" },
            { value: "ask", label: "Ask each time" },
          ]}
          value={details.use}
          onChange={(use) => update({ use })}
        />
      </View>
      <SettingToggle
        title="Allow outside the browser"
        description="Agents can also get the login as a private file, for scripts and API tests."
        value={details.outsideBrowser}
        onChange={(outsideBrowser) => update({ outsideBrowser })}
        disabled={busy}
      />
    </>
  );
}

function LoginIdentityFields({ details, update, busy, websitesError }: DetailFields & { websitesError: string }) {
  return (
    <>
      <View style={{ gap: 4 }}>
        <Field
          label="Websites"
          value={details.websites}
          placeholder="https://staging.example.com"
          multiline
          autoComplete="off"
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          editable={!busy}
          onChangeText={(websites) => update({ websites })}
        />
        <FieldHint
          hint="Enter one website per line, using https://*.example.com to include subdomains."
          error={websitesError}
        />
      </View>
      <Field
        label="Username"
        value={details.username}
        placeholder="test@example.com"
        autoComplete="off"
        autoCorrect={false}
        autoCapitalize="none"
        editable={!busy}
        onChangeText={(username) => update({ username })}
      />
      <SettingToggle
        title="Show username to agents"
        description="When off, agents see “hidden” instead of the username."
        value={details.showUsername}
        onChange={(showUsername) => update({ showUsername })}
        disabled={busy}
      />
    </>
  );
}

function LoginNameField({
  name,
  error,
  busy,
  onChange,
}: {
  name: string;
  error: string;
  busy: boolean;
  onChange: (name: string) => void;
}) {
  const type = useTypography();

  return (
    <View style={{ gap: 4 }}>
      <Field
        label="Name"
        value={name}
        placeholder="STAGING_ADMIN"
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={128}
        editable={!busy}
        style={{ fontFamily: type.mono.fontFamily }}
        onChangeText={onChange}
      />
      <FieldHint hint="Agents use the login by this exact name." error={error} />
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

/** The write-only password and one-time code setup key; values stay in the parent's refs. */
function LoginSecretFields({
  round,
  password,
  passwordInput,
  setup,
  setupInput,
  editing,
  savedCode,
  removeCode,
  onRemoveCode,
  passwordError,
  onPassword,
  busy,
}: {
  round: number;
  password: RefObject<string>;
  passwordInput: RefObject<ComponentRef<typeof TextInput> | null>;
  setup: RefObject<string>;
  setupInput: RefObject<ComponentRef<typeof TextInput> | null>;
  editing: boolean;
  savedCode: boolean;
  removeCode: boolean;
  onRemoveCode: (remove: boolean) => void;
  passwordError: string;
  onPassword: () => void;
  busy: boolean;
}) {
  return (
    <>
      <ProjectSecretValueField
        key={`password-${round}`}
        value={password}
        input={passwordInput}
        label={editing ? "New password (optional)" : "Password"}
        editable={!busy}
        error={passwordError}
        onChange={onPassword}
      />
      {savedCode && (
        <SettingToggle
          title="Remove one-time code"
          description="Agents can no longer enter its codes."
          value={removeCode}
          onChange={onRemoveCode}
          disabled={busy}
        />
      )}
      {!removeCode && (
        <ProjectSecretValueField
          key={`setup-${round}`}
          value={setup}
          input={setupInput}
          label={savedCode ? "New one-time code setup key (optional)" : "One-time code setup key (optional)"}
          editable={!busy}
          error=""
          onChange={() => {}}
        />
      )}
    </>
  );
}
