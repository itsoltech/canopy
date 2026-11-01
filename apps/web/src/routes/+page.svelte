<script lang="ts">
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { PermissionMode } from "@open-agents/contracts";
  import { untrack } from "svelte";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { effectiveDefaults } from "#lib/features/settings/thread-defaults.ts";
  import ComposerBox from "#lib/features/threads/components/ComposerBox.svelte";
  import ComposerPill from "#lib/features/threads/components/ComposerPill.svelte";
  import ModelPill from "#lib/features/threads/components/ModelPill.svelte";
  import { permissionModes } from "#lib/features/threads/labels.ts";
  import { agentChoices, knownModels, profileIdValue, providerKeyOf, type ProviderKey } from "#lib/features/threads/providers.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { PageProps } from "./$types";

  /**
   * New thread (T3's empty state): one message box; the agent (Claude or Codex with a profile the
   * workspace's worker offers), model, workspace and permissions as pills. They start from the chosen
   * project's defaults over yours (Settings); what you pick here wins.
   */
  let { form }: PageProps = $props();
  const overview = useOverview();
  const settings = useSettings();

  const workspaces = $derived(overview.projects.flatMap((project) => project.workspaces.map((workspace) => ({ project, workspace }))));
  // ?project=<id>: that project's default workspace, else its first one. Otherwise your default workspace,
  // else the first one overall.
  const requested = page.url.searchParams.get("project");
  let workspaceId = $state(
    untrack(() => {
      const inProject = workspaces.filter((w) => w.project.id === requested);
      const preferred = requested ? settings.projectDefaults(requested).workspaceId : settings.threadDefaults.workspaceId;
      const pool = inProject.length > 0 ? inProject : workspaces;
      return (pool.find((w) => w.workspace.id === preferred) ?? pool[0])?.workspace.id ?? "";
    }),
  );
  const chosen = $derived(workspaces.find((w) => w.workspace.id === workspaceId));
  const worker = $derived(overview.worker(chosen?.workspace.workerId ?? ""));
  const defaults = $derived(effectiveDefaults(settings.threadDefaults, chosen ? settings.projectDefaults(chosen.project.id) : undefined));
  const defaultProvider = $derived(providerKeyOf(defaults.provider));

  // Provider + profile pairs the worker can start. Until you pick one: the defaults' pair, else the
  // defaults' provider, else the first offered pair (also when your pick is not offered here).
  const groups = $derived(agentChoices(worker));
  const choices = $derived(groups.flatMap((g) => g.choices));
  let agent = $state<string>();
  const fromDefaults = $derived(
    defaultProvider
      ? ((defaults.providerProfileId && choices.find((c) => c.provider === defaultProvider && c.profileId === profileIdValue(defaults.providerProfileId))) ||
          choices.find((c) => c.provider === defaultProvider))
      : undefined,
  );
  const selected = $derived(choices.find((c) => c.value === agent) ?? fromDefaults ?? choices[0]);
  // A model per provider: switching Claude ↔ Codex keeps what was typed for each.
  let models = $state<Partial<Record<ProviderKey, string>>>({});
  const modelOf = (key: ProviderKey) => models[key] ?? (key === defaultProvider ? defaults.model : "");
  const suggestions = $derived(selected ? knownModels(overview.threads.values(), selected.provider) : []);
  let permission = $state<string>();
  const permissionMode = $derived(permission ?? (defaults.permissionMode !== PermissionMode.UNSPECIFIED ? PermissionMode[defaults.permissionMode] : "ASK"));

  let message = $state("");
  let busy = $state(false);
  // Thread title: the first line of the task (the gateway falls back to "New thread").
  const title = $derived(message.trim().split("\n")[0]?.slice(0, 80) ?? "");
  const clientRequestId = crypto.randomUUID();
</script>

