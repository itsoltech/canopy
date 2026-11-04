<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  /** Composer pill that opens the goal dialog (icon only on phones). */
  let { onclick, class: className }: { onclick: () => void; class?: ClassValue } = $props();
</script>

<PillButton
  chevron={false}
  aria-label="Set a goal"
  class={className}
  {onclick}
  {@attach tooltip("Set a goal: the agent keeps working until it is met")}
>
  <Icon name="flag" class="size-3.5" /><span class="max-sm:sr-only">Goal</span>
</PillButton>
