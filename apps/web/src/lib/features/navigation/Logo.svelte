<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  let { subtitle, label = "Homepage", class: className }: { subtitle?: Snippet; label?: string; class?: ClassValue } = $props();
</script>

<a href="/" aria-label={label} class={["flex min-w-0 items-center gap-2 rounded-md text-base/6 font-semibold text-zinc-950 focus-ring dark:text-white", className]}>
  <img src="/canopy-logo.png" alt="" width="24" height="24" class="size-6 shrink-0 rounded-md" />
  <div class="min-w-0">
    <div class="truncate">Canopy</div>
    {@render subtitle?.()}
  </div>
</a>
