<script lang="ts">
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { Provider, type ui } from "@canopy/contracts";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { effectiveDefaults, modelFor } from "#lib/features/settings/thread-defaults.ts";
  import { defaultProject, defaultWorkspace } from "#lib/features/projects/placement.ts";
  import ProjectPicker from "#lib/features/projects/ProjectPicker.svelte";
  import WorkerPicker from "#lib/features/projects/WorkerPicker.svelte";
  import ComposerBox from "#lib/features/threads/components/ComposerBox.svelte";
  import { AttachmentDraft, limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import type { Mention } from "@canopy/contracts";
  import ComposerNotice from "#lib/features/threads/components/ComposerNotice.svelte";
  import { findOption, modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import PermissionPicker from "#lib/features/threads/components/PermissionPicker.svelte";
  import { permissionKey, type PermissionModeKey } from "#lib/features/threads/labels.ts";
  import { profileIdValue, providerKeyOf } from "#lib/features/threads/providers.ts";
  import PillText from "#lib/shared/ui/PillText.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import type { PageProps } from "./$types";

  /**
   * New thread (T3's empty state): one message box; under it the project and the worker it runs on (two
   * pickers: the worker list has only the workers the project lives on) and permissions; in it the model
   * (Claude or Codex on a profile the chosen worker offers) and reasoning effort. They start from the
   * project's defaults over yours (Settings), then what you used last; what you pick here wins.
   */
  let { form }: PageProps = $props();
  const overview = useOverview();
  const settings = useSettings();

  // ?project=<id> preselects the project; a new link (another project's "New thread") starts over.
  const requested = $derived(page.url.searchParams.get("project") ?? "");
  let picks = $state<{ requested: string; projectId?: string; workspaceId?: string }>({ requested: "" });
  const placed = $derived(picks.requested === requested ? picks : undefined);
  const project = $derived(
    overview.project(placed?.projectId ?? "") ??
      defaultProject({ projects: overview.projects, threads: overview.threads.values(), requested, defaultWorkspaceId: settings.threadDefaults.workspaceId }),
  );
  const defaults = $derived(effectiveDefaults(settings.threadDefaults, project ? settings.projectDefaults(project.id) : undefined));
  const workspace = $derived.by(() => {
    if (!project) return undefined;
    const pick = project.workspaces.find((w) => w.id === placed?.workspaceId);
    const online = (id: string) => overview.worker(id)?.online ?? false;
    return pick ?? defaultWorkspace({ project, threads: overview.threads.values(), defaultWorkspaceId: defaults.workspaceId, online });
  });
  const worker = $derived(overview.worker(workspace?.workerId ?? ""));
  const pickProject = (next: ui.Project) => (picks = { requested, projectId: next.id });
  const pickWorkspace = (next: ui.Workspace) => (picks = { requested, projectId: project?.id, workspaceId: next.id });
  const defaultProvider = $derived(providerKeyOf(defaults.provider));

  // Model options (provider × profile × model) from the worker's catalog. Until you pick one: the defaults'
  // provider, profile and model (the profile's default model when the list lacks it), else the defaults'
  // provider, else the first option (also when your pick is not offered on this workspace's worker).
  const models = useModelCatalog();
  const workerId = $derived(workspace?.workerId ?? "");
  const options = $derived(modelOptions({ worker, catalog: models.of(workerId), threads: overview.threads.values(), defaults }));
  let picked = $state<ModelOption>();
  const fromDefaults = $derived.by(() => {
    if (!defaultProvider) return undefined;
    const ofProvider = options.filter((o) => o.provider === defaultProvider);
    const profile = defaults.providerProfileId ? profileIdValue(defaults.providerProfileId) : undefined;
    const profileId = profile !== undefined && ofProvider.some((o) => o.profileId === profile) ? profile : ofProvider[0]?.profileId;
    if (profileId === undefined) return undefined;
    return findOption(options, defaultProvider, profileId, modelFor(defaults, Provider[defaultProvider])) ?? findOption(options, defaultProvider, profileId, "");
  });
  const offered = (option: ModelOption | undefined) => option && options.some((o) => o.provider === option.provider && o.profileId === option.profileId);
  const selected = $derived(offered(picked) ? picked : (fromDefaults ?? options[0]));
  // Not picked and the profile's default: "" (the thread follows the profile's default model).
  const model = $derived(!selected || (selected !== picked && selected.isDefault) ? "" : selected.model);
  let effort = $state<string>();
  // Only an effort the model takes (switching the workspace can change the model).
  const sentEffort = $derived(effort && selected?.efforts.some((e) => e.id === effort) ? effort : "");
  let permission = $state<PermissionModeKey>();
  const permissionMode = $derived(permission ?? permissionKey(defaults.permissionMode));

  let message = $state("");
  let mentions = $state<Mention[]>([]);
  // Mentions of the first message: commands, skills and files of the chosen worker, folder and agent.
  const sources = new MentionSources(() =>
    workspace && selected ? { workspaceId: workspace.id, provider: Provider[selected.provider], providerProfileId: selected.profileId } : undefined,
  );
  // Files of the first message (uploaded as added; their ids go with the form).
  const draft = new AttachmentDraft(() => limitsOf(settings.attachmentLimits));
  let busy = $state(false);
  const clientRequestId = crypto.randomUUID();

  // Why the message cannot go yet (the send button is disabled and this says why).
  const blocker = $derived.by(() => {
    if (!project) return undefined;
    if (!workspace) return "no-worker" as const;
    if (!worker?.online) return "offline" as const;
    if (!selected) return "no-agent" as const;
    return undefined;
  });
</script>

<svelte:head><title>New thread · Canopy</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar>
    <Crumb><span class="flex items-center gap-2 text-zinc-500 dark:text-zinc-400"><ProjectMark name={project?.name ?? "No project"} kind={project?.kind} />{project?.name ?? "No project"}</span></Crumb>
    <Crumb>New thread</Crumb>
  </TopBar>

  <div class="grid min-h-0 flex-1 place-items-center overflow-y-auto px-4 pb-16 sm:px-6">
    <div class="w-full max-w-(--chat-width)">
      <div class="mb-8 text-center">
        <h1 class="text-3xl font-medium tracking-tight text-balance text-zinc-950 dark:text-white">What should we work on?</h1>
      </div>

      {#if !project}
        <EmptyState icon="folder-open" title="Create a project first" description="A thread runs in a project's directory on one of your workers. Create a project in Settings and add it to a worker.">
          {#snippet action()}<ButtonLink href="/settings/projects" variant="primary" icon="cog-6-tooth">Open project settings</ButtonLink>{/snippet}
        </EmptyState>
      {:else}
        <form
          method="POST"
          action="?/createThread"
          class="grid gap-3"
          use:enhance={({ cancel }) => {
            if (draft.blocker) return cancel();
            busy = true;
            return async ({ update }) => {
              await update({ reset: false });
              busy = false;
            };
          }}
        >
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="clientRequestId" value={clientRequestId} />
          <input type="hidden" name="provider" value={selected?.provider ?? ""} />
          <input type="hidden" name="profileId" value={selected?.profileId ?? ""} />
          <input type="hidden" name="model" value={model} />
          <input type="hidden" name="effort" value={sentEffort} />
          <input type="hidden" name="workspaceId" value={workspace?.id ?? ""} />
          <input type="hidden" name="permissionMode" value={permissionMode} />
          {#each draft.ids as id (id)}<input type="hidden" name="attachmentId" value={id} />{/each}
          {#if form?.error}<Alert tone="error">{form.error}</Alert>{/if}
          <ComposerBox
            bind:value={message}
            bind:mentions
            {sources}
            sending={busy}
            canSend={!blocker && !draft.blocker}
            autofocus
            label="Task for the agent"
            {draft}
          >
            {#snippet controls()}
              {#if workspace && selected}
                <ModelControls {options} bind:option={() => selected, (option) => (picked = option)} bind:effort {workerId} class="flex-1 justify-end" />
              {:else if worker?.online}
                <PillText class="flex-1 text-right">No agent available</PillText>
              {/if}
            {/snippet}
            {#snippet meta()}
              <span class="-ml-2 flex min-w-0 items-center gap-0.5">
                <ProjectPicker projects={overview.projects} value={project.id} onselect={pickProject} class="max-w-48 sm:max-w-56" />
                <WorkerPicker {project} value={workspace?.id} onselect={pickWorkspace} />
              </span>
              <PermissionPicker value={permissionMode} onselect={(mode) => (permission = mode)} class="-mr-1.5" />
            {/snippet}
          </ComposerBox>
          {#if draft.blocker && !blocker}
            <ComposerNotice>{draft.blocker}</ComposerNotice>
          {/if}
          {#if blocker === "no-worker"}
            <ComposerNotice>
              {#if project.kind === "scratch"}
                Choose a worker with an allowed directory to start a scratch thread.
                <TextLink href="/settings/workers">Configure a worker</TextLink>
              {:else}
                {project.name} is not on any worker yet, so there is nowhere to run the thread.
                <TextLink href="/settings/projects/{project.id}">Add it to a worker</TextLink>
              {/if}
            </ComposerNotice>
          {:else if blocker === "offline"}
            <ComposerNotice tone="warning">
              {worker?.name ?? "This worker"} is offline. Start it or choose another worker to send.
            </ComposerNotice>
          {:else if blocker === "no-agent"}
            <ComposerNotice tone="warning">{worker?.name} reports no available agents. Check the worker in Settings.</ComposerNotice>
          {/if}
          {#if project.kind === "scratch" && workspace && !blocker}
            <ComposerNotice>A dedicated scratch directory is created when you send. Files are kept until you remove them manually.</ComposerNotice>
          {/if}
        </form>
      {/if}
    </div>
  </div>
</div>
