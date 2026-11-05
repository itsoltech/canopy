<script lang="ts">
  import type { Snippet } from "svelte";
  import { provideDensity } from "./density.ts";

  /** Content of an overlay panel: kit controls inside take the compact size (a trigger outside keeps its own). */
  let { children }: { children: Snippet } = $props();

  provideDensity("overlay");
</script>

{@render children()}
