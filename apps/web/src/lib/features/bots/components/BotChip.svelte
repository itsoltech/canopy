<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { botTextTone } from "../mascot.ts";
  import type { ParticipantView } from "@canopy/domain/bot-chat";
  import BotAvatar from "./BotAvatar.svelte";
  import { BOT_CHIP_CLASS } from "../mention-chip.ts";

  /**
   * A bot named inline: a small avatar and the name in the bot's colour ("‹avatar› FIXme CRM"), in a
   * message (a mention) or a bot ⇄ bot marker. With `href` it is a link; it never wraps inside.
   */
  let {
    bot,
    href,
    class: className,
  }: { bot: ParticipantView; href?: string | undefined; class?: ClassValue } = $props();

  const classes = $derived([
    BOT_CHIP_CLASS,
    botTextTone(bot),
    href && "rounded-sm hover:underline focus-ring",
    className,
  ]);
</script>

{#snippet content()}
  <BotAvatar participant={bot} size="xs" class="self-center" />
  <span class="truncate">{bot.name}</span>
{/snippet}

{#if href}
  <a {href} class={classes} style:--bot-color={bot.color}>{@render content()}</a>
{:else}
  <span class={classes} style:--bot-color={bot.color}>{@render content()}</span>
{/if}
