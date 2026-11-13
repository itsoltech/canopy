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
      <SettingsGroup
        title="Diagnostics access"
        description="Allow these computers to read this computer’s diagnostics through a relay."
      >
        {origins.map((peer) => (
          <SettingToggle
            key={peer.nodeId}
            title={peer.displayName || peer.name}
            description={`Via ${peer.viaName}`}
            value={grants.data?.grants.some((grant) => grant.originComputerId === peer.nodeId) ?? false}
            disabled={grants.busy || !grants.data}
            onChange={(enabled) =>
              void grants.run((api) => api.setDiagnosticsGrant({ originComputerId: peer.nodeId, enabled }))
            }
          />
        ))}
      </SettingsGroup>
    </ResourceState>
  );
}
