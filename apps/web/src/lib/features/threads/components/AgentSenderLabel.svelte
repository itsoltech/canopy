<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import ProviderModel from "./ProviderModel.svelte";
  import ThreadLink from "./items/ThreadLink.svelte";
  import BotSenderLabel from "./BotSenderLabel.svelte";
  import type { Snippet } from "svelte";

  /**
   * Who sent an agent's input (a task, a message, a report, a steer): links to its bot or thread,
   * with a snapshot when the sender is outside the current directory. The model and computer
   * are quiet details in the violet line above the bubble.
   */
  let {
    verb,
    threadId,
    sender,
    fallback = "another thread",
    leading,
    trailing,
  }: {
    verb: string;
    threadId: string;
    sender?: ui.AgentSender | undefined;
    fallback?: string;
    leading?: Snippet | undefined;
    trailing?: Snippet | undefined;
  } = $props();
</script>

<span class="inline-flex max-w-full min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1 sm:flex-nowrap">
  <span class="inline-flex max-w-full min-w-0 items-center gap-1.5">
    {@render leading?.()}
    {#if sender?.botId}
      <BotSenderLabel botId={sender.botId} {verb} {sender} />
    {:else}
      <span class="shrink-0 whitespace-nowrap">{verb}</span>
      <span class="inline-flex min-w-28">
        <ThreadLink {threadId} fallback={sender?.title || fallback} class="w-full" />
      </span>
    {/if}
  </span>
  {#if (sender && (!sender.botId || sender.computerName)) || trailing}
    <!-- Bound the model's share so a long name cannot crowd out the title. -->
    <span
      class="inline-flex max-w-full min-w-0 shrink-0 items-center gap-1.5 text-zinc-500 sm:max-w-[calc(100%-10rem)] dark:text-zinc-400"
    >
      {#if sender && !sender.botId}<ProviderModel
          provider={sender.provider}
          model={sender.model}
          class="max-w-44"
        />{/if}
      {#if sender?.computerName}<span class="min-w-0 truncate" title={sender.computerName}
          >on {sender.computerName}</span
        >{/if}
      {@render trailing?.()}
    </span>
  {/if}
</span>
