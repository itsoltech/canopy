<script lang="ts">
  import type { QueueContentItem } from "@canopy/domain/queue";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  let {
    summary,
    items,
    class: className,
  }: { summary: string; items: readonly QueueContentItem[]; class?: ClassValue } = $props();

  const icon = (kind: QueueContentItem["kind"]) =>
    kind === "image" ? "photo" : kind === "citation" ? "chat-bubble-bottom-center-text" : "document-text";
</script>

<Popover label="Message content" placement="top-start" sheet class="w-80 max-w-[calc(100vw-2rem)]">
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      aria-label="Show message content: {summary}"
      title={summary}
      class={[
        "relative flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-[0.8125rem]/5 text-zinc-500 tabular-nums hover:bg-zinc-950/5 focus-visible:outline-2 focus-visible:outline-brand-500 sm:text-[0.71875rem]/4 dark:text-zinc-400 dark:hover:bg-white/5",
        className,
      ]}
    >
      <Icon name="paper-clip" size="sm" />
      <span class="truncate">{summary}</span>
      <TouchTarget />
    </button>
  {/snippet}
  <ul role="list" class="grid gap-2 p-3 text-sm/5 sm:text-xs/4">
    {#each items as item, index (index)}
      <li class="flex min-w-0 items-start gap-2">
        <Icon name={icon(item.kind)} size="sm" class="text-zinc-500 dark:text-zinc-400" />
        <p class="min-w-0 wrap-anywhere select-text">{item.label}</p>
      </li>
    {/each}
  </ul>
</Popover>
