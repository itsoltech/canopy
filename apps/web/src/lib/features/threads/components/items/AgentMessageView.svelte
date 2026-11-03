<script lang="ts">
  import type { AgentMessage } from "@canopy/contracts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";

  /** Agent text as markdown. Commentary (thinking aloud while working) is quieter than answers. */
  let { message, streaming }: { message: AgentMessage; streaming: boolean } = $props();
  const commentary = $derived(message.phase === "commentary");
</script>

<div data-quote-kind="agent_message" class={["min-w-0", commentary && "border-l-2 border-zinc-950/5 pl-3 dark:border-white/10"]} aria-busy={streaming}>
  <!-- While it streams, it shows line by line and each new block resolves in; the caret breathes. -->
  <Markdown text={message.text} {streaming} class={[commentary && "text-zinc-600 dark:text-zinc-400"]} />
  {#if streaming}<span data-quote-skip class="t-pulse mt-1 inline-block h-4 w-1.5 rounded-xs bg-zinc-400 dark:bg-zinc-500" aria-hidden="true"></span>{/if}
</div>
