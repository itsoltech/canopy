<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { computerName, awayStatus, presenceTime } from "./computers.ts";

  /** A quiet status in the composer's shared strip; connection rules stay with the thread. */
  let {
    computer,
    reason,
    class: className,
  }: { computer: ui.LinkedComputer | undefined; reason: string; class?: ClassValue } = $props();

  const at = $derived(computer?.statusSinceMs ? presenceTime(computer.statusSinceMs) : undefined);
</script>

<div
  class={[
    "t-rise flex min-w-0 items-center gap-2 px-4 py-1.5 text-sm/5 text-zinc-600 sm:text-[0.8125rem]/5 dark:text-zinc-400",
    className,
  ]}
>
  <Icon name="link" size="xs" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
  <p role="status" aria-atomic="true" class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">
    <span class="flex max-w-full min-w-0 items-baseline gap-1">
      <span class="truncate" title={computerName(computer)}>{computerName(computer)}</span>
      <span class="shrink-0">· {awayStatus(computer)}</span>
    </span>
    <span>· read only</span>
    {#if at}<span class="whitespace-nowrap tabular-nums">· since {at}</span>{/if}
  </p>
  <Popover label="Connection details" placement="top-end" class="w-72">
    {#snippet trigger(props)}<IconButton
        icon="information-circle"
        size="sm"
        label="Show connection details"
        {...props}
      />{/snippet}
    <div class="grid gap-2 p-3 text-base/6 text-zinc-600 sm:text-sm/5 dark:text-zinc-400">
      <p>{reason}</p>
      <p>Nothing is queued.</p>
      <p>Files are available when connected.</p>
    </div>
  </Popover>
</div>
