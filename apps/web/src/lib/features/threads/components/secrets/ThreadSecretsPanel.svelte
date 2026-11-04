<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { rise } from "#lib/shared/ui/motion.ts";
  import ThreadSecretCard from "./ThreadSecretCard.svelte";

  let {
    secrets,
    onchange,
    class: className,
  }: {
    secrets: readonly ui.ThreadSecret[];
    onchange: (secret: ui.ThreadSecret) => void;
    class?: ClassValue;
  } = $props();
</script>

<div class={["grid max-h-[45dvh] min-w-0 gap-2 overflow-y-auto p-px", className]} aria-label="Thread secrets">
  {#each secrets as secret (secret.requestId)}
    <div in:rise><ThreadSecretCard {secret} {onchange} /></div>
  {/each}
</div>
