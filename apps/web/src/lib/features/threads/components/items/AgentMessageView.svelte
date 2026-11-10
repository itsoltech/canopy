<script lang="ts">
  import type { AgentMessage } from "@canopy/contracts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { runningAnimation } from "#lib/shared/activity.ts";

  /** Agent prose stays the primary reading content, inside work folds and in the answer slot. */
  let { message, streaming }: { message: AgentMessage; streaming: boolean } = $props();
</script>

<div data-quote-kind="agent_message" class="min-w-0" aria-busy={streaming}>
  <!-- While it streams, it shows line by line and each new block resolves in; the caret breathes. -->
  <Markdown text={message.text} {streaming} />
  {#if streaming}<span
      data-quote-skip
      class="t-pulse mt-1 inline-block h-4 w-1.5 rounded-xs bg-zinc-400 dark:bg-zinc-500"
      aria-hidden="true"
      {@attach runningAnimation}
    ></span>{/if}
</div>
