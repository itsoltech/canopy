<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /** A moved thing's kind icon and title (and optional second line), truncating in a row with badges. */
  let {
    kind,
    title,
    detail = "",
    class: className,
  }: { kind: string; title: string; detail?: string; class?: ClassValue } = $props();
</script>

<div class={["flex min-w-0 flex-1 items-start gap-2", className]}>
  <span class="flex h-lh shrink-0 items-center text-base/6 sm:text-sm/6"
    ><Icon
      name={kind === "bot" ? "face-smile" : "chat-bubble-left-right"}
      class="size-5 text-zinc-400 sm:size-4 dark:text-zinc-500"
    /></span
  >
  <div class="min-w-0 flex-1">
    <p class="truncate text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
      {title || (kind === "bot" ? "Bot" : "Thread")}
    </p>
    {#if detail}<p class="truncate text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{detail}</p>{/if}
  </div>
</div>
