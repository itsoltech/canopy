<script lang="ts">
  import { Provider, PermissionMode, ui } from "@open-agents/contracts";
  import { scheduleWorkerEligible } from "@open-agents/domain";
  import { create } from "@bufbuild/protobuf";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { modelOption, modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import PermissionPicker from "#lib/features/threads/components/PermissionPicker.svelte";
  import type { PermissionModeKey } from "#lib/features/threads/labels.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import { placementLabels } from "./schedules.ts";

  let { value = $bindable(), class: className }: { value?: ui.NewThreadSchedule | undefined; class?: ClassValue } = $props();
  const overview = useOverview();
  const catalog = useModelCatalog();
  const initial = untrack(() => value);
  let projectId = $state(initial?.projectId ?? overview.projects[0]?.id ?? "");
  let placement = $state(initial?.placement || untrack(() => overview.project(projectId)?.kind === "scratch" ? "specific" : "any"));
  let workspaceId = $state(initial?.workspaceId ?? "");
  const initialWorker = untrack(() => {
    const candidates = overview.workers.filter((w) => overview.project(projectId)?.workspaces.some((ws) => ws.workerId === w.id && (placement !== "specific" || ws.id === workspaceId)));
    return candidates.find((w) => initial && scheduleWorkerEligible(w, initial, false)) ?? candidates[0];
  });
  const initialProfile = initial?.providerProfileId === "native" ? "" : initial?.providerProfileId || "";
  let option = $state<ModelOption | undefined>(initial ? modelOption(initial.provider === Provider.CLAUDE ? "CLAUDE" : "CODEX", initialProfile,
    initialWorker?.providerInstances.find((i) => i.harness === initial.provider && i.id === (initialProfile || "native"))?.label || initialProfile || "Native", initial.model, initialWorker ? catalog.of(initialWorker.id) : undefined) : undefined);
  let effort = $state<string | undefined>(initial?.effort || undefined);
  let permission = $state<PermissionModeKey>(initial ? PermissionMode[initial.permissionMode] as PermissionModeKey : "ASK");
  let title = $state(initial?.title ?? "");
  const project = $derived(overview.project(projectId));
  const workspaces = $derived(project?.workspaces ?? []);
  const workers = $derived(overview.workers.filter((w) => workspaces.some((ws) => ws.workerId === w.id && (placement !== "specific" || ws.id === workspaceId))));
  const options = $derived([...new Map(workers.flatMap((worker) =>
    modelOptions({ worker, catalog: catalog.of(worker.id), threads: overview.threads.values() }),
  ).map((o) => [o.key, o])).values()]);
  const modelWorker = $derived(workers.find((w) => w.providerInstances.some((i) => i.harness === (option ? Provider[option.provider] : Provider.UNSPECIFIED) && i.id === (option?.profileId || "native") && i.enabled && i.available)));
  const eligible = $derived(value ? workers.filter((w) => scheduleWorkerEligible(w, value!)) : []);
  $effect(() => {
    if (!workspaces.some((w) => w.id === workspaceId)) workspaceId = workspaces[0]?.id ?? "";
    if (project?.kind === "scratch") placement = "specific";
  });
  $effect(() => {
    // Keep custom model ids while their instance is still offered in this placement.
    const keepingInitial = initial && projectId === initial.projectId && placement === initial.placement &&
      (placement !== "specific" || workspaceId === initial.workspaceId) && option?.profileId === initialProfile;
    if (!option || (!keepingInitial && !options.some((o) => o.provider === option?.provider && o.profileId === option?.profileId))) {
      option = options[0];
      effort = undefined;
    }
  });
  $effect(() => {
    value = create(ui.NewThreadScheduleSchema, { projectId, placement, workspaceId: placement === "specific" ? workspaceId : "",
      provider: option ? Provider[option.provider] : Provider.UNSPECIFIED, providerProfileId: option?.profileId ?? "",
      model: option?.model ?? "", effort: option?.efforts.length ? effort ?? "" : "", permissionMode: PermissionMode[permission], title });
  });
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <div class="grid gap-4 sm:grid-cols-2">
    <Field label="Project">
      <Select name="projectId" bind:value={projectId} options={overview.projects.length ? overview.projects.map((project) => ({ value: project.id, label: project.name })) : [{ value: "", label: "No projects yet" }]} />
    </Field>
    {#if project?.kind !== "scratch"}<Field label="Placement">
      <Select name="placement" bind:value={placement} options={Object.entries(placementLabels).map(([value, label]) => ({ value, label }))} />
    </Field>{/if}
    {#if placement === "specific"}
      <Field label="Worker" class="sm:col-span-2">
        <Select name="workspaceId" bind:value={workspaceId} options={workspaces.length ? workspaces.map((workspace) => ({ value: workspace.id,
          label: `${overview.worker(workspace.workerId)?.name ?? "Unknown worker"}${overview.worker(workspace.workerId)?.online ? "" : " · Offline"}`,
        })) : [{ value: "", label: "No workers have this project" }]} />
      </Field>
    {/if}
  </div>
  {#if project?.kind === "scratch"}<p class="text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">Each run gets its own scratch directory on this worker. Files are kept until you remove them manually.</p>{/if}
  <fieldset class="grid min-w-0 gap-2">
    <legend class="mb-2 text-base/6 font-medium sm:text-sm/6">Agent and permissions</legend>
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <ModelControls {options} bind:option bind:effort workerId={modelWorker?.id} />
      <PermissionPicker value={permission} onselect={(next) => (permission = next)} />
    </div>
    {#if option}<p class="text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">{option.provider === "CLAUDE" ? "Claude" : "Codex"} · {option.profileName}</p>{/if}
    <p aria-live="polite" class="text-base/6 text-pretty text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
      {#if eligible.length}Eligible now: {eligible.map((w) => w.name).join(", ")}.
      {:else if placement === "specific"}No eligible worker online. The thread will wait for this worker.
      {:else}No eligible workers online. The task waits for availability, then follows your missed-run choice.{/if}
    </p>
  </fieldset>
  <Field label="Thread title (optional)" description="Leave blank to generate a title from the first message.">
    <Input name="threadTitle" bind:value={title} maxlength={200} placeholder="Generate automatically" />
  </Field>
</div>
