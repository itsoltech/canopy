<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { markdownText } from "@canopy/domain/markdown";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import { useThreadDirectory } from "../../thread-directory.ts";
  import AgentMessageBubble from "./AgentMessageBubble.svelte";

  /** Received bus prose: copy its original source, or quote it like an agent's answer. */
  let {
    text,
    rich = false,
    label,
    pending = false,
    class: className,
    children,
  }: {
    text: string;
    rich?: boolean;
    label?: string;
    pending?: boolean;
    class?: ClassValue;
    children: Snippet;
  } = $props();

  const directory = useThreadDirectory();
  const drafts = useQuoteDrafts();
  const passage = $derived(markdownText(text));

  function cite() {
    const added = drafts.add(directory.currentId, {
      text: passage,
      // Received inputs have no output item to reveal; the passage still names its receiving thread.
      source: { itemId: "", threadId: directory.currentId, kind: "agent_message", language: "" },
    });

    if (!added) toast("A message can carry up to 20 quotes", { tone: "error" });
  }
</script>

<div class="contents" data-quote-item="" data-quote-thread={directory.currentId}>
  <div class="contents" data-quote-kind={directory.readOnly || pending ? undefined : "agent_message"}>
    <AgentMessageBubble {text} {rich} {label} class={className}>
      {@render children()}
    </AgentMessageBubble>
  </div>
</div>
{#if text.trim()}
  <div class={["flex items-center gap-1", pending && "invisible"]} inert={pending} data-quote-skip>
    <CopyButton {text} label="Copy message" />
    {#if !directory.readOnly && directory.currentId}
      <IconButton icon="chat-bubble-left-right" label="Quote message" size="sm" onclick={cite} />
    {/if}
  </div>
{/if}
