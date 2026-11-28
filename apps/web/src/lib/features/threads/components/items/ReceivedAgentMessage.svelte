<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { useThreadDirectory } from "../../thread-directory.ts";
  import AgentMessageActions from "./AgentMessageActions.svelte";
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
</script>

<div class="contents" data-quote-item="" data-quote-thread={directory.currentId}>
  <div class="contents" data-quote-kind={directory.readOnly || pending ? undefined : "agent_message"}>
    <AgentMessageBubble {text} {rich} {label} class={className}>
      {@render children()}
    </AgentMessageBubble>
  </div>
</div>
<AgentMessageActions {text} {pending} />
