<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { fullDateLabel } from "../chat-timeline.ts";
  import type { ChatEventView } from "../model.ts";

  /** Something that happened rather than something said, centered: "Deleted routine · Canopy: scalenie PR #443 po CI". */
  let { event, class: className }: { event: ChatEventView; class?: ClassValue } = $props();

  const icons: Record<ChatEventView["kind"], IconName> = {
    routine_created: "arrow-path-rounded-square",
    routine_deleted: "trash",
    routines_disabled: "no-symbol",
    relayed_message: "chat-bubble-left",
    joined: "user-group",
    info: "information-circle",
  };
</script>

<p class={["flex justify-center gap-1.5 px-6 text-center text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]} title={fullDateLabel(event.at)}>
  <Icon name={icons[event.kind]} class="h-lh fill-zinc-400 dark:fill-zinc-500" />
  <span class="min-w-0 text-pretty">
    {event.text}{#if event.detail}<span class="text-zinc-400 dark:text-zinc-600">{" · "}</span><span class="text-zinc-700 dark:text-zinc-300">{event.detail}</span>{/if}
  </span>
</p>
