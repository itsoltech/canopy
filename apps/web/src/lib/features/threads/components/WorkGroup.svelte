<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import type { ItemStatus } from "@canopy/contracts";
  import ItemStatusIcon from "./items/ItemStatusIcon.svelte";
  import { activityHeader, activitySurface } from "./activity-header.ts";

  let {
    label,
    open,
    running,
    icon,
    status,
    statusCount,
    ontoggle,
    class: className,
  }: {
    label: string;
    open: boolean;
    running: boolean;
    icon: IconName;
    status: ItemStatus;
    statusCount: number;
    ontoggle: () => void;
    class?: ClassValue;
  } = $props();
</script>

<div class={["activity-group-head density-work", activitySurface, className]} data-open={open || undefined}>
  <button
    type="button"
    class={[
      "flex w-full min-w-0 items-start gap-2 rounded-md text-left text-base/6 focus-ring sm:text-sm/5",
      activityHeader,
    ]}
    aria-expanded={open}
    title={label}
    onclick={ontoggle}
  >
    <span class="flex h-lh shrink-0 items-center"
      ><Icon
        name="chevron-right"
        class={["t-acc-chevron fill-zinc-400 dark:fill-zinc-500", open && "rotate-90"]}
      /></span
    >
    <span class="flex h-lh shrink-0 items-center"><Icon name={icon} /></span>
    <span class={["min-w-0 flex-1 truncate", running && "shimmer"]}>{label}</span>
    <span class="flex h-6 w-10 shrink-0 items-center justify-end text-sm/6 tabular-nums sm:h-5 sm:w-28 sm:text-xs/5"
      ><ItemStatusIcon {status} count={statusCount} /></span
    >
  </button>
</div>
