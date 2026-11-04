<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { botTextTone } from "../mascot.ts";
  import type { ParticipantView } from "../model.ts";
  import BotAvatar from "./BotAvatar.svelte";
  import type { MascotState } from "../behaviour.ts";

  /**
   * Layout of one entry from a participant: a gutter with the sender's avatar (only beside the last
   * entry of a run, so the column stays aligned), the sender's name in their colour above the first
   * one, and the content. `end` puts it on the right; your own entries have no avatar. Without `gutter` (a 1:1
   * chat: who speaks is never in doubt) there is no avatar column at all.
   */
  let {
    sender,
    side = "start",
    mine = false,
    showAvatar = true,
    showName = false,
    gutter = true,
    state = "idle",
    event,
    children,
    class: className,
  }: {
    sender: ParticipantView | undefined;
    side?: "start" | "end";
    mine?: boolean;
    showAvatar?: boolean;
    showName?: boolean;
    gutter?: boolean;
    state?: MascotState;
    event?: unknown;
    children: Snippet;
    class?: ClassValue;
  } = $props();
</script>

<div class={["flex items-end gap-2", side === "end" && "flex-row-reverse", className]}>
  {#if !mine && gutter}
    <span class="w-7 shrink-0">
      {#if showAvatar && sender}<BotAvatar participant={sender} size="sm" {state} {event} />{/if}
    </span>
  {/if}
  <div class={["flex min-w-0 flex-1 flex-col gap-1", side === "end" ? "items-end" : "items-start"]}>
    {#if showName && sender}
      <p
        class={[
          "px-3 text-sm/5 font-medium sm:text-xs/5",
          sender.kind === "bot" ? botTextTone(sender) : "text-zinc-500 dark:text-zinc-400",
        ]}
        style:--bot-color={sender.color}
      >
        {sender.name}
      </p>
    {/if}
    {@render children()}
  </div>
</div>
