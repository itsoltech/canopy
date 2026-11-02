<script lang="ts">
  import BotAvatar from "#lib/features/bots/components/BotAvatar.svelte";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import { botParticipant } from "#lib/features/bots/live.ts";

  /**
   * "Message from ‹avatar› ‹Bot›" over input a bot sent into a thread (trigger bot): its mascot and name, linking to
   * its chat. Until the bot list arrives (or for a deleted bot) it says "a bot".
   */
  let { botId, verb = "Message from" }: { botId: string; verb?: string } = $props();
  $effect(() => botList.use());
  const bot = $derived(botList.list.find((b) => b.id === botId));
  const participant = $derived(bot ? botParticipant(bot) : undefined);
</script>

{verb}
{#if participant}
  <a href="/bots/{botId}" class="inline-flex min-w-0 items-center gap-1 font-medium hover:underline focus-ring rounded-sm">
    <BotAvatar {participant} size="xs" alive={false} class="shrink-0" />
    <span class="truncate">{participant.name}</span>
  </a>
{:else}
  <span>a bot</span>
{/if}
