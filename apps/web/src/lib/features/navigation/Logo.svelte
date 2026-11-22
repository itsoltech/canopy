<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { sidebarIcon } from "@canopy/ui/sidebar-art";

  let {
    subtitle,
    label = "Homepage",
    class: className,
  }: { subtitle?: Snippet; label?: string; class?: ClassValue } = $props();
</script>

<a
  href="/"
  aria-label={label}
  class={[
    "flex min-w-0 items-center gap-2 rounded-md text-base/6 font-semibold text-zinc-950 focus-ring dark:text-white",
    className,
  ]}
>
  <span aria-hidden="true" class="sidebar-logo-tile size-6 shrink-0">{@html sidebarIcon}</span>
  <div class="min-w-0">
    <div class="truncate leading-5">Canopy</div>
    {@render subtitle?.()}
  </div>
</a>
