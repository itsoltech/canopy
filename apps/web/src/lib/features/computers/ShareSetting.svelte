<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { changedLine, computerName, localCopyNote } from "./computers.ts";
  import ConflictHint from "./ConflictHint.svelte";
  import ShareScope from "./ShareScope.svelte";
  import { useSharedConfig } from "./shared-config.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  /**
   * "Share with linked computers" for one item, as a settings row: the switch, where it applies, who changed it
   * last, what stays per computer (`local`), and an open question after offline edits. Hidden without linked computers.
   */
  let {
    itemKey,
    label,
    local,
    disabled = false,
    disabledReason,
    class: className,
  }: {
    itemKey: string;
    label: string;
    local?: string;
    disabled?: boolean;
    disabledReason?: string;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const shared = useSharedConfig();
  const item = $derived(shared.item(itemKey));
  const on = $derived(item?.shared ?? false);
  const conflicts = $derived(shared.conflicts(itemKey));
  const name = (nodeId: string) => overview.machine(nodeId);
  const outdated = $derived(shared.snapshot.needsUpdateNodeIds.map((id) => computerName(overview.computer(id))));
  let busy = $state(false);

  async function change(next: boolean) {
    busy = true;

    try {
      await shared.manage(next ? "share" : "unshare", itemKey);
      toast(next ? `${label} is shared with your linked computers` : `${label} is now separate on each computer`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not change sharing", { tone: "error" });
    } finally {
      busy = false;
    }
  }
</script>

{#if capabilities?.linkedComputers && overview.computers.size > 0}
  <div class={className}>
    <SettingsRow
      title={label}
      description={disabled && disabledReason
        ? disabledReason
        : on
          ? "Shared: changes reach every linked computer. Turning it off leaves each computer its own copy."
          : "Only on this computer. Turn it on to use the same everywhere."}
    >
      {#snippet control()}<Switch
          name="share-{itemKey}"
          label="Share {label} with linked computers"
          checked={on}
          disabled={busy || disabled}
          onchange={change}
        />{/snippet}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-sm/5 text-zinc-500 dark:text-zinc-400">
        <ShareScope {itemKey} />
        {#if on && item}<p>{changedLine(item, name)}</p>{/if}
      </div>
      <div class="grid gap-1 pt-1 text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
        {#if localCopyNote(item, name)}<p>{localCopyNote(item, name)}</p>{/if}
        {#if local}<p>{local}</p>{/if}
        {#if on && outdated.length}<p>
            {outdated.join(", ")}
            {outdated.length === 1 ? "needs" : "need"} an update to share configuration and keep{outdated.length === 1
              ? "s"
              : ""} its own.
          </p>{/if}
      </div>
    </SettingsRow>
    {#if conflicts.length}<div class="grid gap-2 px-4 pb-3.5">
        {#each conflicts as conflict (conflict.nodeId)}<ConflictHint {conflict} />{/each}
      </div>{/if}
  </div>
{/if}