<svelte:head><title>New thread · Open Agents</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar>
    <Crumb><span class="flex items-center gap-2 text-zinc-500 dark:text-zinc-400"><Icon name="folder" class="fill-zinc-400 dark:fill-zinc-600" />{chosen?.project.name ?? "No project"}</span></Crumb>
    <Crumb>New thread</Crumb>
  </TopBar>

  <div class="grid min-h-0 flex-1 place-items-center overflow-y-auto px-4 pb-16 sm:px-6">
    <div class="w-full max-w-(--chat-width)">
      <div class="mb-8 text-center">
        <h1 class="text-3xl font-medium tracking-tight text-balance text-zinc-950 dark:text-white">What should we work on?</h1>
        <p class="mt-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{chosen ? chosen.project.name : "No project"}</p>
      </div>

      {#if workspaces.length === 0}
        <EmptyState
          icon="folder-open"
          title={overview.projects.length === 0 ? "Create a project first" : "Add a workspace first"}
          description="A thread runs in a directory on one of your workers. Set up a project and its workspace in Settings."
        >
          {#snippet action()}<ButtonLink href="/settings/projects" variant="primary" icon="cog-6-tooth">Open project settings</ButtonLink>{/snippet}
        </EmptyState>
      {:else}
        <form
          method="POST"
          action="?/createThread"
          class="grid gap-3"
          use:enhance={() => {
            busy = true;
            return async ({ update }) => {
              await update({ reset: false });
              busy = false;
            };
          }}
        >
          <input type="hidden" name="projectId" value={chosen?.project.id ?? ""} />
          <input type="hidden" name="title" value={title} />
          <input type="hidden" name="clientRequestId" value={clientRequestId} />
          <input type="hidden" name="provider" value={selected?.provider ?? ""} />
          <input type="hidden" name="profileId" value={selected?.profileId ?? ""} />
          {#if form?.error}<Alert tone="error">{form.error}</Alert>{/if}
          <ComposerBox bind:value={message} sending={busy} disabled={!selected} autofocus label="Task for the agent">
            {#snippet controls()}
              <span class="flex min-w-0 flex-1 items-center justify-end gap-1">
                {#if selected}
                  <ComposerPill name="agent" label="Agent and profile" bind:value={() => selected.value, (value) => (agent = value)} class="shrink">
                    {#each groups as group (group.provider)}
                      <optgroup label={group.provider === "CLAUDE" ? "Claude" : "Codex"}>
                        {#each group.choices as choice (choice.value)}<option value={choice.value}>{choice.label}</option>{/each}
                      </optgroup>
                    {/each}
                  </ComposerPill>
                  <ModelPill bind:value={() => modelOf(selected.provider), (value) => (models[selected.provider] = value)} {suggestions} label="{selected.provider === 'CLAUDE' ? 'Claude' : 'Codex'} model" class="shrink" />
                {:else}
                  <span class="truncate px-2 text-sm/5 text-zinc-500 sm:text-[0.8125rem]/5 dark:text-zinc-400">No agent available</span>
                {/if}
              </span>
            {/snippet}
            {#snippet meta()}
              <span class="flex min-w-0 items-center gap-1">
                <Icon name="computer-desktop" class="size-3.5 shrink-0" />
                <ComposerPill name="workspaceId" label="Workspace" bind:value={workspaceId} class="-ml-1">
                  {#each overview.projects.filter((p) => p.workspaces.length > 0) as project (project.id)}
                    <optgroup label={project.name}>
                      {#each project.workspaces as ws (ws.id)}
                        {@const owner = overview.worker(ws.workerId)}
                        <option value={ws.id}>{owner?.name ?? "Unknown worker"}{owner?.online ? "" : " (offline)"} · {ws.rootPath}</option>
                      {/each}
                    </optgroup>
                  {/each}
                </ComposerPill>
              </span>
              <span class="flex shrink-0 items-center gap-1">
                <Icon name="shield-check" class="size-3.5" />
                <ComposerPill name="permissionMode" label="Permissions" class="-ml-1" bind:value={() => permissionMode, (value) => (permission = String(value))}>
                  {#each permissionModes as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
                </ComposerPill>
              </span>
            {/snippet}
          </ComposerBox>
          {#if worker && !selected}
            <p class="px-3 text-sm/5 text-amber-700 sm:text-xs/5 dark:text-amber-400" role="status">{worker.name} reports neither Claude nor Codex as available. Check the worker in Settings.</p>
          {:else if worker && !worker.online}
            <p class="px-3 text-sm/5 text-amber-700 sm:text-xs/5 dark:text-amber-400" role="status">{worker.name} is offline. The thread starts when it reconnects.</p>
          {/if}
        </form>
      {/if}
    </div>
  </div>
</div>
