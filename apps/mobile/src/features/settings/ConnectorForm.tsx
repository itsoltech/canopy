import { useState } from "react";
import * as Linking from "expo-linking";
import * as Crypto from "expo-crypto";
import type { connectors } from "@canopy/contracts";
import { Button, Field, Notice } from "../../ui/components";
import { SettingsGroup, SettingChoice, SettingToggle } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";

function useConnectorForm({
  type,
  account,
  onSaved,
}: {
  type: connectors.ConnectorType;
  account?: connectors.ConnectorAccount;
  onSaved: () => void;
}) {
  const resource = useSettingsResource(`connector:${account?.id ?? type.id}`, (api) => api.listConnectors({}));
  const [saved, setSaved] = useState(account);
  const [name, setName] = useState(account?.name ?? "");
  const [url, setUrl] = useState(account?.url ?? type.url);
  const [transport, setTransport] = useState(account?.transport ?? "http");
  const [authKind, setAuth] = useState(account?.authKind ?? type.authKinds[0] ?? "oauth");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState("");
  const [replace, setReplace] = useState(!account);
  const [scope, setScope] = useState(type.authMethods.find((m) => m.authKind === authKind)?.defaultScope ?? "");
  const [binding] = useState(() => Crypto.randomUUID());
  const [pasted, setPasted] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const method = type.authMethods.find((m) => m.authKind === authKind);

  async function save() {
    const parsed: Record<string, string> = {};

    for (const line of headers.split("\n").filter((v) => v.trim())) {
      const colon = line.indexOf(":");

      if (colon < 1) {
        setError("Use one header per line: Header-Name: value.");

        return;
      }

      parsed[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }

    const result = await resource.run(async (api) => {
      const response = await api.saveConnectorAccount({
        id: saved?.id ?? "",
        connectorType: type.id,
        name,
        url,
        transport,
        authKind,
        token,
        headers: parsed,
        replaceCredentials: replace,
        expectedRevision: saved?.revision ?? 0n,
      });

      if (response.account) setSaved(response.account);

      if (authKind === "oauth" && response.account) {
        const oauth = await api.beginConnectorOAuth({
          accountId: response.account.id,
          browserBinding: binding,
          scope,
          redirectUri: method?.redirectUrl || "https://itsoltech.github.io/canopy/oauth/callback",
        });

        const target = URL.parse(oauth.authorizationUrl);

        if (!target || target.protocol !== "https:") throw new Error("Invalid sign-in address");
        await Linking.openURL(target.href);
        setWaiting(true);
      }

      return response;
    });

    setToken("");
    setHeaders("");

    if (result && authKind !== "oauth") onSaved();
  }

  return {
    resource,
    name,
    setName,
    url,
    setUrl,
    transport,
    setTransport,
    authKind,
    setAuth,
    token,
    setToken,
    headers,
    setHeaders,
    replace,
    setReplace,
    scope,
    setScope,
    binding,
    pasted,
    setPasted,
    waiting,
    error,
    setError,
    method,
    save,
  };
}

export function ConnectorForm({
  type,
  account,
  onSaved,
}: {
  type: connectors.ConnectorType;
  account?: connectors.ConnectorAccount;
  onSaved: () => void;
}) {
  const {
    resource,
    name,
    setName,
    url,
    setUrl,
    transport,
    setTransport,
    authKind,
    setAuth,
    token,
    setToken,
    headers,
    setHeaders,
    replace,
    setReplace,
    scope,
    setScope,
    binding,
    pasted,
    setPasted,
    waiting,
    error,
    setError,
    method,
    save,
  } = useConnectorForm({ type, account, onSaved });

  return (
    <ResourceState resource={resource}>
      <Field label="Account name" value={name} onChangeText={setName} />
      <Field label="Endpoint URL" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} />
      <SettingChoice
        title="Transport"
        value={transport}
        options={[
          { value: "http", label: "Streamable HTTP" },
          { value: "sse", label: "SSE" },
        ]}
        onChange={setTransport}
      />
      <SettingChoice
        title="Authentication"
        value={authKind}
        options={type.authKinds.map((value) => ({
          value,
          label: type.authMethods.find((m) => m.authKind === value)?.label || value,
        }))}
        onChange={(value) => {
          setAuth(value);
          setScope(type.authMethods.find((m) => m.authKind === value)?.defaultScope || "");
        }}
      />
      <ConnectorSetup method={method} />
      {authKind === "oauth" ? (
        <>
          <Field label="OAuth scopes" value={scope} onChangeText={setScope} placeholder={method?.scopePlaceholder} />
          {method?.scopeDescription ? <Notice>{method.scopeDescription}</Notice> : null}
          <ConnectorOAuthApp type={type} method={method} />
        </>
      ) : (
        <ConnectorCredentials
          existing={!!account}
          method={method}
          replace={replace}
          setReplace={setReplace}
          token={token}
          setToken={setToken}
          headers={headers}
          setHeaders={setHeaders}
        />
      )}
      {error ? <Notice error>{error}</Notice> : null}
      <Button
        variant="primary"
        title={authKind === "oauth" ? "Sign in" : "Save account"}
        busy={resource.busy}
        disabled={!name.trim() || !url.trim()}
        onPress={() => void save()}
      />
      {waiting && (
        <>
          <Notice>Finish sign-in in your browser, then paste the return code here.</Notice>
          <Field
            label="Return code"
            value={pasted}
            onChangeText={setPasted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Button
            title="Complete sign-in"
            disabled={!pasted.trim()}
            busy={resource.busy}
            onPress={() =>
              void resource
                .run((api) => api.completeConnectorOAuth({ pastedCode: pasted, browserBinding: binding }))
                .then((r) => {
                  setPasted("");

                  if (r?.account) onSaved();
                  else if (r) setError(r.error || "Sign-in could not finish. Start sign-in again.");
                })
            }
          />
        </>
      )}
    </ResourceState>
  );
}

function ConnectorSetup({ method }: { method?: connectors.ConnectorAuthMethod }) {
  return (
    <>
      {method?.description ? <Notice>{method.description}</Notice> : null}
      {method?.steps.map((step, index) => (
        <SettingsValue key={index} title={`Step ${index + 1}`} value={step} />
      ))}
      {method?.setupUrl && (
        <Button
          title={method.setupLabel || "Open setup instructions"}
          onPress={() => void Linking.openURL(method.setupUrl)}
        />
      )}
    </>
  );
}

function ConnectorCredentials({
  existing,
  method,
  replace,
  setReplace,
  token,
  setToken,
  headers,
  setHeaders,
}: {
  existing: boolean;
  method?: connectors.ConnectorAuthMethod;
  replace: boolean;
  setReplace: (v: boolean) => void;
  token: string;
  setToken: (v: string) => void;
  headers: string;
  setHeaders: (v: string) => void;
}) {
  return (
    <>
      {existing && <SettingToggle title="Replace saved credentials" value={replace} onChange={setReplace} />}
      {replace && (
        <>
          <Field
            label={method?.tokenLabel || "Token"}
            secureTextEntry
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Field
            label="Secret headers"
            value={headers}
            onChangeText={setHeaders}
            multiline
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}
      <Notice>
        {method?.tokenDescription || "Saved credentials are never shown again. Leave replacement off to keep them."}
      </Notice>
    </>
  );
}

function ConnectorOAuthApp({
  type,
  method,
}: {
  type: connectors.ConnectorType;
  method?: connectors.ConnectorAuthMethod;
}) {
  const resource = useSettingsResource(`oauth-app:${type.id}`, (api) => api.listConnectors({}));
  const [clientId, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [issuer, setIssuer] = useState("");

  return (
    <SettingsGroup
      title={type.oauthAppSet ? "OAuth app saved · Replace" : "Registered OAuth app"}
      description={
        method?.oauthAppRequired
          ? "Register an OAuth app to sign in."
          : "Only needed when the server does not accept automatic registration."
      }
    >
      <ResourceState resource={resource}>
        {method?.appManifest ? <SettingsValue title="App manifest" value={method.appManifest} /> : null}
        {method?.appCreateUrl && (
          <Button title="Create OAuth app" onPress={() => void Linking.openURL(method.appCreateUrl)} />
        )}
        <SettingsValue
          title="Redirect URL"
          value={method?.redirectUrl || "https://itsoltech.github.io/canopy/oauth/callback"}
        />
        <Field label="Issuer" value={issuer} onChangeText={setIssuer} autoCapitalize="none" autoCorrect={false} />
        <Field label="Client ID" value={clientId} onChangeText={setId} autoCapitalize="none" autoCorrect={false} />
        <Field
          label="Client secret"
          value={secret}
          onChangeText={setSecret}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button
          title="Save OAuth app"
          busy={resource.busy}
          disabled={!clientId.trim()}
          onPress={() =>
            void resource
              .run(
                (api) => api.saveConnectorOAuthApp({ connectorType: type.id, clientId, clientSecret: secret, issuer }),
                "OAuth app saved.",
              )
              .then(() => setSecret(""))
          }
        />
      </ResourceState>
    </SettingsGroup>
  );
}
