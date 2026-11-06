import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingChoice, SettingToggle } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";

export function ProxySettings() {
  const resource = useSettingsResource("proxies", (api) => api.listProxies({}));
  const [editing, setEditing] = useState<ui.Proxy | "new">();
  const [test, setTest] = useState<ui.TestProxyResponse>();

  return (
    <ResourceState resource={resource}>
      <Notice>
        Shared connections for your agent providers. Secrets are encrypted in the gateway and never shown again.
      </Notice>
      <Button title="Add proxy" onPress={() => setEditing("new")} />
      {test && (
        <Notice>
          {test.ok
            ? `Connection works · ${test.modelCount} models`
            : "Could not connect. Check the proxy address and secret, then retry."}{" "}
          {test.detail}
        </Notice>
      )}
      <SettingsGroup title="Proxies">
        {resource.data?.proxies.map((proxy) => (
          <SettingsRow key={proxy.id} title={proxy.name} description={`${proxy.kind} · ${proxy.baseUrl}`}>
            <SettingsValue title="Secret" value={proxy.secretSet ? "Set" : "Not set"} />
            <SettingsValue title="Used by" value={proxy.usedBy.join("\n") || "No providers"} />
            <Button secondary title="Edit proxy" onPress={() => setEditing(proxy)} />
            <Button
              secondary
              title="Test connection"
              busy={resource.busy}
              onPress={() =>
                void resource
                  .run((api) => api.testProxy({ id: proxy.id }))
                  .then((r) => {
                    if (r) setTest(r);
                  })
              }
            />
            <Button
              danger
              title="Delete proxy"
              disabled={resource.busy || proxy.usedBy.length > 0}
              onPress={() =>
                confirmAction(
                  "Delete proxy",
                  "This removes the saved connection and its secret. Remove it from providers first.",
                  () => void resource.run((api) => api.deleteProxy({ id: proxy.id, expectedRevision: proxy.revision })),
                )
              }
            />
          </SettingsRow>
        ))}
        {resource.data && !resource.data.proxies.length && (
          <SettingsRow title="No proxies yet" description="Add a proxy to share a connection across your providers." />
        )}
      </SettingsGroup>
      <Sheet
        title={editing === "new" ? "Add proxy" : "Edit proxy"}
        visible={!!editing}
        onClose={() => setEditing(undefined)}
      >
        {editing && (
          <ProxyForm
            key={editing === "new" ? "new" : `${editing.id}/${editing.revision}`}
            proxy={editing === "new" ? undefined : editing}
            onSaved={() => {
              setEditing(undefined);
              void resource.reload();
            }}
          />
        )}
      </Sheet>
    </ResourceState>
  );
}

function ProxyForm({ proxy, onSaved }: { proxy?: ui.Proxy; onSaved: () => void }) {
  const resource = useSettingsResource(`proxy:${proxy?.id ?? "new"}`, (api) => api.listProxies({}));
  const [name, setName] = useState(proxy?.name ?? "");
  const [kind, setKind] = useState(proxy?.kind ?? "cliproxyapi");
  const [baseUrl, setUrl] = useState(proxy?.baseUrl ?? "");
  const [secret, setSecret] = useState("");
  const [replace, setReplace] = useState(!proxy?.secretSet);
  const [websockets, setWebsockets] = useState(proxy?.codex?.supportsWebsockets ?? true);

  const [headers, setHeaders] = useState(
    Object.entries(proxy?.codex?.extraHeaders ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );

  const [error, setError] = useState("");

  async function save() {
    const extraHeaders: Record<string, string> = {};

    for (const line of headers.split("\n").filter((v) => v.trim())) {
      const colon = line.indexOf(":");

      if (colon < 1) {
        setError("Enter extra headers as Name: value, one per line.");

        return;
      }

      extraHeaders[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }

    setError("");

    const result = await resource.run((api) =>
      api.saveProxy({
        id: proxy?.id ?? "",
        name,
        kind,
        baseUrl,
        ...(replace && { secret }),
        expectedRevision: proxy?.revision ?? 0n,
        codex: { wireApi: "responses", supportsWebsockets: websockets, extraHeaders },
      }),
    );

    setSecret("");

    if (result) onSaved();
  }

  return (
    <ResourceState resource={resource}>
      <Field label="Name" value={name} onChangeText={setName} maxLength={80} />
      <SettingChoice
        title="Kind"
        value={kind}
        onChange={(value) => {
          setKind(value);
          setWebsockets(value === "cliproxyapi");
        }}
        options={[
          {
            value: "cliproxyapi",
            label: "CLIProxyAPI or a fork",
            description: "Claude, Codex and Grok can all use it.",
          },
          {
            value: "anthropic",
            label: "Anthropic-compatible",
            description: "Only Claude can use it. Codex and Grok need an OpenAI-compatible proxy.",
          },
          {
            value: "openai",
            label: "OpenAI-compatible",
            description: "Codex and Grok can use it. Claude needs an Anthropic-compatible proxy.",
          },
        ]}
      />
      <Field label="Base URL" value={baseUrl} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} />
      <Notice>The address of your proxy, with or without /v1. Canopy adds the right path for each agent.</Notice>
      {proxy?.secretSet && <SettingToggle title="Replace saved secret" value={replace} onChange={setReplace} />}
      {replace && (
        <Field
          label="Secret"
          secureTextEntry
          value={secret}
          onChangeText={setSecret}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}
      {kind !== "anthropic" && (
        <SettingsGroup title="Advanced: Codex transport">
          <SettingsValue
            title="Wire API"
            value="responses"
            description="The installed Codex adapter uses the Responses API."
          />
          <SettingToggle
            title="Supports WebSockets"
            description="Enable when the upstream supports Codex Responses over WebSockets."
            value={websockets}
            onChange={setWebsockets}
          />
          <Field
            label="Extra headers"
            value={headers}
            onChangeText={setHeaders}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Notice>Public routing metadata only, one Name: value per line. Credentials belong in Secret.</Notice>
        </SettingsGroup>
      )}
      <ProxyMappings kind={kind} baseUrl={baseUrl} />
      {error ? <Notice error>{error}</Notice> : null}
      <Button
        title={proxy ? "Save proxy" : "Add proxy"}
        busy={resource.busy}
        disabled={!name.trim() || !baseUrl.trim() || (replace && !secret)}
        onPress={() => void save()}
      />
    </ResourceState>
  );
}

function ProxyMappings({ kind, baseUrl }: { kind: string; baseUrl: string }) {
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "") || "<proxy>";

  return (
    <SettingsGroup title="Advanced: how agents use this proxy">
      <SettingsValue
        title="Claude"
        value={
          kind === "openai"
            ? "Not applicable: Claude requires the Anthropic Messages API."
            : `ANTHROPIC_BASE_URL=${root}; secret in ANTHROPIC_AUTH_TOKEN; ANTHROPIC_API_KEY empty.`
        }
      />
      <SettingsValue
        title="Codex"
        value={
          kind === "anthropic"
            ? "Not applicable: Codex requires the OpenAI Responses API."
            : `${root}/v1 · Responses · isolated CODEX_HOME · key through env_key.`
        }
      />
      <SettingsValue
        title="Grok"
        value={
          kind === "anthropic"
            ? "Not applicable: this preset maps Grok to OpenAI Chat Completions."
            : `${root}/v1 · custom model · Chat Completions · isolated GROK_HOME.`
        }
      />
    </SettingsGroup>
  );
}
