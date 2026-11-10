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
    ontoggle,
    class: className,
  }: {
    label: string;
    open: boolean;
    running: boolean;
    icon: IconName;
    status: ItemStatus;
    ontoggle: () => void;
    class?: ClassValue;
  } = $props();
</script>

<div class={["density-work", className]}>
  <button
    type="button"
    class={[
      "flex w-full min-w-0 items-start gap-2 rounded-md text-left text-base/6 focus-ring sm:text-sm/5",
      activityHeader,
      activitySurface(status),
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
    <span class="flex h-lh w-24 shrink-0 items-center justify-end text-sm sm:text-xs"><ItemStatusIcon {status} /></span>
  </button>
</div>
