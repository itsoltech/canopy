<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { Provider, type ui } from "@canopy/contracts";
  import type { ProjectChoice } from "@canopy/domain/projects";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { effectiveDefaults, modelFor } from "#lib/features/settings/thread-defaults.ts";
  import { defaultProject, defaultWorkspace } from "#lib/features/projects/placement.ts";
  import ProjectPicker from "#lib/features/projects/ProjectPicker.svelte";
  import WorkerPicker from "#lib/features/projects/WorkerPicker.svelte";
  import ComposerBox from "#lib/features/threads/components/ComposerBox.svelte";
  import { FileIntake, provideFileIntake } from "#lib/features/attachments/file-intake.svelte.ts";
  import FileDropOverlay from "#lib/features/attachments/FileDropOverlay.svelte";
  import { AttachmentDraft, limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import type { Mention } from "@canopy/contracts";
  import { findOption, modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import PermissionPicker from "#lib/features/threads/components/PermissionPicker.svelte";
  import { permissionKey } from "#lib/features/threads/labels.ts";
  import { NEW_THREAD, usePermissionDrafts } from "#lib/features/threads/permission-drafts.svelte.ts";
  import { profileIdValue, providerKeyOf } from "#lib/features/threads/providers.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";
  import RefPicker from "#lib/features/worktrees/RefPicker.svelte";
  import WorkspacePicker from "#lib/features/worktrees/WorkspacePicker.svelte";
  import ImportSuggestion from "#lib/features/imports/ImportSuggestion.svelte";
  import ComposerContextRow from "#lib/features/threads/components/ComposerContextRow.svelte";
  import { WorkspaceDraft } from "#lib/features/worktrees/workspace-draft.svelte.ts";
  import type { PageProps } from "./$types";

  /**
   * New thread: one message box; under it the project and the worker it runs on (two
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
    overview.projectChoice(placed?.projectId ?? "") ??
      defaultProject({
        projects: overview.projectChoices,
        threads: overview.threads.values(),
        requested,
        defaultWorkspaceId: settings.threadDefaults.workspaceId,
      }),
  );

  const defaults = $derived(
    effectiveDefaults(settings.threadDefaults, project ? settings.projectDefaults(project.id) : undefined),
  );

  const workspace = $derived.by(() => {
    if (!project) return undefined;
    const pick = project.workspaces.find((w) => w.id === placed?.workspaceId);
    const online = (id: string) => overview.worker(id)?.online ?? false;

    return (
      pick ??
      defaultWorkspace({
        project,
        threads: overview.threads.values(),
        defaultWorkspaceId: defaults.workspaceId,
        online,
      })
    );
  });

  const worker = $derived(overview.worker(workspace?.workerId ?? ""));
  const unavailable = $derived(worker?.nodeId ? awayReason(overview.computer(worker.nodeId)) : undefined);

  // Checkout, new worktree or a previous one, and the base ref (docs/worktrees.md): when the worker offers worktrees.
  const place = new WorkspaceDraft(() =>
    workspace && project?.kind !== "scratch"
      ? { workspaceId: workspace.id, ready: Boolean(worker?.online && worker.worktrees) }
      : undefined,
  );

  const pickProject = (next: ProjectChoice) => (picks = { requested, projectId: next.id });
  const pickWorkspace = (next: ui.Workspace) => (picks = { requested, projectId: project?.id, workspaceId: next.id });
  const defaultProvider = $derived(providerKeyOf(defaults.provider));

  // Model options (provider × profile × model) from the worker's catalog. Until you pick one: the defaults'
  // provider, profile and model (the profile's default model when the list lacks it), else the defaults'
  // provider, else the first option (also when your pick is not offered on this workspace's worker).
  const models = useModelCatalog();
  const workerId = $derived(workspace?.workerId ?? "");

  const options = $derived(
    modelOptions({ worker, catalog: models.of(workerId), threads: overview.threads.values(), defaults }),
  );

  let picked = $state<ModelOption>();

  const fromDefaults = $derived.by(() => {
    if (!defaultProvider) return undefined;
    const ofProvider = options.filter((o) => o.provider === defaultProvider);
    const profile = defaults.providerProfileId ? profileIdValue(defaults.providerProfileId) : undefined;

    const profileId =
      profile !== undefined && ofProvider.some((o) => o.profileId === profile) ? profile : ofProvider[0]?.profileId;

    if (profileId === undefined) return undefined;

    return (
      findOption(options, defaultProvider, profileId, modelFor(defaults, Provider[defaultProvider])) ??
      findOption(options, defaultProvider, profileId, "")
    );
  });

  const offered = (option: ModelOption | undefined) =>
    option && options.some((o) => o.provider === option.provider && o.profileId === option.profileId);

  const selected = $derived(offered(picked) ? picked : (fromDefaults ?? options[0]));

  // Not picked and the profile's default: "" (the thread follows the profile's default model).
  const model = $derived(!selected || (selected !== picked && selected.isDefault) ? "" : selected.model);
  let effort = $state<string>();

  // Only an effort the model takes (switching the workspace can change the model).
  const sentEffort = $derived(effort && selected?.efforts.some((e) => e.id === effort) ? effort : "");

  // Your pick stays with the new-thread draft (leave and come back); unset = the defaults (Settings → Threads).
  const permissions = usePermissionDrafts();
  const permissionMode = $derived(permissions.get(NEW_THREAD) ?? permissionKey(defaults.permissionMode));

  let message = $state("");
  let mentions = $state<Mention[]>([]);

  // Mentions of the first message: commands, skills and files of the chosen worker, folder and agent.
  const sources = new MentionSources(() => {
    const choice = place.choice;

    return workspace && selected
      ? {
          workspaceId: workspace.id,
          provider: Provider[selected.provider],
          providerProfileId: selected.profileId,
          cwd: choice.kind === "existing" ? choice.worktree.path : "",
        }
      : undefined;
  });

  // Files of the first message (uploaded as added; their ids go with the form).
  const draft = new AttachmentDraft(() => limitsOf(settings.attachmentLimits));

  // Files pasted anywhere on the page (outside a text field) or dropped on it attach to the message.
  const intake = provideFileIntake(new FileIntake());
  let busy = $state(false);
  const clientRequestId = crypto.randomUUID();

  // Why the message cannot go yet (the send button is disabled and this says why).
  const blocker = $derived.by(() => {
    if (!project) return undefined;

    if (!workspace) return "no-worker" as const;

    if (unavailable || !worker?.online) return "offline" as const;

    if (place.loading) return "workspace-loading" as const;

    if (!selected) return "no-agent" as const;

    return undefined;
  });

  const workerNote = $derived(
    blocker === "no-worker"
      ? project?.kind === "scratch"
        ? "Choose a worker with an allowed directory to start a scratch thread. Configure a worker in Settings."
        : `${project?.name} is not on any worker yet, so there is nowhere to run the thread. Add it to a worker in project settings.`
      : blocker === "offline"
        ? unavailable
          ? `${unavailable} Choose another worker to send.`
          : `${worker?.name ?? "This worker"} is offline. Start it or choose another worker to send.`
        : blocker === "no-agent"
          ? `${worker?.name} reports no available agents. Check the worker in Settings.`
          : undefined,
  );

  const workspaceNote = $derived(
    place.loading ? "Loading workspace options…" : place.error ? place.error : place.refs?.detail || undefined,
  );

  const blockedReason = $derived(workerNote ?? (place.loading ? workspaceNote : undefined) ?? draft.blocker);
</script>

<svelte:head><title>New thread · {applicationName}</title></svelte:head>

<div class="relative flex h-full flex-col" {@attach intake.zone}>
  <TopBar>
    <Crumb current={false}
      >{#snippet mark()}<ProjectMark
          name={project?.name ?? "No project"}
          kind={project?.kind}
        />{/snippet}{project?.name ?? "No project"}</Crumb
    >
    <Crumb>New thread</Crumb>
  </TopBar>

  <div class="relative grid min-h-0 flex-1 place-items-center overflow-y-auto px-4 pb-16 sm:px-6">
    <div class="w-full max-w-(--chat-width)">
      <div class="mb-8 text-center">
        <h1 class="text-3xl font-medium tracking-tight text-balance text-zinc-950 dark:text-white">
          What should we work on?
        </h1>
      </div>

      {#if !project}
        <EmptyState
          icon="folder-open"
          title="Create a project first"
          description="A thread runs in a project's directory on one of your workers. Create a project in Settings and add it to a worker."
        >
          {#snippet action()}<ButtonLink href="/settings/projects" variant="primary" icon="cog-6-tooth"
              >Open project settings</ButtonLink
            >{/snippet}
        </EmptyState>
      {:else}
        <form
          method="POST"
          action="?/createThread"
          class="grid gap-3"
          use:enhance={({ cancel }) => {
            if (blockedReason) return cancel();
            busy = true;
            return async ({ result, update }) => {
              if (result.type === "redirect") permissions.clear(NEW_THREAD);
              await update({ reset: false });
              busy = false;
            };
          }}
        >
          <input type="hidden" name="projectId" value={workspace?.projectId ?? project.id} />
          <input type="hidden" name="clientRequestId" value={clientRequestId} />
          <input type="hidden" name="provider" value={selected?.provider ?? ""} />
          <input type="hidden" name="profileId" value={selected?.profileId ?? ""} />
          <input type="hidden" name="model" value={model} />
          <input type="hidden" name="effort" value={sentEffort} />
          <input type="hidden" name="workspaceId" value={workspace?.id ?? ""} />
          <input type="hidden" name="permissionMode" value={permissionMode} />
          <input type="hidden" name="workspaceMode" value={place.form.workspaceMode} />
          <input type="hidden" name="baseRef" value={place.form.baseRef} />
          <input type="hidden" name="worktreeId" value={place.form.worktreeId} />
          {#each draft.ids as id (id)}<input type="hidden" name="attachmentId" value={id} />{/each}
          {#if form?.error}<Alert tone="error">{form.error}</Alert>{/if}
          <ComposerBox
            shell
            bind:value={message}
            bind:mentions
            {sources}
            sending={busy}
            canSend={!blocker && !draft.blocker}
            {blockedReason}
            autofocus
            label="Task for the agent"
            {draft}
          >
            {#snippet controls()}
              {#if workspace && selected}
                <ModelControls
                  {options}
                  bind:option={() => selected, (option) => (picked = option)}
                  bind:effort
                  {workerId}
                  class="flex-1 justify-end"
                />
              {/if}
            {/snippet}
            {#snippet meta()}
              <ComposerContextRow hasWorkspace={Boolean(place.gitRefs)} stackPlacement>
                {#snippet projectControl()}
                  <ProjectPicker
                    projects={overview.projectChoices}
                    value={project.id}
                    onselect={pickProject}
                    class="w-full max-w-full"
                  />
                {/snippet}
                {#snippet computerControl()}
                  <div class="flex min-w-0 items-center">
                    <WorkerPicker
                      {project}
                      value={workspace?.id}
                      onselect={pickWorkspace}
                      warning={workerNote}
                      class="min-w-0 flex-1"
                    />
                    {#if workspaceNote && !place.gitRefs}<HintIcon
                        label="Workspace information"
                        text={workspaceNote}
                        warning={Boolean(place.error)}
                      />{/if}
                  </div>
                {/snippet}
                {#snippet workspaceControl()}
                  {#if place.gitRefs}
                    <WorkspacePicker
                      choice={place.choice}
                      worktrees={place.worktrees}
                      onopen={() => void place.refresh()}
                      onselect={(choice) => place.choose(choice)}
                      class="w-full max-w-full"
                      note={workspaceNote}
                      warning={Boolean(place.error)}
                    />
                  {/if}
                {/snippet}
                {#snippet branchControl()}
                  {#if place.gitRefs}
                    <RefPicker
                      refs={place.gitRefs}
                      branch={place.branch}
                      editable={place.choice.kind === "new"}
                      onselect={(ref) => place.chooseBase(ref.name)}
                      class="w-full max-w-full"
                    />
                  {/if}
                {/snippet}
                {#snippet permissionControl()}
                  <PermissionPicker value={permissionMode} onselect={(mode) => permissions.set(NEW_THREAD, mode)} />
                {/snippet}
              </ComposerContextRow>
            {/snippet}
          </ComposerBox>
        </form>
      {/if}
    </div>
    <ImportSuggestion />
  </div>
  <FileDropOverlay {intake} />
</div>
