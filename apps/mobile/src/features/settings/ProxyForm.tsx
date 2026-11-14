import { useState } from "react";
import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { proxyKinds } from "@canopy/domain/proxy-accounts";
import { Button, Field, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { SettingsActions, SettingsGroup, SettingChoice, SettingToggle } from "./SettingsGroup";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";
import { ProxyMappings } from "./ProxyMappings";
import { SecretValue, type KeyAction } from "./SecretValue";

const headerText = (proxy: ui.Proxy | undefined) =>
  Object.entries(proxy?.codex?.extraHeaders ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

/** "Name: value" lines, or undefined when a line has no name. */
function parseHeaders(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  for (const line of text.split("\n").filter((v) => v.trim())) {
    const colon = line.indexOf(":");

    if (colon < 1) return undefined;
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  return headers;
}

function Hint({ children }: { children: string }) {
  const c = useColors();

  return <Text style={[styles.workMeta, { color: c.muted }]}>{children}</Text>;
}

/** Add or edit a saved proxy (web: ProxyForm). Secrets are write-only; omitted keeps, empty removes. */
export function ProxyForm({
  proxy,
  onSaved,
  onCancel,
}: {
  proxy?: ui.Proxy;
  onSaved: (proxy: ui.Proxy | undefined) => void;
  onCancel: () => void;
}) {
  const resource = useSettingsResource("ListProxies", (api) => api.listProxies({}));
  const [name, setName] = useState(proxy?.name ?? "");
  const [kind, setKind] = useState(proxy?.kind ?? "cliproxyapi");
  const [baseUrl, setUrl] = useState(proxy?.baseUrl ?? "");
  const [secret, setSecret] = useState("");
  const [action, setAction] = useState<KeyAction>(proxy?.secretSet ? "keep" : "replace");
  const [managementKey, setManagementKey] = useState("");
  const [managementAction, setManagementAction] = useState<KeyAction>(proxy?.managementKeySet ? "keep" : "replace");
  const [websockets, setWebsockets] = useState(proxy?.codex?.supportsWebsockets ?? false);
  const [headers, setHeaders] = useState(headerText(proxy));
  const [error, setError] = useState("");

  function managementChange(): { managementKey?: string } {
    if (kind !== "cliproxyapi" || managementAction === "clear")
      return proxy?.managementKeySet ? { managementKey: "" } : {};

    return managementAction === "replace" && managementKey ? { managementKey } : {};
  }

  async function save() {
    const extraHeaders = parseHeaders(headers);

    if (!extraHeaders) {
      setError("Enter extra headers as Name: value, one per line.");

      return;
    }

    setError("");

    const result = await resource.run((api) =>
      api.saveProxy({
        id: proxy?.id ?? "",
        name,
        kind,
        baseUrl,
        ...(action === "replace" && { secret }),
        ...managementChange(),
        expectedRevision: proxy?.revision ?? 0n,
        codex: { wireApi: "responses", supportsWebsockets: websockets, extraHeaders },
      }),
    );

    setSecret("");
    setManagementKey("");

    if (result) onSaved(result.proxy);
  }

  return (
    <ResourceState resource={resource}>
      <Field label="Name" value={name} onChangeText={setName} maxLength={80} placeholder="Team proxy" />
      <SettingChoice
        title="Kind"
        description={proxyKinds.find((k) => k.value === kind)?.compatibility}
        value={kind}
        onChange={(value) => {
          setKind(value);
          setWebsockets(false);
        }}
        options={proxyKinds.map((k) => ({ value: k.value, label: k.label, description: k.description }))}
      />
      <Field
        label="Base URL"
        value={baseUrl}
        onChangeText={setUrl}
        placeholder="https://proxy.example"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Hint>The address of your proxy, with or without /v1. Canopy adds the right path for each agent.</Hint>
      <SecretValue
        label="Secret"
        set={proxy?.secretSet ?? false}
        action={action}
        onAction={setAction}
        value={secret}
        onChange={setSecret}
      />
      <Hint>Encrypted in the gateway. Saved values are never shown again.</Hint>
      {kind === "cliproxyapi" && (
        <>
          <SecretValue
            label="Management key"
            set={proxy?.managementKeySet ?? false}
            action={managementAction}
            onAction={setManagementAction}
            value={managementKey}
            onChange={setManagementKey}
            allowClear
          />
          <Hint>Optional. Lets Canopy show the proxy&apos;s accounts and their status. Encrypted in the gateway.</Hint>
        </>
      )}
      {kind !== "anthropic" && (
        <CodexTransport websockets={websockets} onWebsockets={setWebsockets} headers={headers} onHeaders={setHeaders} />
      )}
      <SettingsDisclosure title="Advanced: how agents use this proxy">
        <ProxyMappings kind={kind} baseUrl={baseUrl} />
      </SettingsDisclosure>
      {error ? <Notice error>{error}</Notice> : null}
      <SettingsActions>
        <Button variant="ghost" title="Cancel" onPress={onCancel} />
        <Button
          variant="primary"
          title={proxy ? "Save proxy" : "Add proxy"}
          busy={resource.busy}
          disabled={!name.trim() || !baseUrl.trim()}
          onPress={() => void save()}
        />
      </SettingsActions>
    </ResourceState>
  );
}

/** Codex's transport options (web: ProxyForm "Advanced: Codex transport"). */
function CodexTransport({
  websockets,
  onWebsockets,
  headers,
  onHeaders,
}: {
  websockets: boolean;
  onWebsockets: (value: boolean) => void;
  headers: string;
  onHeaders: (value: string) => void;
}) {
  return (
    <SettingsDisclosure title="Advanced: Codex transport">
      <SettingsGroup>
        <SettingsValue
          title="Wire API"
          value="responses"
          description="The installed Codex adapter uses the Responses API."
        />
        <SettingToggle
          title="Supports WebSockets"
          description="Use HTTP streaming unless the proxy supports Codex WebSocket interruptions."
          value={websockets}
          onChange={onWebsockets}
        />
      </SettingsGroup>
      <Field
        label="Extra headers"
        value={headers}
        onChangeText={onHeaders}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Hint>Public routing metadata only, one Name: value per line. Credentials belong in Secret.</Hint>
    </SettingsDisclosure>
  );
}
