<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { bots } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";

  /**
   * A bot that moved here from another computer (docs/linked-computers.md, stage 8). Connector accounts and MCP
   * servers belong to each computer: until they are connected here, the bot lists what it still needs.
   */
  let { bot, class: className }: { bot: bots.Bot; class?: ClassValue } = $props();
</script>

{#if bot.movedFromName && bot.reconnect.length}
  <div class={className}>
    <Alert tone="info" title={`Moved from ${bot.movedFromName}`}>
      <p class="text-pretty">Connect these again on this computer so {bot.configuration?.name || "the bot"} can use them: {bot.reconnect.join(", ")}.</p>
      <ButtonLink size="sm" href="/settings/connectors">Open connectors</ButtonLink>
    </Alert>
  </div>
{/if}
