<script lang="ts">
  import type { Reasoning } from "@open-agents/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import { LineReveal } from "#lib/shared/ui/streaming/line-reveal.svelte.ts";

  /** Reasoning, collapsed: the first line of the summary as a preview, the rest on demand. */
  let { reasoning, streaming }: { reasoning: Reasoning; streaming: boolean } = $props();
  // The preview follows the stream line by line too, not token by token.
  const shown = new LineReveal(
    () => reasoning.summary || reasoning.text,
    () => streaming,
  );
  const preview = $derived(shown.text.trim().split("\n")[0]?.replace(/^[#*_\s]+|[*_]+$/g, "") ?? "");
  const hasBody = $derived(Boolean(reasoning.summary.trim() || reasoning.text.trim()));
</script>

{#if hasBody || streaming}
  <Disclosure remember="reasoning" summaryClass="-mx-1.5 px-1.5 py-1 text-base/6 hover:bg-zinc-950/2.5 sm:text-sm/6 dark:hover:bg-white/5">
    {#snippet summary()}
      <span class="flex min-w-0 gap-2">
        {#key streaming}<span class={["shrink-0 font-medium", streaming ? "shimmer" : "text-zinc-500 dark:text-zinc-400"]} in:swap>{streaming ? "Thinking" : "Thought"}</span>{/key}
        {#if preview}<span class="truncate text-zinc-500 dark:text-zinc-400">{preview}</span>{/if}
      </span>
    {/snippet}
    <div class="mt-1 mb-2 grid gap-3 border-l-2 border-zinc-950/5 pl-4 dark:border-white/10">
      {#if reasoning.summary.trim()}<Markdown text={reasoning.summary} {streaming} class="text-zinc-600 dark:text-zinc-400" />{/if}
      {#if reasoning.text.trim() && reasoning.text !== reasoning.summary}<Markdown text={reasoning.text} {streaming} class="text-zinc-500 dark:text-zinc-400" />{/if}
    </div>
  </Disclosure>
{/if}
