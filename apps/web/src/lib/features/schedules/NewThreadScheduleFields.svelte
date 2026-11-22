<script lang="ts">
  import { Provider, PermissionMode, type SandboxProfile, ui } from "@canopy/contracts";
  import { scheduleWorkerEligible } from "@canopy/domain";
  import { scheduledFullAccessDescription, scheduledFullAccessUnavailable } from "@canopy/domain/schedule-display";
  import { create } from "@bufbuild/protobuf";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { modelOption, modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { supportedServiceTier } from "#lib/features/models/service-tier.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import PermissionPicker from "#lib/features/threads/components/PermissionPicker.svelte";
  import SandboxProfileMenu from "#lib/features/threads/components/SandboxProfileMenu.svelte";
  import {
    availablePermissionMode,
    fullAutoAvailable,
    permissionKey,
    type PermissionModeKey,
  } from "#lib/features/threads/labels.ts";
  import {
    defaultSandboxProfile,
    linkedSandboxSelection,
    sandboxProfileOption,
  } from "#lib/features/threads/sandbox-profiles.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import { scheduleSandboxProblem, workerSandboxProblem } from "./schedule-sandbox.ts";
  import { placementLabels } from "./schedules.ts";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";
  import { splitId } from "@canopy/domain/computers";

  let {
    value = $bindable(),
    sandboxError = $bindable(),
    savedSandboxProfile,
    templateSandboxProfile,
    homeId,
    class: className,
  }: {
    value?: ui.NewThreadSchedule | undefined;
    sandboxError?: string | undefined;
    savedSandboxProfile?: SandboxProfile | undefined;
    templateSandboxProfile?: SandboxProfile | undefined;
    homeId?: string;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();
  const settings = useSettings();
  const catalog = useModelCatalog();
  const records = workerRecords(overview);
  const home = $derived(homeId === undefined ? undefined : (splitId(homeId).node ?? ""));
  const projects = $derived(overview.projectChoices);
  const initial = untrack(() => value);
  let projectId = $state(initial?.projectId ?? overview.projectChoices[0]?.id ?? "");

  let placement = $state(
    initial?.placement || untrack(() => (overview.project(projectId)?.kind === "scratch" ? "specific" : "any")),
  );

  let workspaceId = $state(initial?.workspaceId ?? "");

  const initialWorker = untrack(() => {
    const candidates = overview.workers.filter((w) =>
      overview
        .project(projectId)
        ?.workspaces.some((ws) => ws.workerId === w.id && (placement !== "specific" || ws.id === workspaceId)),
    );

    return candidates.find((w) => initial && scheduleWorkerEligible(w, initial, false)) ?? candidates[0];
  });

  const initialProfile = initial?.providerProfileId === "native" ? "" : initial?.providerProfileId || "";

  let option = $state<ModelOption | undefined>(
    initial
      ? modelOption(
          initial.provider === Provider.CLAUDE ? "CLAUDE" : initial.provider === Provider.GROK ? "GROK" : "CODEX",
          initialProfile,
          initialWorker?.providerInstances.find(
            (i) => i.harness === initial.provider && i.id === (initialProfile || "native"),
          )?.label ||
            initialProfile ||
            "Native",
          initial.model,
          initialWorker ? catalog.of(initialWorker.id) : undefined,
        )
      : undefined,
  );

  let effort = $state<string | undefined>(initial?.effort || undefined);
  let serviceTier = $state<string | undefined>(initial?.serviceTier || undefined);

  let permission = $state<PermissionModeKey>(initial ? permissionKey(initial.permissionMode) : "ASK");
  let pickedSandboxId = $state(initial?.sandboxProfileId ?? initial?.sandboxProfile?.profile?.id ?? "");
  let pickedSandboxName = $state(initial?.sandboxProfile?.profile?.name ?? "Saved profile");

  let title = $state(initial?.title ?? "");
  const project = $derived(overview.projectChoice(projectId));

  const workspaces = $derived(
    (project?.workspaces ?? []).filter((ws) => home === undefined || (splitId(ws.workerId).node ?? "") === home),
  );

  const workers = $derived(
    overview.workers.filter(
      (w) =>
        (placement === "specific" || !w.nodeId) &&
        workspaces.some((ws) => ws.workerId === w.id && (placement !== "specific" || ws.id === workspaceId)),
    ),
  );

  const options = $derived([
    ...new Map(
      workers
        .flatMap((worker) =>
          modelOptions({ worker, catalog: catalog.of(worker.id), threads: overview.threads.values() }),
        )
        .map((o) => [o.key, o]),
    ).values(),
  ]);

  const modelWorker = $derived(
    workers.find((w) =>
      w.providerInstances.some(
        (i) =>
          i.harness === (option ? Provider[option.provider] : Provider.UNSPECIFIED) &&
          i.id === (option?.profileId || "native") &&
          i.enabled &&
          i.available,
      ),
    ),
  );

  const fullAuto = $derived(
    fullAutoAvailable(option && Provider[option.provider], placement === "specific" ? workers[0]?.os : undefined),
  );

  // Keep a named profile visible when a placement change makes it unavailable.
  const effectivePermission = $derived(pickedSandboxId ? permission : availablePermissionMode(permission, fullAuto));
  const activeSandboxId = $derived(effectivePermission === "FULL_AUTO" ? pickedSandboxId : "");

  const spec = $derived(
    create(ui.NewThreadScheduleSchema, {
      projectId:
        placement === "specific" ? (workspaces.find((ws) => ws.id === workspaceId)?.projectId ?? projectId) : projectId,
      placement,
      workspaceId: placement === "specific" ? workspaceId : "",
      provider: option ? Provider[option.provider] : Provider.UNSPECIFIED,
      providerProfileId: option?.profileId ?? "",
      model: option?.model ?? "",
      effort: option?.efforts.length ? (effort ?? "") : "",
      serviceTier: supportedServiceTier(option, serviceTier),
      permissionMode: PermissionMode[effectivePermission],
      sandboxProfileId: activeSandboxId || (savedSandboxProfile ? "" : undefined),
      title,
      workspaceMode: initial?.workspaceMode,
      baseRef: initial?.baseRef,
      parentThreadId: initial?.parentThreadId,
    }),
  );

  const preservesSandbox = $derived(Boolean(savedSandboxProfile && activeSandboxId === savedSandboxProfile.id));
  const linkedWorker = $derived(placement === "specific" && Boolean(workers[0]?.nodeId));

  const profiles = $derived([
    ...(savedSandboxProfile ? [savedSandboxProfile] : []),
    ...settings.sandboxProfiles.filter((profile) => profile.id !== savedSandboxProfile?.id),
  ]);

  const sandboxOptions = $derived([
    defaultSandboxProfile,
    ...profiles.map((profile) =>
      sandboxProfileOption(
        profile,
        linkedWorker && profile.id !== savedSandboxProfile?.id
          ? linkedSandboxSelection
          : scheduleSandboxProblem(workers, spec, profile),
      ),
    ),
    ...(activeSandboxId && !profiles.some((profile) => profile.id === activeSandboxId)
      ? [
          {
            value: activeSandboxId,
            label: templateSandboxProfile?.id === activeSandboxId ? templateSandboxProfile.name : pickedSandboxName,
            description: "This profile is no longer in Settings.",
            disabled: true,
          },
        ]
      : []),
  ]);

  const selectedSandboxOption = $derived(sandboxOptions.find((entry) => entry.value === activeSandboxId));
  const sandboxProblem = $derived(selectedSandboxOption?.disabled ? selectedSandboxOption.description : undefined);
  const selectedProfile = $derived(profiles.find((profile) => profile.id === activeSandboxId));

  const eligible = $derived(
    workers.filter(
      (worker) =>
        scheduleWorkerEligible(worker, spec) &&
        (!activeSandboxId ||
          (!sandboxProblem && selectedProfile && !workerSandboxProblem(worker, spec, selectedProfile))),
    ),
  );

  function pickPermission(mode: PermissionModeKey) {
    permission = mode;

    if (mode !== "FULL_AUTO") pickedSandboxId = "";
  }

  function pickSandboxProfile(id: string) {
    pickedSandboxId = id;
    pickedSandboxName = sandboxOptions.find((entry) => entry.value === id)?.label ?? "Saved profile";
  }

  $effect(() => {
    if (!workspaces.some((w) => w.id === workspaceId)) workspaceId = workspaces[0]?.id ?? "";

    if (project?.kind === "scratch" || (workspaces.length && workspaces.every((ws) => !!splitId(ws.workerId).node)))
      placement = "specific";
  });

  $effect(() => {
    // Keep custom model ids while their instance is still offered in this placement.
    const keepingInitial =
      initial &&
      projectId === initial.projectId &&
      placement === initial.placement &&
      (placement !== "specific" || workspaceId === initial.workspaceId) &&
      option?.profileId === initialProfile;

    if (
      !option ||
      (!keepingInitial && !options.some((o) => o.provider === option?.provider && o.profileId === option?.profileId))
    ) {
      option = options[0];
      effort = undefined;
      serviceTier = undefined;
    }
  });

  $effect(() => {
    value = spec;
    sandboxError =
      sandboxProblem && !preservesSandbox ? `${sandboxProblem} Choose another profile or worker.` : undefined;
  });
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <div class="grid gap-4 sm:grid-cols-2">
    <Field label="Project" class="min-w-0">
      <Select
        name="projectId"
        bind:value={projectId}
        options={projects.length
          ? projects.map((project) => ({
              value: project.id,
              label: project.name,
              disabled: Boolean(overview.projectAway(project)),
              description: overview.projectAway(project),
            }))
          : [{ value: "", label: "No projects yet" }]}
      />
    </Field>
    {#if project?.kind !== "scratch"}<Field label="Placement">
        <Select
          name="placement"
          bind:value={placement}
          options={[...placementLabels]
            .filter(([value]) => !home || value === "specific")
            .map(([value, label]) => ({ value, label }))}
        />
      </Field>{/if}
    {#if placement === "specific"}
      <Field label="Worker" class="min-w-0 sm:col-span-2">
        <Select
          name="workspaceId"
          bind:value={workspaceId}
          options={workspaces.length
            ? records
                .options(
                  overview.workers.filter((w) => workspaces.some((ws) => ws.workerId === w.id)),
                  true,
                )
                .map((option) => ({ ...option, value: workspaces.find((ws) => ws.workerId === option.value)!.id }))
            : [{ value: "", label: "No workers have this project" }]}
        />
      </Field>
    {/if}
  </div>
  {#if project?.kind === "scratch"}<p class="text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
      Each run gets its own scratch directory on this worker. Files are kept until you remove them manually.
    </p>{/if}
  <fieldset class="grid min-w-0 gap-2">
    <legend class="mb-2 text-base/6 font-medium sm:text-sm/6">Agent and permissions</legend>
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <ModelControls {options} bind:option bind:effort bind:serviceTier showSpeed workerId={modelWorker?.id} />
      <PermissionPicker
        value={effectivePermission}
        {fullAuto}
        fullAccessDescription={scheduledFullAccessDescription}
        sandboxProfileName={activeSandboxId ? selectedSandboxOption?.label : undefined}
        onselect={pickPermission}
      >
        {#snippet sandboxProfiles()}
          <SandboxProfileMenu options={sandboxOptions} value={activeSandboxId} onselect={pickSandboxProfile} />
        {/snippet}
      </PermissionPicker>
    </div>
    {#if option}<p class="text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
        {option.provider === "CLAUDE" ? "Claude" : option.provider === "GROK" ? "Grok" : "Codex"} · {option.profileName}
      </p>{/if}
    <p aria-live="polite" class="text-base/6 text-pretty text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
      {#if sandboxProblem}
        {#if preservesSandbox}{sandboxProblem} The task keeps its saved profile.
        {:else}{sandboxError}{/if}
      {:else if eligible.length}Eligible now: {eligible.map((w) => w.name).join(", ")}.
      {:else if effectivePermission === "FULL_ACCESS" && workers.length && !workers.some((w) => w.fullAccess)}
        {scheduledFullAccessUnavailable}
      {:else if placement === "specific"}No eligible worker online. The thread will wait for this worker.
      {:else}No eligible workers online. The task waits for availability, then follows your missed-run choice.{/if}
    </p>
  </fieldset>
  <Field label="Thread title (optional)" description="Leave blank to generate a title from the first message.">
    <Input name="threadTitle" bind:value={title} maxlength={200} />
  </Field>
</div>
