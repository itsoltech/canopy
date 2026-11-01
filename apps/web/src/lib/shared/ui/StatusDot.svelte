<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { dotTones, type Tone } from "./tone.ts";

  /** 6px status dot; `active` adds a soft pulse (off with reduced motion). Pair with text. */
  let { tone, active = false, class: className }: { tone: Tone; active?: boolean; class?: ClassValue } = $props();
</script>

<span class={["relative inline-flex size-1.5 shrink-0", className]} aria-hidden="true">
  {#if active}<svg viewBox="0 0 6 6" class={["absolute inset-0 size-1.5 opacity-75 motion-safe:animate-ping", dotTones[tone]]}><circle cx="3" cy="3" r="3" /></svg>{/if}
  <svg viewBox="0 0 6 6" class={["size-1.5", dotTones[tone]]}><circle cx="3" cy="3" r="3" /></svg>
</span>
