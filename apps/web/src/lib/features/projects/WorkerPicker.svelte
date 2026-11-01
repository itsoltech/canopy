<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { workerStatus } from "#lib/features/overview/workers.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { baseName } from "./placement.ts";

  /**
   * The new-thread composer's worker pill: only the workers the project lives on (its workspaces), each
   * with its status and the project's directory there. An offline worker stays listed, marked. A worker
   * with several directories of the project shows the directory's name in the pill. The footer links to
   * the project's settings, where the workers are configured.
   */
  let { project, value, onselect, class: className }: { project: ui.Project; value: string | undefined; onselect: (workspace: ui.Workspace) => void; class?: ClassValue } = $props();
  const overview = useOverview();

  const selected = $derived(project.workspaces.find((w) => w.id === value));
  const nameOf = (ws: ui.Workspace) => overview.worker(ws.workerId)?.name ?? "Unknown worker";
  const online = (ws: ui.Workspace) => overview.worker(ws.workerId)?.online ?? false;
  const shared = (ws: ui.Workspace) => project.workspaces.filter((w) => w.workerId === ws.workerId).length > 1;
  const pillName = (ws: ui.Workspace) => (shared(ws) ? `${nameOf(ws)} · ${baseName(ws.rootPath)}` : nameOf(ws));
</script>

<SearchPicker
  label="Choose a worker"
  searchLabel="Search workers"
  placeholder="Search workers…"
  items={project.workspaces}
  key={(w) => w.id}
  text={(w) => `${nameOf(w)} ${w.rootPath}`}
  {value}
  {onselect}
  link={{ href: `/settings/projects/${project.id}`, label: project.workspaces.length === 0 ? "Add it to a worker" : "Configure workers" }}
>
  {#snippet trigger(props)}
    <PillButton
      {...props}
      class={["pl-1.5", className]}
      aria-label={selected ? `Worker: ${pillName(selected)}, ${online(selected) ? "online" : "offline"}` : "Worker: none"}
    >
      <Icon name="computer-desktop" class="size-3.5" />
      {#if selected}
        <span class="truncate text-zinc-800 dark:text-zinc-200">{pillName(selected)}</span>
        {#if !online(selected)}<StatusDot tone="neutral" /><span class="shrink-0">Offline</span>{/if}
      {:else}
        <span class="truncate">{project.workspaces.length === 0 ? "No worker" : "Choose a worker"}</span>
      {/if}
    </PillButton>
  {/snippet}
  {#snippet option(ws, state)}
    <PickerRow title={nameOf(ws)} detail={ws.rootPath} detailClass="font-mono" status={workerStatus(overview.worker(ws.workerId))} selected={state.selected}>
      {#snippet leading()}<StatusDot tone={online(ws) ? "emerald" : "neutral"} />{/snippet}
    </PickerRow>
  {/snippet}
  {#snippet empty(query)}
    {#if query}No workers match “{query}”.{:else}{project.name} is not on any worker yet.{/if}
  {/snippet}
</SearchPicker>
