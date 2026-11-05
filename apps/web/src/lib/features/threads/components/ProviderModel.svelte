<script lang="ts">
  import type { Provider } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { providerKeyOf } from "../providers.ts";

  /**
   * What an agent runs on, inline: the provider's mark and the model (with the effort when given), e.g. for a
   * subagent or the sender of a message. Inherits the text size and color of its line.
   */
  let {
    provider,
    model,
    effort = "",
    class: className,
  }: { provider: Provider; model: string; effort?: string; class?: ClassValue } = $props();

  const key = $derived(providerKeyOf(provider));
  const name = $derived(key === "CLAUDE" ? "Claude" : key === "GROK" ? "Grok" : "Codex");
  const label = $derived([model || `${name} default`, effort].filter(Boolean).join(" · "));
</script>

<span class={["inline-flex min-w-0 items-center gap-1", className]} title={label}>
  {#if key}<ProviderIcon provider={key} label={name} size="sm" />{/if}
  <span class="truncate">{label}</span>
</span>
