<script lang="ts">
  import { applicationIcon, applicationName } from "#lib/application-name.ts";
  import { goto } from "$app/navigation";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import SetupAgent from "#lib/features/onboarding/SetupAgent.svelte";
  import SetupFrame from "#lib/features/onboarding/SetupFrame.svelte";
  import SetupImport from "#lib/features/onboarding/SetupImport.svelte";
  import SetupProjects from "#lib/features/onboarding/SetupProjects.svelte";
  import { setupAgentReady } from "#lib/features/onboarding/setup-agent.ts";
  import { chooseSetupWorker, setupThreadHref } from "#lib/features/onboarding/setup-state.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";

  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const settings = useSettings();
  const models = useModelCatalog();

  let workspaceId = $state("");
  const threads = $derived(settings.moduleEnabled("threads"));
  const workers = $derived(overview.ownWorkers.filter((worker) => !worker.revokedAt));

  const worker = $derived(
    chooseSetupWorker(workers, devicePreferences.view.onboardingWorkerId, models, capabilities?.localDesktop ?? false),
  );

  const connected = $derived(overview.connection === "live");
  const ready = $derived(connected && setupAgentReady(worker, worker && models.of(worker.id)));

  const workspace = $derived(
    overview.ownProjects
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === workspaceId && workspace.workerId === worker?.id) ??
      overview.projectChoices
        .find((project) => project.kind === "scratch")
        ?.workspaces.find((workspace) => workspace.workerId === worker?.id),
  );

  function exitSetup() {
    if (threads) devicePreferences.setView({ onboardingSkipped: true });
    void goto(threads ? "/threads/new" : "/bots");
  }
</script>

<svelte:head><title>Set up Canopy · {applicationName}</title></svelte:head>

<SetupFrame>
  <div><Button variant="ghost" icon="arrow-left" onclick={exitSetup}>Exit setup</Button></div>
  <header class="grid gap-3">
    <img src={applicationIcon} alt="" width="48" height="48" class="size-12" />
    <h1 class="text-3xl font-semibold tracking-tight text-balance">Set up Canopy</h1>
    <p class="text-base/7 text-pretty text-muted">Set up one agent, then choose what to bring into Canopy.</p>
  </header>

  <SettingsGroup
    title="Choose a worker"
    description="Choose the computer that runs your agent and can reach your files."
  >
    <div class="grid gap-3 p-4 sm:justify-items-start">
      {#if !connected}
        <p class="text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">Checking setup…</p>
      {:else if workers.length}
        <div class="w-full min-w-0 sm:max-w-80">
          <Select
            aria-label="Choose a worker"
            value={worker?.id}
            options={workers.map((item) => ({
              value: item.id,
              label: item.name,
              description: item.online ? "Connected" : "Offline",
            }))}
            onchange={(onboardingWorkerId) => {
              workspaceId = "";
              devicePreferences.setView({ onboardingWorkerId });
            }}
          />
        </div>
        {#if worker && !worker.online}
          <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
            “{worker.name}” is offline. Start it or choose another worker.
          </p>
          <ButtonLink href={`/settings/workers/${encodeURIComponent(worker.id)}`} variant="secondary">
            Open worker settings
          </ButtonLink>
        {/if}
      {:else if capabilities?.localDesktop}
        <p class="text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">Waiting for the local worker…</p>
        <ButtonLink href="/settings/workers" variant="secondary">Open worker settings</ButtonLink>
      {:else}
        <ButtonLink href="/settings/workers?add=1" variant="primary">Add worker</ButtonLink>
      {/if}
    </div>
  </SettingsGroup>

  {#if worker && connected && worker.online}
    <SettingsGroup title="Set up an agent" description="Use an existing sign-in or connect to a model service.">
      <SetupAgent {worker} />
    </SettingsGroup>

    {#if threads && worker.cliImport && capabilities?.supports("/settings/import") !== false}
      <SettingsGroup
        title="Import CLI history"
        description={`Review threads and settings from Claude Code, Codex or Grok on “${worker.name}”.`}
      >
        <div class="p-4"><SetupImport {worker} /></div>
      </SettingsGroup>
    {/if}

    {#if threads}
      <SettingsGroup
        title="Add projects"
        description={`Choose the directories you want your agent to work in on “${worker.name}”.`}
      >
        <div class="p-4"><SetupProjects {worker} bind:workspaceId /></div>
      </SettingsGroup>
    {/if}
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    {#if threads}
      {#if ready && workspace}
        <ButtonLink href={setupThreadHref(workspace)} variant="primary">Start a thread</ButtonLink>
      {/if}
      <ButtonLink href="/setup/sample" variant="secondary">Try sample task</ButtonLink>
    {:else}
      <ButtonLink href="/bots" variant={ready ? "primary" : "secondary"}>Open bots</ButtonLink>
    {/if}
    <ButtonLink href="/setup/privacy" variant="ghost">Learn about privacy</ButtonLink>
  </div>
</SetupFrame>
