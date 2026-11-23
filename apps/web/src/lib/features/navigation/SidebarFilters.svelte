<script lang="ts">
  import type { ProjectChoice } from "@canopy/domain/projects";
  import { splitId } from "@canopy/domain/computers";
  import { workerChoices } from "@canopy/domain/worker-choices";
  import { workerPresence } from "#lib/features/computers/computers.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { iconButtonClasses } from "#lib/shared/ui/button.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import SidebarProjectChoice from "./SidebarProjectChoice.svelte";

  let { allowWorkers, workerIds }: { allowWorkers: boolean; workerIds: readonly string[] } = $props();

  const overview = useOverview();
  const settings = useSettings();
  const label = $derived(allowWorkers ? "Filter threads" : "Filter by project");

  const scopes = [
    { value: "projects", label: "Projects" },
    { value: "workers", label: "Workers" },
  ];

  let scope = $state("projects");
  let search = $state("");
  const q = $derived(search.trim().toLowerCase());
  const selectedProjects = $derived(settings.sidebar.projectIds);
  const byProject = $derived(!allowWorkers || scope === "projects");
  const searchLabel = $derived(byProject ? "Search projects" : "Search workers");
  const all = $derived((byProject ? selectedProjects : workerIds).length === 0);

  const projects = $derived(
    overview.projectChoices.filter((p) => [p.name, ...p.aliases].some((name) => name.toLowerCase().includes(q))),
  );

  const workers = $derived(
    workerChoices(overview.workers, (worker) => ({
      ...workerPresence(worker, overview.computer(worker.nodeId)),
      computer: overview.machine(worker.nodeId) ?? "",
    })),
  );

  const visibleWorkers = $derived(
    workers.filter(({ worker, computer }) =>
      [worker.name, worker.hostname, computer].some((value) => value.toLowerCase().includes(q)),
    ),
  );

  const projectCount = $derived(
    overview.projectChoices.filter((p) => p.projectIds.some((id) => selectedProjects.includes(id))).length,
  );

  const count = $derived(projectCount + workerIds.length);
  const active = $derived(selectedProjects.length > 0 || workerIds.length > 0);

  const selection = $derived(
    allowWorkers ? `${count} selected` : `${count} ${count === 1 ? "project" : "projects"} selected`,
  );

  const triggerLabel = $derived(active ? `${label} (${selection})` : label);

  function changeScope(next: string) {
    if (scope === next) return;
    scope = next;
    search = "";
  }

  const chooseProject = (project: ProjectChoice, checked: boolean) =>
    settings.updateSidebar({
      projectIds: checked
        ? [...new Set([...selectedProjects, ...project.projectIds])]
        : selectedProjects.filter((id) => !project.projectIds.includes(id)),
    });

  const chooseWorker = (id: string, checked: boolean) =>
    devicePreferences.setView({
      workerIds: checked ? [...workerIds, id] : workerIds.filter((workerId) => workerId !== id),
    });
</script>

<Popover {label} sheet placement="bottom-end" class="w-72 max-w-[calc(100vw-1rem)] p-1.5">
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      aria-label={triggerLabel}
      class={[iconButtonClasses("ghost", "md"), active && "bg-brand-500/10"]}
      {@attach tooltip(triggerLabel)}
    >
      <Icon name="funnel" />
      {#if active}<span
          aria-hidden="true"
          class="pointer-events-none absolute top-0 right-0 grid h-3 min-w-3 place-items-center rounded-full bg-action px-0.5 text-[0.5625rem]/none font-semibold text-on-accent tabular-nums"
          >{count > 99 ? "99+" : count}</span
        >{/if}
      <TouchTarget />
    </button>
  {/snippet}
  <div class="sidebar-scale grid gap-1">
    {#if allowWorkers}<SegmentedChoice label="Filter by" options={scopes} bind:value={() => scope, changeScope} />{/if}
    <SearchField
      name="filter-search"
      label={searchLabel}
      placeholder={searchLabel}
      bind:value={search}
      class="mb-0.5"
      data-autofocus
    />
    <Button
      variant="ghost"
      icon={byProject ? "folder" : "computer-desktop"}
      aria-pressed={all}
      onclick={() =>
        byProject ? settings.updateSidebar({ projectIds: [] }) : devicePreferences.setView({ workerIds: [] })}
      class="justify-start px-2"
    >
      <span class="min-w-0 flex-1 text-left">{byProject ? "All projects" : "All workers"}</span>
      {#if all}<Icon name="check" />{/if}
    </Button>
    {#if byProject}
      <div class="max-h-72 overflow-y-auto" role="group" aria-label="Projects">
        {#each projects as project (project.id)}
          <SidebarProjectChoice
            {project}
            checked={project.projectIds.some((id) => selectedProjects.includes(id))}
            onchoose={(checked) => chooseProject(project, checked)}
          />
        {:else}{@render empty("No projects found.")}{/each}
      </div>
    {:else}
      <div class="max-h-72 overflow-y-auto" role="group" aria-label="Workers">
        {#each visibleWorkers as { worker, computer, duplicate } (worker.id)}
          {@const detail = duplicate
            ? [computer || worker.hostname, splitId(worker.id).id.slice(-8)].filter(Boolean).join(" · ")
            : undefined}
          <Checkbox
            name="worker-{worker.id}"
            label={worker.name}
            description={detail}
            bind:checked={() => workerIds.includes(worker.id), (checked) => chooseWorker(worker.id, checked)}
            class="min-w-0 rounded-lg px-2 py-1.5 [&_p]:wrap-anywhere"
          />
        {:else}{@render empty("No workers found.")}{/each}
      </div>
    {/if}
  </div>
</Popover>

{#snippet empty(message: string)}
  <p class="px-2 py-2 text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">{message}</p>
{/snippet}
