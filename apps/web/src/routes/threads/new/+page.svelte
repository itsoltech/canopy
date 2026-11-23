<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { enhance } from "$app/forms";
  import { onNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { Provider, PermissionMode, ui } from "@canopy/contracts";
  import { create, toJsonString } from "@bufbuild/protobuf";
  import { untrack } from "svelte";
  import { webDrafts } from "#lib/features/drafts/local.svelte.ts";
  import DraftPersistence from "#lib/features/drafts/DraftPersistence.svelte";
  import DraftActions from "#lib/features/drafts/DraftActions.svelte";
  import PendingDraft from "#lib/features/drafts/PendingDraft.svelte";
  import DraftMoveNotice from "#lib/features/drafts/DraftMoveNotice.svelte";
  import { startingPath, threadCreations } from "#lib/features/threads/thread-creation.svelte.ts";
  import type { ProjectChoice } from "@canopy/domain/projects";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { effectiveDefaults } from "#lib/features/settings/thread-defaults.ts";
  import { defaultProject, defaultWorkspace } from "#lib/features/projects/placement.ts";
  import ProjectPicker from "#lib/features/projects/ProjectPicker.svelte";
  import WorkerPicker from "#lib/features/projects/WorkerPicker.svelte";
  import ComposerBox from "#lib/features/threads/components/ComposerBox.svelte";
  import { FileIntake, provideFileIntake } from "#lib/features/attachments/file-intake.svelte.ts";
  import FileDropOverlay from "#lib/features/attachments/FileDropOverlay.svelte";
  import { limitsOf } from "#lib/features/attachments/draft.svelte.ts";
  import { MentionSources } from "#lib/features/mentions/sources.svelte.ts";
  import { modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import { supportedServiceTier } from "#lib/features/models/service-tier.ts";
  import { newThreadModel } from "#lib/features/models/new-thread-model.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import FirstSendNotice from "#lib/features/onboarding/FirstSendNotice.svelte";
  import { setupAgentModels } from "#lib/features/onboarding/setup-agent.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import PermissionPicker from "#lib/features/threads/components/PermissionPicker.svelte";
  import SandboxProfileMenu from "#lib/features/threads/components/SandboxProfileMenu.svelte";
  import { newThreadSandboxPicker } from "#lib/features/threads/new-thread-sandbox.ts";
  import { sandboxShellUnavailable } from "#lib/features/threads/sandbox-profiles.ts";
  import { availablePermissionMode, fullAutoAvailable, permissionKey } from "#lib/features/threads/labels.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import CenteredContent from "#lib/shared/ui/CenteredContent.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";
  import RefPicker from "#lib/features/worktrees/RefPicker.svelte";
  import WorkspacePicker from "#lib/features/worktrees/WorkspacePicker.svelte";
  import WorkspaceBranch from "#lib/features/worktrees/WorkspaceBranch.svelte";
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
  const capabilities = useGatewayCapabilities();
  const settings = useSettings();

  // Sidebar links can select the project alone or an exact checkout.
  const requested = $derived(page.url.searchParams.get("project") ?? "");
  let picks = $state<{ projectId?: string; workspaceId?: string }>();
  const linkedWorktree = $derived(picks ? null : page.url.searchParams.get("worktree"));

  const project = $derived(
    overview.projectChoice(picks?.projectId ?? "") ??
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

    const requestedWorkspace = picks?.workspaceId ?? page.url.searchParams.get("workspace");
    const pick = project.workspaces.find((w) => w.id === requestedWorkspace);

    if (linkedWorktree !== null) return pick;

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
      ? {
          workspaceId: workspace.id,
          ready: Boolean(worker?.online && worker.worktrees),
          worktreeId: linkedWorktree,
        }
      : undefined,
  );

  onNavigate(({ from, to, type }) => {
    if (to?.route.id === "/threads/new" && (type === "link" || from?.url.search !== to.url.search)) {
      picks = undefined;
      place.reset();
    }
  });

  let branchBusy = $state(false);

  const pickProject = (next: ProjectChoice) => {
    if (!branchBusy) picks = { projectId: next.id };
  };

  const pickWorkspace = (next: ui.Workspace) => {
    if (!branchBusy) picks = { projectId: project?.id, workspaceId: next.id };
  };

  // Model options (provider × profile × model) from the worker's catalog. Until you pick one: the defaults'
  // provider, profile and model (the profile's default model when the list lacks it), else the defaults'
  // provider, else the first option (also when your pick is not offered on this workspace's worker).
  const models = useModelCatalog();
  const workerId = $derived(workspace?.workerId ?? "");

  const options = $derived(
    modelOptions({ worker, catalog: models.of(workerId), threads: overview.threads.values(), defaults }),
  );

  const saved = $derived(
    webDrafts.get(
      create(ui.ComposerDraftTargetSchema, {
        projectId: workspace?.projectId ?? project?.id ?? "",
        workspaceId: workspace?.id ?? "",
      }),
      () => limitsOf(settings.attachmentLimits),
    ),
  );

  const pendingRequestId = $derived(new URLSearchParams(saved.pendingForm).get("clientRequestId"));

  $effect(() => {
    const draft = saved;

    if (pendingRequestId && webDrafts.ready) untrack(() => threadCreations.resume(pendingRequestId, draft));
  });

  const picked = $derived(
    options.find(
      (o) =>
        o.model === saved.choices.model &&
        Provider[o.provider] === saved.choices.provider &&
        o.profileId === saved.choices.providerProfileId,
    ),
  );

  function pickModel(option: ModelOption | undefined) {
    if (option)
      saved.choices = {
        ...saved.choices,
        model: option.model,
        provider: Provider[option.provider],
        providerProfileId: option.profileId,
        effort: effort && option.efforts.some((e) => e.id === effort) ? effort : "",
        serviceTier: supportedServiceTier(option, serviceTier),
      };
  }

  const setupOptions = $derived(
    page.url.searchParams.get("setup") === "1" ? setupAgentModels(worker, models.of(workerId)) : [],
  );

  const initial = $derived(
    newThreadModel(setupOptions.length ? setupOptions : options, defaults, overview.agentChoiceThreads),
  );

  const selected = $derived(picked ?? initial.option);

  // Not picked and the profile's default: "" (the thread follows the profile's default model).
  const model = $derived(!selected || (!picked && !initial.remembered && selected.isDefault) ? "" : selected.model);
  const requestedEffort = $derived(saved.choices.effort ?? (!picked ? initial.effort : undefined));

  const effort = $derived(
    requestedEffort && selected?.efforts.some((e) => e.id === requestedEffort) ? requestedEffort : undefined,
  );

  const serviceTier = $derived(
    supportedServiceTier(selected, saved.choices.serviceTier ?? (!picked ? initial.serviceTier : undefined)),
  );

  // Only an effort the model takes (switching the workspace can change the model).
  const sentEffort = $derived(effort ?? "");

  // Your pick stays with the new-thread draft (leave and come back); unset = the defaults (Settings → Threads).
  const fullAuto = $derived(fullAutoAvailable(selected && Provider[selected.provider], worker?.os));
  const sandboxProfile = $derived(saved.choices.sandboxProfile);
  const sandboxProfileId = $derived(sandboxProfile?.id ?? "");
  const shellUnavailable = $derived(sandboxProfile ? sandboxShellUnavailable : undefined);

  const permissionMode = $derived(
    sandboxProfile
      ? "FULL_AUTO"
      : availablePermissionMode(permissionKey(saved.choices.permissionMode ?? defaults.permissionMode), fullAuto),
  );

  const sandboxPicker = $derived(
    newThreadSandboxPicker(sandboxProfile, settings.sandboxProfiles, settings.loaded, {
      worker,
      provider: selected && Provider[selected.provider],
      profileId: selected?.profileId ?? "",
    }),
  );

  const sandboxRefusal = $derived(sandboxPicker.refusal);

  function pickPermissions(mode: typeof permissionMode) {
    saved.selectSandboxPermissions(PermissionMode[mode], mode === "FULL_AUTO" ? sandboxProfile : undefined);
  }

  function pickSandboxProfile(id: string) {
    const profile = settings.sandboxProfiles.find((item) => item.id === id);

    if (id && !profile) return;
    saved.selectSandboxPermissions(PermissionMode.FULL_AUTO, profile);
  }

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
  const draft = $derived(saved.files);

  // Files pasted anywhere on the page (outside a text field) or dropped on it attach to the message.
  const intake = provideFileIntake(new FileIntake());
  let busy = $state(false);
  const clientRequestId = $derived(saved.requestId);

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

  const placementNote = $derived(
    linkedWorktree !== null && !workspace
      ? "This workspace is no longer in the project. Choose another computer."
      : place.linkedWorktreeUnavailable && worker?.online
        ? "This worktree is unavailable. Choose another workspace or start from the project header."
        : undefined,
  );

  const blockedReason = $derived(
    branchBusy
      ? "Switching branch…"
      : (placementNote ?? workerNote ?? (place.loading ? workspaceNote : undefined) ?? sandboxRefusal ?? draft.blocker),
  );
</script>

<DraftPersistence draft={saved} />

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

  <CenteredContent bottomClass="composer-bottom" class="max-w-(--chat-width)">
    <div class="mb-8 text-center">
      <h1 class="text-3xl font-medium tracking-tight text-balance text-zinc-950 dark:text-white">
        {project ? "What should we work on?" : "Create a project first"}
      </h1>
    </div>

    {#if !project}
      <div class="grid justify-items-center gap-4 text-center">
        <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Add a project directory on a worker to start a thread.
        </p>
        <ButtonLink href="/settings/projects" variant="primary">Open project settings</ButtonLink>
      </div>
    {:else}
      <form
        method="POST"
        action="?/createThread"
        class="grid gap-3"
        use:enhance={({ cancel, formData }) => {
          cancel();
          if (blockedReason || busy || saved.preparing || (shellUnavailable && saved.text.startsWith("!"))) return;
          busy = true;
          void threadCreations.start(saved, formData).catch(() => {
            busy = false;
          });
        }}
      >
        <input type="hidden" name="projectId" value={workspace?.projectId ?? project.id} />
        <input type="hidden" name="clientRequestId" value={clientRequestId} />
        <input
          type="hidden"
          name="composerContent"
          value={toJsonString(ui.ComposerDraftContentSchema, saved.outgoing())}
        />
        <input type="hidden" name="provider" value={selected?.provider ?? ""} />
        <input type="hidden" name="profileId" value={selected?.profileId ?? ""} />
        <input type="hidden" name="model" value={model} />
        <input type="hidden" name="effort" value={sentEffort} />
        <input type="hidden" name="serviceTier" value={serviceTier} />
        <input type="hidden" name="workspaceId" value={workspace?.id ?? ""} />
        <input type="hidden" name="permissionMode" value={permissionMode} />
        <input type="hidden" name="sandboxProfileId" value={sandboxProfileId} />
        <input type="hidden" name="workspaceMode" value={place.form.workspaceMode} />
        <input type="hidden" name="baseRef" value={place.form.baseRef} />
        <input type="hidden" name="worktreeId" value={place.form.worktreeId} />
        {#each draft.ids as id (id)}<input type="hidden" name="attachmentId" value={id} />{/each}
        {#if form?.error}<Alert tone="error">{form.error}</Alert>{/if}
        {#if placementNote}<Alert tone="warning">{placementNote}</Alert>{/if}
        {#if sandboxRefusal && !workerNote}<Alert tone="warning" title="Selected sandbox profile unavailable">
            {sandboxRefusal}
          </Alert>{/if}
        {#if devicePreferences.viewLoaded && !devicePreferences.view.onboardingSent && (capabilities?.offerOnboarding || page.url.searchParams.get("setup") === "1")}
          <FirstSendNotice />
        {/if}
        <ComposerBox
          shell
          {shellUnavailable}
          bind:value={saved.text}
          bind:mentions={saved.mentions}
          quoteKey={saved.quoteKey}
          {sources}
          sending={busy}
          readonly={busy || saved.locked}
          progressHref={saved.preparing && pendingRequestId ? startingPath(pendingRequestId) : undefined}
          canSend={!blocker && !placementNote && !sandboxRefusal && !draft.blocker && !branchBusy}
          {blockedReason}
          autofocus
          label="Task for the agent"
          {draft}
        >
          {#snippet drafts()}<DraftActions draft={saved} disabled={busy} />{/snippet}
          {#snippet controls()}
            {#if workspace && selected}
              <ModelControls
                adaptive
                {options}
                bind:option={() => selected, pickModel}
                bind:effort={() => effort, (next) => (saved.choices = { ...saved.choices, effort: next ?? "" })}
                bind:serviceTier={
                  () => serviceTier, (next) => (saved.choices = { ...saved.choices, serviceTier: next ?? "" })
                }
                showSpeed
                preferFavorites
                {workerId}
                class="flex-1 justify-end"
              />
            {/if}
          {/snippet}
          {#snippet meta()}
            <ComposerContextRow
              hasWorkspace={Boolean(place.gitRefs || (worker?.worktrees && project.kind !== "scratch"))}
              stackPlacement
            >
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
                    onselect={(choice) => {
                      if (!branchBusy) place.choose(choice);
                    }}
                    class="w-full max-w-full"
                    note={workspaceNote}
                    warning={Boolean(place.error)}
                  />
                {/if}
              {/snippet}
              {#snippet branchControl()}
                {#if place.gitRefs && place.choice.kind === "new"}
                  <RefPicker
                    refs={place.gitRefs}
                    branch={place.branch}
                    editable={place.choice.kind === "new"}
                    onselect={(ref) => place.chooseBase(ref.name)}
                    class="w-full max-w-full"
                  />
                {:else if place.gitRefs && workspace}
                  <WorkspaceBranch {place} {workspace} {worker} onbusy={(value) => (branchBusy = value)} />
                {/if}
              {/snippet}
              {#snippet permissionControl()}
                <PermissionPicker
                  value={permissionMode}
                  {fullAuto}
                  disabled={busy || saved.locked}
                  sandboxProfileName={sandboxProfile?.name}
                  onselect={pickPermissions}
                >
                  {#snippet sandboxProfiles()}
                    <SandboxProfileMenu
                      options={sandboxPicker.options}
                      value={sandboxPicker.value}
                      onselect={pickSandboxProfile}
                    />
                  {/snippet}
                </PermissionPicker>
              {/snippet}
            </ComposerContextRow>
          {/snippet}
        </ComposerBox>
        <PendingDraft draft={saved} />
        <DraftMoveNotice draft={saved} />
      </form>
    {/if}
  </CenteredContent>
  <ImportSuggestion />
  <FileDropOverlay {intake} />
</div>
