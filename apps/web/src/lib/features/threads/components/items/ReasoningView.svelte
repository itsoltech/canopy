<script lang="ts">
  import type { Reasoning } from "@canopy/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import LiveText from "#lib/shared/ui/LiveText.svelte";
  import { LineReveal } from "#lib/shared/ui/streaming/line-reveal.svelte.ts";
  import { activityBody } from "../activity-header.ts";

  /** Reasoning, collapsed: the first line of the summary as a preview, the rest on demand. */
  let { reasoning, streaming }: { reasoning: Reasoning; streaming: boolean } = $props();

  // The preview follows the stream line by line too, not token by token.
  const shown = new LineReveal(
    () => reasoning.summary || reasoning.text,
    () => streaming,
  );

  const preview = $derived(
    shown.text
      .trim()
      .split("\n")[0]
      ?.replace(/^[#*_\s]+|[*_]+$/g, "") ?? "",
  );

  const hasBody = $derived(Boolean(reasoning.summary.trim() || reasoning.text.trim()));
</script>

{#if hasBody || streaming}
  <Disclosure
    class="activity-shell density-work rounded-md border-l-2 border-zinc-950/5 bg-zinc-950/1 dark:border-white/10 dark:bg-white/2.5"
    grid
    remember="reasoning"
    summaryClass="px-2 py-2.5 text-base/6 text-zinc-600 hover:bg-zinc-950/2.5 sm:py-1 sm:text-sm/5 dark:text-zinc-400 dark:hover:bg-white/5"
  >
    {#snippet summary()}
      <span class="flex min-w-0 gap-2">
        <span class="flex h-lh shrink-0 items-center"><Icon name="light-bulb" /></span>
        {#key streaming}<span class="w-16 shrink-0 font-medium" in:swap
            ><LiveText text={streaming ? "Thinking" : "Thought"} active={streaming} /></span
          >{/key}
        <span class="min-w-0 truncate italic">{preview}</span>
      </span>
    {/snippet}
    <div data-quote-kind="reasoning" class={[activityBody, "gap-3"]}>
      {#if reasoning.summary.trim()}<Markdown
          text={reasoning.summary}
          {streaming}
          class="text-zinc-600 dark:text-zinc-400"
        />{/if}
      {#if reasoning.text.trim() && reasoning.text !== reasoning.summary}<Markdown
          text={reasoning.text}
          {streaming}
          class="text-zinc-500 dark:text-zinc-400"
        />{/if}
    </div>
  </Disclosure>
{/if}
