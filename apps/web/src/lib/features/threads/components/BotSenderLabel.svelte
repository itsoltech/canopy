<script lang="ts">
  import BotAvatar from "#lib/features/bots/components/BotAvatar.svelte";
  import { botList } from "#lib/features/bots/bot-list.svelte.ts";
  import { botParticipant } from "#lib/features/bots/live.ts";
  import type { ui } from "@canopy/contracts";

  /**
   * "Message from ‹avatar› ‹Bot›" over input a bot sent into a thread (trigger bot): its mascot and name, linking to
   * its chat. A linked sender's snapshot supplies its name and avatar while the bot list is unavailable.
   */
  let { botId, verb = "Message from", sender }: { botId: string; verb?: string; sender?: ui.AgentSender } = $props();

  $effect(() => botList.use());

  const bot = $derived(botList.list.find((b) => b.id === botId));

  const participant = $derived(
    bot
      ? botParticipant(bot)
      : sender?.botId
        ? {
            id: botId,
            kind: "bot" as const,
            name: sender.title,
            shape: sender.botShape,
            color: sender.botColor,
          }
        : undefined,
  );
</script>

<span class="shrink-0 whitespace-nowrap">{verb}</span>
{#if participant}
  <a
    href="/bots/{botId}"
    title={participant.name}
    class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm font-medium focus-ring hover:underline"
  >
    <BotAvatar {participant} size="xs" alive={false} class="shrink-0" />
    <span class="truncate">{participant.name}</span>
  </a>
{:else}
  <span>a bot</span>
{/if}
