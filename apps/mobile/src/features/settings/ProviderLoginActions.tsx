import { useEffect, useState } from "react";
import { Provider, ProviderProfileKind, type ProviderAccountStatus } from "@canopy/contracts";
import { providerLoginCommand } from "@canopy/domain/provider-accounts";
import * as Linking from "expo-linking";
import { useOverview } from "../../state/overview";
import { Button, Field, Notice } from "../../ui/components";
import { confirm } from "../../ui/Confirm";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsAction, workersFollowStream } from "./resource";

/** Shares the overview account's login id: a different refresh cannot dismiss this sign-in. */
export function ProviderLoginActions({
  workerId,
  harness,
  id,
  ownLogin,
  kind,
  account,
  disabled = false,
}: {
  workerId: string;
  harness: Provider;
  id: string;
  ownLogin: boolean;
  kind: ProviderProfileKind;
  account?: ProviderAccountStatus | undefined;
  disabled?: boolean;
}) {
  const overview = useOverview();
  const worker = overview.workers.find((w) => w.id === workerId);
  const current = worker?.providerInstances.find((i) => i.harness === harness && i.id === id)?.account ?? account;

  const resource = useSettingsAction(
    workersFollowStream,
    "Could not manage this login. Update the worker, then retry.",
  );

  const [login, setLogin] = useState<{
    loginId: string;
    verificationUrl: string;
    userCode: string;
    requiresCode: boolean;
  }>();

  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!login || current?.loginId !== login.loginId || !["signed_in", "failed"].includes(current.loginOutcome)) return;
    setFailed(current.loginOutcome === "failed");
    setLogin(undefined);
  }, [login, current?.loginId, current?.loginOutcome]);

  if (kind !== ProviderProfileKind.NATIVE) return null;
  const request = { workerId, harness, id };
  const name = worker?.name ?? "this computer";

  const cli =
    harness === Provider.CLAUDE ? "claude auth login" : harness === Provider.CODEX ? "codex login" : "grok login";

  const command = current
    ? providerLoginCommand(
        harness === Provider.CLAUDE ? "claude" : harness === Provider.CODEX ? "codex" : "grok",
        current,
        worker?.os ?? "",
      ) || cli
    : cli;

  function ask(logout: boolean) {
    confirm({
      title: logout ? "Sign out?" : "Sign in?",
      description: ownLogin
        ? `This ${logout ? "signs out" : "signs in"} only this instance on ${name}.`
        : logout
          ? `This signs out the CLI on ${name}, including in your terminal.`
          : `This changes the CLI account on ${name}, as ${cli} does.`,
      confirm: logout ? "Sign out" : "Sign in",
      danger: logout,
      action: () => {
        setFailed(false);

        if (logout) void resource.run((api) => api.logoutProvider(request));
        else
          void resource
            .run((api) => api.startProviderLogin(request))
            .then((result) => {
              if (result) setLogin(result);
            });
      },
    });
  }

  return (
    <ResourceState resource={resource}>
      {login ? (
        <>
          {login.userCode ? <SettingsValue title="Sign-in code" value={login.userCode} /> : null}
          <Button title="Open sign-in page" onPress={() => void Linking.openURL(login.verificationUrl)} />
          {login.requiresCode ? (
            <CodeForm
              key={login.loginId}
              busy={resource.busy}
              disabled={disabled}
              onSubmit={(code) => {
                void resource
                  .run((api) => api.completeProviderLogin({ ...request, loginId: login.loginId, code }))
                  .then((result) => {
                    if (result) setLogin({ ...login, requiresCode: false });
                  });
              }}
            />
          ) : null}
          <Notice>Waiting for the sign-in on {name}…</Notice>
        </>
      ) : (
        <>
          <Button
            title="Sign in"
            disabled={disabled || !worker?.online}
            busy={resource.busy}
            onPress={() => ask(false)}
          />
          <Button
            title="Sign out"
            disabled={disabled || !worker?.online}
            busy={resource.busy}
            onPress={() => ask(true)}
          />
        </>
      )}
      {failed ? <Notice>The sign-in did not finish. Start it again.</Notice> : null}
      {resource.error ? (
        <Notice>
          Sign in with {command} in a terminal on {name}.
        </Notice>
      ) : null}
    </ResourceState>
  );
}

function CodeForm({
  busy,
  disabled,
  onSubmit,
}: {
  busy: boolean;
  disabled: boolean;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState("");

  return (
    <>
      <Field
        label="Code from sign-in page"
        value={code}
        onChangeText={setCode}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button
        title="Submit code"
        busy={busy}
        disabled={disabled || !code.trim()}
        onPress={() => {
          onSubmit(code.trim());
          setCode("");
        }}
      />
    </>
  );
}
