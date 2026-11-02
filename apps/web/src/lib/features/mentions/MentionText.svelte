<script lang="ts">
  import type { Mention } from "@open-agents/contracts";
  import { mentionLabel } from "@open-agents/domain";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { CHIP_CLASS, CHIP_ICON_CLASS, chipTitle, kindLook } from "./kinds.ts";

  /**
   * A sent message with its mentions as chips (the same look as in the composer). Text outside the mentions keeps
   * its line breaks; a mention whose range does not fit the text is shown as the text it covers.
   */
  let { text, mentions }: { text: string; mentions: readonly Mention[] } = $props();

  const parts = $derived.by(() => {
    const out: ({ text: string } | { mention: Mention })[] = [];
    let at = 0;
    for (const m of [...mentions].sort((a, b) => a.start - b.start)) {
      if (m.start < at || m.end > text.length || m.end <= m.start) continue;
      if (m.start > at) out.push({ text: text.slice(at, m.start) });
      out.push({ mention: m });
      at = m.end;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  });
</script>

<p class="whitespace-pre-wrap">
  {#each parts as part, i (i)}{#if "mention" in part}<span class={CHIP_CLASS} title={chipTitle(part.mention)}><Icon name={kindLook(part.mention).icon} class={CHIP_ICON_CLASS} /><span class="truncate">{mentionLabel(part.mention)}</span></span>{:else}{part.text}{/if}{/each}
</p>
