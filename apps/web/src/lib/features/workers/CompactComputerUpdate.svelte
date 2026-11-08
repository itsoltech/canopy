<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import { computerUpdate } from "./computer-updates.ts";
  import { presenceTime } from "#lib/features/computers/computers.ts";
  import { updateTone, type UpdatesState } from "./updates.svelte.ts";
  import { updateCheckLabel } from "@canopy/domain/computer-presence";

  let {
    computer,
    updates,
    local = false,
    class: className,
  }: { computer: ui.ComputerUpdate; updates: UpdatesState; local?: boolean; class?: ClassValue } = $props();

  const view = $derived(computerUpdate(computer, presenceTime));
  const app = $derived(computer.updates?.app);
</script>

<!-- A linked computer's Canopy app: its own gateway and worker update with it (docs/updates.md). -->
<UpdateItem
  name={computer.name}
  icon={local ? "computer-desktop" : "link"}
  current={app?.version || computer.version}
  target={view.target}
  metadata={updateCheckLabel(app?.lastCheckedAtMs, presenceTime)}
  status={view.status}
  tone={updateTone(view)}
  detail={view.detail}
  error={view.failed ? view.detail : ""}
  busy={view.busy}
  progress={view.progress}
  class={className}
>
  {#snippet action()}
    {#if view.actionable && !local}
      <IconButton
        icon="arrow-up"
        size="sm"
        label={`Update Canopy on ${computer.name}`}
        disabled={!!updates.pending || updates.snapshot?.run?.state === "running"}
        loading={updates.pending === computer.nodeId}
        onclick={() => void updates.manage({ action: "computer", nodeId: computer.nodeId })}
      />
    {:else if (view.detail || local) && !view.failed && !computer.reason}<IconButton
        icon="information-circle"
        size="sm"
        label={local ? "Includes this computer’s gateway and worker. Update this app on its computer." : view.detail}
        tooltipOptions={{ touch: "tap" }}
      />{/if}
  {/snippet}
  {#if computer.reason && computer.readState && computer.readState !== "fresh"}
    <p class="mt-1 text-xs/5 wrap-anywhere text-muted" role="status">{computer.reason}</p>
  {/if}
</UpdateItem>
