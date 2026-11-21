<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import ImportSuggestion from "#lib/features/imports/ImportSuggestion.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import SetupFrame from "./SetupFrame.svelte";
  import { setupAgentReady } from "./setup-agent.ts";
  import { chooseSetupWorker } from "./setup-state.ts";

  const overview = useOverview();
  const models = useModelCatalog();
  const capabilities = useGatewayCapabilities();

  const worker = $derived(
    chooseSetupWorker(
      overview.ownWorkers,
      devicePreferences.view.onboardingWorkerId,
      models,
      capabilities?.localDesktop ?? false,
    ),
  );

  const ready = $derived(overview.connection === "live" && setupAgentReady(worker, worker && models.of(worker.id)));
</script>

<svelte:head><title>Start your first task · {applicationName}</title></svelte:head>

<SetupFrame centered>
  <div class="grid justify-items-start gap-6">
    <img src="/icon-192.png" alt="" width="48" height="48" class="size-12" />
    <div class="grid gap-3">
      <h1 class="text-3xl font-semibold tracking-tight text-balance">Start your first task</h1>
      <p class="text-base/7 text-pretty text-muted">
        {ready ? "Try an agent on a sample bug report." : "Connect a worker and set up an agent to start working."}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {#if ready}
        <ButtonLink href="/setup/sample" variant="primary">Try sample task</ButtonLink>
        <ButtonLink href="/setup" variant="secondary">Set up Canopy</ButtonLink>
      {:else}
        <ButtonLink href="/setup" variant="primary">Set up Canopy</ButtonLink>
        <ButtonLink href="/setup/sample" variant="secondary">Try sample task</ButtonLink>
      {/if}
      <Button variant="ghost" onclick={() => devicePreferences.setView({ onboardingSkipped: true })}
        >Skip introduction</Button
      >
    </div>
  </div>
</SetupFrame>
<ImportSuggestion />
