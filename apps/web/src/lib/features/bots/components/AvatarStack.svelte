<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { avatarRing } from "../avatar-ring.ts";
  import type { ParticipantView } from "../model.ts";
  import BotAvatar from "./BotAvatar.svelte";
  import type { MascotState } from "../behaviour.ts";

  /**
   * Avatars of a group. `square`: two avatars on a diagonal in the space of one (list rows, pinned
   * tiles); `row`: up to `max` overlapping in a line, then "+N" (headers). Each avatar has a ring in
   * the colour of the surface behind it (`avatarRing`).
   */
  let {
    participants,
    layout = "row",
    size = "md",
    max = 3,
    alive = true,
    state = "idle",
    event,
    class: className,
  }: {
    participants: readonly ParticipantView[];
    layout?: "square" | "row";
    size?: "md" | "lg";
    max?: number;
    alive?: boolean;
    state?: MascotState;
    event?: unknown;
    class?: ClassValue;
  } = $props();

  const ring = ["rounded-full", avatarRing];
  const shown = $derived(participants.slice(0, layout === "square" ? 2 : max));
  const extra = $derived(participants.length - shown.length);
</script>

{#if layout === "square"}
  <span class={["relative inline-block shrink-0", size === "lg" ? "size-14" : "size-10", className]} aria-hidden="true">
    {#if shown[0]}<span class="absolute top-0 left-0 flex"
        ><BotAvatar participant={shown[0]} {alive} {state} {event} size={size === "lg" ? "md" : "sm"} /></span
      >{/if}
    {#if shown[1]}<span class="absolute right-0 bottom-0 flex"
        ><BotAvatar
          participant={shown[1]}
          {alive}
          {state}
          {event}
          size={size === "lg" ? "md" : "sm"}
          class={ring}
        /></span
      >{/if}
  </span>
{:else}
  <span class={["flex shrink-0 items-center -space-x-1.5", className]} aria-hidden="true">
    {#each shown as participant (participant.id)}
      <BotAvatar {participant} {alive} {state} {event} size="sm" class={ring} />
    {/each}
    {#if extra > 0}
      <span
        class={[
          "grid size-7 place-items-center bg-zinc-200 text-[0.6875rem] font-medium text-zinc-700 tabular-nums dark:bg-zinc-800 dark:text-zinc-200",
          ...ring,
        ]}>+{extra}</span
      >
    {/if}
  </span>
{/if}
