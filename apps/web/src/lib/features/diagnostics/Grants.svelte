<script lang="ts">
  import { ui } from "@canopy/contracts";
  import { sharedRead } from "#lib/shared/queries.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  const capabilities = useGatewayCapabilities();

  const computers = $derived(
    capabilities?.linkedComputers
      ? sharedRead("GetComputers", ui.ComputersSnapshotSchema, "/api/computers")
      : undefined,
  );

  const grants = sharedRead("GetDiagnosticsGrants", ui.DiagnosticsGrantsSchema, "/api/diagnostics/grants");
  const origins = $derived(computers?.data?.peers.filter((peer) => peer.diagnosticsGrantEligible) ?? []);
  let busy = $state(false);
  let error = $state("");

  async function change(originComputerId: string, enabled: boolean) {
    if (busy) return;
    busy = true;
    error = "";

    try {
      grants.set(
        decode(
          ui.DiagnosticsGrantsSchema,
          await requestJson("POST", "/api/diagnostics/grants", { originComputerId, enabled }),
        ),
      );
    } catch {
      error = "Could not change diagnostics access. Retry to refresh access.";
    } finally {
      busy = false;
    }
  }
</script>

{#if origins.length}
  <SettingsGroup
    title="Diagnostics access"
    description="Allow these computers to read this computer’s diagnostics through a relay."
  >
    {#if error || grants.snapshot.error}<div class="p-3">
        <Alert tone="error"
          >{error || "Could not load diagnostics access. Retry to refresh access."}
          {#snippet actions()}<Button
              onclick={() => {
                error = "";
                void grants.reload();
              }}>Retry</Button
            >{/snippet}
        </Alert>
      </div>{/if}
    {#each origins as peer (peer.nodeId)}
      <SettingsRow title={peer.displayName || peer.name} description={`Via ${peer.viaName}`}>
        {#snippet control()}
          <Switch
            name={`diagnostics-${peer.nodeId}`}
            label={`Allow diagnostics access from ${peer.displayName || peer.name}`}
            checked={grants.data?.grants.some((grant) => grant.originComputerId === peer.nodeId) ?? false}
            disabled={busy || !grants.data}
            onchange={(enabled) => void change(peer.nodeId, enabled)}
          />
        {/snippet}
      </SettingsRow>
    {/each}
  </SettingsGroup>
{/if}
