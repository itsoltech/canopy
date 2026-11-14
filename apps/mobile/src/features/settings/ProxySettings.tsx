import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, EmptyState, Sheet } from "../../ui/components";
import { SettingsGroup } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { ConfigNoticesFor } from "./ConfigNoticesFor";
import { ProxyEntry } from "./ProxyEntry";
import { ProxyForm } from "./ProxyForm";

/** Settings → Proxies (web: settings/proxies): saved connections, each with its accounts, test and edit. */
export function ProxySettings() {
  const resource = useSettingsResource("ListProxies", (api) => api.listProxies({}));
  const [editing, setEditing] = useState<ui.Proxy | "new">();
  const proxies = resource.data?.proxies ?? (resource.initialLoading ? [create(ui.ProxySchema, { name: " " })] : []);

  return (
    <ResourceState resource={resource}>
      <ConfigNoticesFor match={(n) => n.kind === "proxy"} onChanged={() => void resource.reload()} />
      <SettingsGroup
        title="Proxies"
        description="Save a connection once, then choose it in any compatible provider instance."
        actions={<Button variant="primary" title="Add proxy" onPress={() => setEditing("new")} />}
      >
        {proxies.map((proxy) => (
          <ProxyEntry key={proxy.id || "loading"} proxy={proxy} onEdit={() => setEditing(proxy)} />
        ))}
        {resource.data && !resource.data.proxies.length && (
          <EmptyState
            icon="link"
            title="One connection for your agents"
            description="Add CLIProxyAPI, a fork, or an Anthropic/OpenAI-compatible endpoint. Its secret stays encrypted in the gateway."
          />
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
            onCancel={() => setEditing(undefined)}
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
