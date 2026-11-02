<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let { label, onexpand, class: className }: { label: string; onexpand: () => void; class?: ClassValue } = $props();
</script>

<div class={["text-sm/6", className]}>
  <button type="button" class="relative grid size-8 place-items-center rounded-full bg-zinc-950/5 text-zinc-600 focus-ring hover:bg-zinc-950/10 dark:bg-white/5 dark:text-zinc-400 dark:hover:bg-white/10"
    aria-label={`Expand composer: ${label}`} {@attach tooltip(label)} onfocus={onexpand} onclick={onexpand}>
    <Icon name="square-2-stack" />
    <TouchTarget />
  </button>
</div>
