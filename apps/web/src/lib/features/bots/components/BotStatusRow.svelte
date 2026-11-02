<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { swap } from "#lib/shared/ui/motion.ts";
  import type { ParticipantView } from "../model.ts";
  import BotAvatar from "./BotAvatar.svelte";

  /**
   * What the bot is doing right now, under its last message like a person typing: its avatar and a
   * shimmering line ("Typing…", "Checking Notion"). A new phrase rises in (text states swap). While it
   * waits for you the line is still: the card above is what needs you. A status region for screen readers.
   */
  let { bot, text, waiting = false, class: className }: { bot: ParticipantView; text: string; waiting?: boolean; class?: ClassValue } = $props();
</script>

<div role="status" class={["flex items-center gap-2", className]}>
  <span class="w-7 shrink-0"><BotAvatar participant={bot} size="sm" /></span>
  <p class="min-w-0 px-1 text-base/6 sm:text-sm/6">
    <span class="sr-only">{bot.name}: </span>
    {#key text}
      <span class={["inline-block truncate", waiting ? "text-zinc-500 dark:text-zinc-400" : "shimmer"]} in:swap>{text}</span>
    {/key}
  </p>
</div>
