<script lang="ts">
  import { onMount } from "svelte";
  import type { github } from "@canopy/contracts";
  import { accessSummary, sameAccess, type AccessChoice } from "@canopy/domain/access-picker";
  import { agentProjectOptions, agentBotOptions } from "@canopy/domain/github-agent-access";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import { splitId, nodeRef } from "@canopy/domain/computers";
  import AccessList from "#lib/features/access/AccessList.svelte";
  import type { AccessOption } from "#lib/features/access/access-options.ts";
  import { HttpError } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import * as api from "./api.ts";

  let {
    repository,
    removeOnly,
    onclose,
    onsaved,
  }: {
    repository: api.AgentRepository;
    removeOnly: boolean;
    onclose: () => void;
    onsaved: () => void;
  } = $props();

  const overview = useOverview();
  const settings = useSettings();
  const projectsEnabled = $derived(settings.moduleEnabled("threads"));
  const botsEnabled = $derived(settings.moduleEnabled("bots"));
  let open = $state(true);
  let access = $state<github.GitHubAgentAccessResponse>();
  let projects = $state<AccessChoice>({ all: false, ids: [] });
  let bots = $state<AccessChoice>({ all: false, ids: [] });
  let writes = $state(false);
  let saving = $state(false);
  let error = $state("");
  const allowWrites = $derived(Boolean(projects.ids.length || bots.ids.length) && writes);

  const changed = $derived(
    access &&
      (access.allowWrites !== allowWrites ||
        !sameAccess(projects, { all: false, ids: access.projectIds }) ||
        !sameAccess(bots, { all: false, ids: access.botIds })),
  );

  $effect(() => (botsEnabled ? botList.use() : undefined));

  const projectOptions = $derived(
    agentProjectOptions(
      repository.accountId,
      overview.projects,
      access?.projectIds ?? [],
      removeOnly || !projectsEnabled,
    ),
  );

  const home = $derived(splitId(repository.accountId).node);
  const botsAway = $derived(botList.unavailableComputers.some((computer) => nodeRef(computer.nodeId) === home));
  const botsRefreshing = $derived(botList.refreshingComputers.some((computer) => nodeRef(computer.nodeId) === home));

  const botOptions = $derived(
    agentBotOptions(
      repository.accountId,
      botList.list,
      access?.botIds ?? [],
      removeOnly || !botsEnabled || !!botList.error || botsAway,
    ),
  );

  async function load() {
    error = "";
    access = undefined;

    try {
      const value = await api.agentAccess(repository);
      projects = { all: false, ids: value.projectIds };
      bots = { all: false, ids: value.botIds };
      writes = value.allowWrites;
      access = value;
    } catch (cause) {
      error =
        cause instanceof HttpError && cause.status === 426
          ? cause.message
          : "Could not load agent access. Check the home computer’s connection, then retry.";
    }
  }

  async function save() {
    if (!access || !changed || saving) return;
    saving = true;
    error = "";

    try {
      await api.setAgentAccess(repository, projects.ids, bots.ids, allowWrites, access.revision);
      onsaved();
      open = false;
    } catch (cause) {
      // A timeout may also follow a committed save. Reload before allowing another edit.
      access = undefined;
      error =
        cause instanceof HttpError && cause.status < 500
          ? `${cause.message} Reload access to review the current settings.`
          : "Could not confirm the save. Reload access to review the current settings.";
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<Dialog bind:open title="Agent access" description={repository.repositoryName} dismissible={!saving} onexited={onclose}>
  <div class="grid gap-4">
    {#if error}
      <Alert tone="error"
        >{error}
        {#snippet actions()}<Button size="sm" onclick={load}>Reload access</Button>{/snippet}
      </Alert>
    {:else if access}
      <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
        {removeOnly
          ? "Remove projects or bots that no longer need this repository."
          : "Selected projects and bots can read files, issues and pull requests in this repository."}
      </p>
      <fieldset disabled={saving} class="grid min-w-0 gap-3">
        {#if projectsEnabled && !overview.resyncs && !access.projectIds.length}
          <p role="status" class="text-sm/5 text-zinc-500 dark:text-zinc-400">Loading projects…</p>
        {:else if projectsEnabled || access.projectIds.length}
          {@render group("Projects", projectOptions, projects, (choice) => (projects = choice))}
        {/if}
        {#if botsEnabled && !access.botIds.length && (!botList.loaded || botsRefreshing)}
          <p role="status" class="text-sm/5 text-zinc-500 dark:text-zinc-400">Loading bots…</p>
        {:else if access.botIds.length || (botsEnabled && !botsAway && !botList.error)}
          {@render group("Bots", botOptions, bots, (choice) => (bots = choice))}
        {/if}
        {#if botsEnabled && (botList.error || botsAway)}
          <Alert tone="error"
            >Could not load bots. Check the connection, then retry.
            {#snippet actions()}<Button size="sm" onclick={() => botList.refresh()}>Retry</Button>{/snippet}
          </Alert>
        {/if}
        <Checkbox
          name="github-writes"
          label="Allow changes on GitHub"
          description="Selected agents and bots can change issues and pull requests, subject to their approval settings."
          disabled={(!projects.ids.length && !bots.ids.length) || (removeOnly && !access.allowWrites)}
          bind:checked={() => allowWrites, (value) => (writes = value)}
        />
      </fieldset>
      <DialogActions>
        <Button disabled={saving} onclick={() => (open = false)}>Cancel</Button>
        <Button variant="primary" loading={saving} disabled={!changed} onclick={save}>Save access</Button>
      </DialogActions>
    {:else}
      <p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Loading agent access…</p>
    {/if}
  </div>
</Dialog>

{#snippet group(
  label: string,
  options: readonly AccessOption[],
  choice: AccessChoice,
  update: (value: AccessChoice) => void,
)}
  <Disclosure summaryClass="items-center p-2 text-base/6 sm:text-sm/6" class="rounded-lg border border-divider">
    {#snippet summary()}
      <span class="flex min-w-0 items-center gap-3">
        <span class="font-medium">{label}</span>
        <TruncatedText
          text={accessSummary(choice, options, label.toLowerCase())}
          class="ml-auto text-zinc-500 dark:text-zinc-400"
        />
      </span>
    {/snippet}
    <AccessList {options} noun={label.toLowerCase()} allowAll={false} bind:choice={() => choice, update} />
  </Disclosure>
{/snippet}
