<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Sensitive from "./Sensitive.svelte";

  let { value, class: className }: { value: string; class?: ClassValue } = $props();
  const parts = $derived(!value.includes("@") ? /^(https?:\/\/)(\[[^\]]+\]|[^/:?#]+)(.*)$/.exec(value) : null);
</script>

<span class={["inline-flex max-w-full min-w-0 items-baseline align-bottom", className]}>
  {#if parts}
    <span class="shrink-0">{parts[1]}</span><Sensitive value={parts[2]!} label="Proxy host" truncate /><span
      class="break-all">{parts[3]}</span
    >
  {:else}
    <Sensitive {value} label="Proxy URL" />
  {/if}
</span>
