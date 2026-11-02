<script lang="ts">
  /**
   * Text with some characters marked (search matches): `indices` are positions in `text`. Consecutive
   * marks share one `<mark>`, so screen readers read the words whole.
   */
  let { text, indices }: { text: string; indices: readonly number[] } = $props();

  const parts = $derived.by(() => {
    if (indices.length === 0) return [{ text, marked: false }];
    const marked = new Set(indices);
    const out: { text: string; marked: boolean }[] = [];
    for (let i = 0; i < text.length; i++) {
      const on = marked.has(i);
      const last = out.at(-1);
      if (last && last.marked === on) last.text += text[i];
      else out.push({ text: text[i]!, marked: on });
    }
    return out;
  });
</script>

{#each parts as part, index (index)}{#if part.marked}<mark class="bg-transparent font-medium text-brand-600 dark:text-brand-400">{part.text}</mark>{:else}{part.text}{/if}{/each}
