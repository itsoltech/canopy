<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { ClassValue } from "svelte/elements";

  /** Panels above the composer reveal upward and fold downward. */
  let { expanded, class: className }: { expanded: boolean; class?: ClassValue } = $props();
</script>

<Icon
  name="chevron-down"
  size="xs"
  class={[
    "t-acc-chevron t-composer-chevron fill-zinc-400 dark:fill-zinc-500",
    expanded ? "rotate-0" : "rotate-180",
    className,
  ]}
/>
