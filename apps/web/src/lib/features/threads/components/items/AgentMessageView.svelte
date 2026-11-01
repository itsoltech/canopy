<script lang="ts">
  import type { AgentMessage } from "@open-agents/contracts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";

  /** Agent text as markdown. Commentary (thinking aloud while working) is quieter than answers. */
  let { message, streaming }: { message: AgentMessage; streaming: boolean } = $props();
  const commentary = $derived(message.phase === "commentary");
</script>

<div class={["min-w-0", commentary && "border-l-2 border-zinc-950/5 pl-3 dark:border-white/10"]} aria-busy={streaming}>
  <Markdown text={message.text} class={commentary ? "text-zinc-600 dark:text-zinc-400" : undefined} />
  {#if streaming}<span class="mt-1 inline-block h-4 w-1.5 rounded-xs bg-zinc-400 motion-safe:animate-pulse dark:bg-zinc-500" aria-hidden="true"></span>{/if}
</div>
