<script lang="ts">
  import type { UserMessage } from "@open-agents/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /** The input of a turn. Messages from another agent (agent bus) are marked as such. */
  let { message, queued = false }: { message: Pick<UserMessage, "text" | "authorAgentId" | "attachments">; queued?: boolean } = $props();
  const fromAgent = $derived(Boolean(message.authorAgentId));
</script>

<div class="flex flex-col items-end gap-1">
  {#if fromAgent || queued}
    <p class="flex items-center gap-1 text-sm/5 sm:text-xs/5 {fromAgent ? 'text-violet-700 dark:text-violet-400' : 'text-zinc-500 dark:text-zinc-400'}">
      <Icon name={fromAgent ? "sparkles" : "clock"} class="size-3.5" />
      {fromAgent ? "From an agent" : "Queued, runs after the current turn"}
    </p>
  {/if}
  <div
    class={[
      "max-w-[min(85%,42rem)] rounded-2xl rounded-br-md px-4 py-2.5 text-base/6 break-words whitespace-pre-wrap sm:text-sm/6",
      fromAgent ? "bg-violet-50 text-violet-950 ring-1 ring-violet-600/10 ring-inset dark:bg-violet-400/10 dark:text-violet-50 dark:ring-violet-400/20" : "bg-zinc-100 text-zinc-950 dark:bg-white/10 dark:text-white",
      queued && "opacity-70",
    ]}
  >
    {message.text}
  </div>
  {#if message.attachments.length > 0}
    <p class="flex items-center gap-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <Icon name="photo" class="size-3.5" />{message.attachments.length} {message.attachments.length === 1 ? "attachment" : "attachments"}
    </p>
  {/if}
</div>
