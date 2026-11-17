<script lang="ts">
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { usageProvider } from "./providers.ts";

  let { provider }: { provider: string } = $props();
  const mark = $derived(usageProvider(provider));
</script>

{#if mark}
  {#if mark.icon === "CLAUDE"}
    <ProviderIcon provider={mark.icon} />
  {:else}
    <span
      class={[
        "grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-zinc-400/70",
        mark.icon === "CODEX" ? "bg-white" : "bg-zinc-950",
      ]}><ProviderIcon provider={mark.icon} color={mark.color} size="sm" /></span
    >
  {/if}
{/if}
