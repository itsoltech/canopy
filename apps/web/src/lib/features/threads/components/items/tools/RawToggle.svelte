<script lang="ts">
  import { prettyJson } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import { useRemembered } from "#lib/shared/ui/memory.ts";
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";

  /**
   * "Show raw": what the tool really got and returned, as JSON or text, for people who need it. Closed by
   * default; opens with the accordion motion (motion.ts `expand`) and stays as left while scrolled away.
   */
  let { parts }: { parts: readonly { label: string; text: string }[] } = $props();
  const shown = $derived(parts.filter((p) => p.text.trim() !== ""));
  const memory = useRemembered<boolean>("raw");
  let open = $state(memory?.get() ?? false);

  $effect(() => memory?.set(open));
</script>

{#if shown.length > 0}
  <div data-quote-skip class="grid">
    <MoreButton expanded={open} onclick={() => (open = !open)}>{open ? "Hide raw" : "Show raw"}</MoreButton>
    {#if open}
      <div transition:expand class="grid gap-2 pt-2">
        {#each shown as part (part.label)}
          <div class="grid gap-1">
            <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{part.label}</p>
            <CodeBlock text={prettyJson(part.text)} label={part.label} />
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
