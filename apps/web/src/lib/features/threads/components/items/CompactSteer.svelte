<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { firstLine } from "@canopy/domain/first-line";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { useRemembered } from "#lib/shared/ui/memory.ts";
  import FindableMessagePanel from "./FindableMessagePanel.svelte";
  import { useThreadDirectory } from "../../thread-directory.ts";
  import BotSenderLabel from "../BotSenderLabel.svelte";
  import ProviderModel from "../ProviderModel.svelte";
  import AgentMessageActions from "./AgentMessageActions.svelte";
  import ThreadLink from "./ThreadLink.svelte";
  import type { MessageNote } from "./UserMessageView.svelte";

  let {
    sender,
    threadId,
    note,
    pending,
    text,
    previewFallback,
    children,
  }: {
    sender?: ui.AgentSender | undefined;
    threadId: string;
    note: MessageNote;
    pending: boolean;
    text: string;
    previewFallback?: string | undefined;
    children: Snippet;
  } = $props();

  const directory = useThreadDirectory();
  const memory = useRemembered<boolean>("agent-message");
  const id = $props.id();
  const preview = $derived(firstLine(text).text || previewFallback || "Show message");
  let expanded = $state(memory?.get() ?? false);

  $effect(() => memory?.set(expanded));
</script>

<div class="@container w-full max-w-[42rem]">
  <div
    class="relative ml-auto grid w-fit max-w-full items-center gap-x-2 rounded-lg bg-violet-500/5 px-2 py-1 text-sm/5 text-zinc-700 sm:text-[0.8125rem]/5 @min-[30rem]:min-h-8 @min-[30rem]:grid-cols-[fit-content(45%)_minmax(0,1fr)] dark:text-zinc-300 pointer-coarse:min-h-11"
  >
    <span class="pointer-events-none flex min-w-0 items-center gap-1 text-violet-700 dark:text-violet-300">
      {#if note.icon === "spinner"}
        <Spinner class="size-3.5 shrink-0" />
      {:else}
        <Icon name={note.icon} class="size-3.5 shrink-0" />
      {/if}
      <span
        class="relative z-1 inline-flex max-w-full min-w-0 items-center text-sm/5 font-medium sm:text-xs/5 [&_a]:pointer-events-auto"
      >
        {#if sender?.botId}
          <BotSenderLabel botId={sender.botId} {sender} verb="" />
        {:else if threadId}
          <ThreadLink {threadId} fallback={sender?.title || "another thread"} />
        {:else}
          From an agent
        {/if}
      </span>
    </span>
    <button
      type="button"
      class="flex min-w-0 items-center gap-2 rounded-lg text-left after:absolute after:inset-0 after:rounded-lg hover:after:bg-violet-500/5 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-brand-500"
      aria-expanded={expanded}
      aria-controls={id}
      onclick={() => (expanded = !expanded)}
    >
      <span class="grid min-w-0 flex-1">
        <span class={["col-start-1 row-start-1 truncate", expanded && "invisible"]}>{preview}</span>
        <span class={["col-start-1 row-start-1 truncate", !expanded && "invisible"]}
          >{pending ? "Show less" : note.text}</span
        >
      </span>
      <span class="sr-only">{expanded ? "Collapse message" : "Expand message"}</span>
      <Icon
        name="chevron-down"
        class={["t-acc-chevron size-3.5 shrink-0 fill-zinc-500 dark:fill-zinc-400", expanded && "rotate-180"]}
      />
    </button>
    {#if pending}<span class="col-span-full text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{note.text}</span
      >{/if}
  </div>
  <FindableMessagePanel {id} bind:expanded>
    <div
      class="mt-1 rounded-xl bg-violet-50 theme-message-padding text-base/6 wrap-anywhere text-violet-950 sm:text-sm/6 dark:bg-violet-400/10 dark:text-violet-50"
    >
      <div data-quote-item="" data-quote-thread={directory.currentId}>
        <div data-quote-kind={directory.readOnly || pending ? undefined : "agent_message"}>{@render children()}</div>
      </div>
      <div
        class="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
      >
        {#if sender && !sender.botId}<ProviderModel provider={sender.provider} model={sender.model} />{/if}
        {#if sender?.computerName}<span class="min-w-0 break-words">on {sender.computerName}</span>{/if}
        {#if !pending}<AgentMessageActions {text} />{/if}
      </div>
    </div>
  </FindableMessagePanel>
</div>
