<script lang="ts">
  import { GITHUB_ACCOUNTS, GITHUB_AGENT_ACCESS, GITHUB_HOME, qualifyId } from "@canopy/domain/computers";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import GitHubHome from "#lib/features/github/GitHubHome.svelte";
  import Select from "#lib/shared/ui/Select.svelte";

  const overview = useOverview();
  let homeId = $state("");

  const homes = $derived([
    { value: "", label: "This computer", agentAccess: true, disabled: false },
    ...overview.computers
      .values()
      .filter((c) => !c.viaNodeId)
      .map((c) => ({
        value: qualifyId(GITHUB_HOME, c.nodeId),
        label: c.displayName || c.name,
        agentAccess: c.capabilities.includes(GITHUB_AGENT_ACCESS),
        disabled: c.status !== "connected" || !c.capabilities.includes(GITHUB_ACCOUNTS),
      }))
      .toArray(),
  ]);

  $effect(() => {
    if (homeId && !homes.some((home) => home.value === homeId)) homeId = "";
  });
</script>

<div class="flex min-w-0 flex-col gap-6 text-zinc-950 dark:text-white">
  <SettingsHeading title="GitHub" description="Connect accounts and choose which repositories Canopy can access." />
  {#if homes.length > 1}<div class="flex flex-col gap-2">
      <p class="text-base font-medium sm:text-sm">Store accounts on</p>
      <Select
        aria-label="Store GitHub accounts on"
        value={homeId}
        options={homes}
        onchange={(value) => {
          homeId = value;
        }}
      />
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Accounts and tokens stay on the selected computer. It must be online to connect or refresh access.
      </p>
    </div>{/if}
  {#key homeId}<GitHubHome
      {homeId}
      agentAccessAvailable={homes.some((h) => h.value === homeId && h.agentAccess && !h.disabled)}
    />{/key}
</div>
