<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { workerLabel } from "#lib/features/overview/worker-label.ts";
  import { workerPresence } from "#lib/features/computers/computers.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  /** Worker's computer and workspace determine the thread's single home. */
  let {
    project,
    value,
    onselect,
    class: className,
    warning,
  }: {
    project: ui.Project;
    value: string | undefined;
    onselect: (workspace: ui.Workspace) => void;
    class?: ClassValue;
    warning?: string | undefined;
  } = $props();

  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const computerOf = (worker: ui.Worker) => overview.machine(worker.nodeId) ?? "This computer";
  const presence = (worker: ui.Worker) => workerPresence(worker, overview.computer(worker.nodeId));
  const away = (worker: ui.Worker) => presence(worker).reason;
  const online = (worker: ui.Worker) => presence(worker).online;
  const status = (worker: ui.Worker) => presence(worker).status;

  const available = $derived(
    overview.workers
      .filter((worker) => !worker.nodeId || capabilities?.linkedComputers)
      .map((worker) => ({
        worker,
        workspace:
          project.workspaces.find((ws) => ws.workerId === worker.id && ws.id === value) ??
          project.workspaces.find((ws) => ws.workerId === worker.id),
      }))
      .filter((choice) => project.kind === "scratch" || choice.workspace)
      .sort(
        (a, b) =>
          Number(Boolean(a.worker.nodeId)) - Number(Boolean(b.worker.nodeId)) ||
          computerOf(a.worker).localeCompare(computerOf(b.worker)) ||
          a.worker.name.localeCompare(b.worker.name),
      ),
  );

  const selected = $derived(available.find((choice) => choice.workspace?.id === value));

  const reason = $derived(
    warning ??
      (selected &&
        (away(selected.worker) ??
          (!selected.worker.online
            ? `${selected.worker.name} is offline. Start it or choose another worker to send.`
            : undefined))),
  );
</script>

<div class={["flex min-w-0 items-center", className]}>
  <SearchPicker
    label="Choose a worker"
    searchLabel="Search workers"
    placeholder="Search workers…"
    items={available}
    key={(choice) => choice.worker.id}
    text={(choice) => `${choice.worker.name} ${computerOf(choice.worker)}`}
    groupOf={(choice) => computerOf(choice.worker)}
    disabled={(choice) => !choice.workspace}
    value={selected?.worker.id}
    onselect={(choice) => choice.workspace && onselect(choice.workspace)}
    link={{ href: "/settings/workers", label: "Manage workers" }}
  >
    {#snippet trigger(props)}
      <PillButton
        {...props}
        class="min-w-0 flex-1 pl-1.5"
        aria-label={selected
          ? `Worker: ${selected.worker.name}, ${computerOf(selected.worker)}, ${status(selected.worker)}`
          : "Worker: none"}
      >
        <Icon name="computer-desktop" class="size-3.5" />
        {#if selected}
          <span class="flex min-w-0 flex-1 items-center gap-1 text-zinc-800 dark:text-zinc-200">
            <span class="min-w-0 flex-1 truncate">{workerLabel(selected.worker.name)}</span>
            <span class="shrink-0" aria-hidden="true">·</span>
            <span class="min-w-0 flex-1 truncate">{computerOf(selected.worker)}</span>
          </span>
          {#if !online(selected.worker)}<StatusDot tone="neutral" /><span class="shrink-0 @max-[34rem]/context:sr-only"
              >{status(selected.worker)}</span
            >{/if}
        {:else}
          <span class="truncate">{available.length === 0 ? "No worker" : "Choose a worker"}</span>
        {/if}
      </PillButton>
    {/snippet}
    {#snippet option(choice, state)}
      <PickerRow
        title={choice.worker.name}
        detail={!choice.workspace ? "No scratch directory. Configure this worker." : away(choice.worker)}
        status={status(choice.worker)}
        selected={state.selected}
      >
        {#snippet leading()}<StatusDot tone={online(choice.worker) ? "emerald" : "neutral"} />{/snippet}
      </PickerRow>
    {/snippet}
    {#snippet empty(query)}
      {#if query}No workers match “{query}”.{:else if project.kind === "scratch"}Connect a worker first.{:else}{project.name}
        is not on any worker yet. Add it in project settings.{/if}
    {/snippet}
  </SearchPicker>
  {#if reason}<HintIcon label="Worker needs attention" text={reason} warning />{/if}
</div>
