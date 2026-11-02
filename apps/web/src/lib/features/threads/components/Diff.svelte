<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DiffLines from "#lib/shared/ui/code/DiffLines.svelte";
  import type { LanguageId } from "#lib/shared/ui/code/languages.ts";

  /** Unified diff in a scrolling code surface, its code highlighted in `lang` (`DiffLines`). */
  let { diff, label, lang, class: className }: { diff: string; label: string; lang?: LanguageId | undefined; class?: ClassValue } = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class={["code-surface max-h-[32rem] rounded-lg bg-zinc-950/2.5 py-2 focus-ring dark:bg-white/5", className]} tabindex="0" role="region" aria-label={label}>
  <DiffLines {diff} {lang} />
</div>
