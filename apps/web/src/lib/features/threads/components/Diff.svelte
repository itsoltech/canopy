<script lang="ts">
  import type { ClassValue, HTMLAttributes } from "svelte/elements";
  import DiffLines from "#lib/shared/ui/code/DiffLines.svelte";
  import type { LanguageId } from "#lib/shared/ui/code/languages.ts";

  /** Unified diff in a scrolling code surface, its code highlighted in `lang` (`DiffLines`). Other attributes go on the surface. */
  let {
    diff,
    label,
    lang,
    class: className,
    ...rest
  }: { diff: string; label: string; lang?: LanguageId | undefined; class?: ClassValue } & Omit<HTMLAttributes<HTMLDivElement>, "class"> = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div {...rest} class={["code-surface max-h-[32rem] rounded-lg bg-zinc-950/2.5 py-2 focus-ring dark:bg-white/5", className]} tabindex="0" role="region" aria-label={label}>
  <DiffLines {diff} {lang} />
</div>
