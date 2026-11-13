import { SettingsGroup, SettingToggle } from "./SettingsGroup";
import { useSettingsResource, ResourceState } from "./resource";

export function DiagnosticsGrants() {
  const capabilities = useSettingsResource("GetClientCapabilities", (api) => api.getClientCapabilities({}));

  const computers = useSettingsResource(
    "GetComputers",
    (api) => api.getComputers({}),
    capabilities.data?.linkedComputers ?? false,
  );

  const grants = useSettingsResource("GetDiagnosticsGrants", (api) => api.getDiagnosticsGrants({}));
  const origins = computers.data?.peers.filter((peer) => peer.diagnosticsGrantEligible) ?? [];

  if (!origins.length) return null;

  return (
    <ResourceState resource={grants}>
      <SettingsGroup title="Diagnostics access" description="Choose what these computers can collect through a relay.">
        {origins.flatMap((peer) =>
          ["diagnostics_read", "diagnostics_logs"].map((permission) => (
            <SettingToggle
              key={`${peer.nodeId}:${permission}`}
              title={peer.displayName || peer.name}
              description={`${permission === "diagnostics_logs" ? "Logs" : "Diagnostics"} via ${peer.viaName}`}
              value={
                grants.data?.grants.some(
                  (grant) =>
                    grant.originComputerId === peer.nodeId && (grant.permission || "diagnostics_read") === permission,
                ) ?? false
              }
              disabled={grants.busy || !grants.data}
              onChange={(enabled) =>
                void grants.run((api) =>
                  api.setDiagnosticsGrant({ originComputerId: peer.nodeId, enabled, permission }),
                )
              }
            />
          )),
        )}
      </SettingsGroup>
    </ResourceState>
  );
}
