<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { harnessKey } from "./instances.ts";

  /** The harness's mark on a tile, with the instance's accent color as a dot (also used in the pickers). */
  let { instance, class: className }: { instance: Pick<ui.ProviderInstance, "harness" | "accentColor">; class?: ClassValue } = $props();
</script>

<span class={["relative grid size-8 shrink-0 place-items-center rounded-lg bg-white ring-1 ring-zinc-950/10 dark:bg-white/5 dark:ring-white/10", className]}>
  <ProviderIcon provider={harnessKey(instance.harness)} />
  {#if instance.accentColor}
    <span class="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-white dark:ring-zinc-950" style:background-color={instance.accentColor} aria-hidden="true"></span>
  {/if}
</span>
