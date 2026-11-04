<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";
  import { languageOfDiff, parseDiff } from "./diff.ts";
  import { visibleDiffLines, splitDiffLines } from "./diff-layout.ts";
  import DiffLine from "./DiffLine.svelte";
  import { Highlight } from "./highlight.svelte.ts";
  import type { LanguageId } from "./languages.ts";

  let {
    diff,
    lang,
    streaming = false,
    class: className,
  }: { diff: string; lang?: LanguageId | undefined; streaming?: boolean; class?: ClassValue } = $props();

  const parsed = $derived(parseDiff(diff));
  const language = $derived(lang ?? languageOfDiff(diff));

  const next = new Highlight(
    () => parsed.next,
    () => language,
  );

  const old = new Highlight(
    () => parsed.old,
    () => language,
  );

  const lines = $derived(visibleDiffLines(parsed.lines, device.values.hideWhitespace === "on"));
  const split = $derived(device.values.diffLayout === "split");
  const rows = $derived(splitDiffLines(lines));
</script>

<div class={["min-w-full text-(--code-fg)", className]}>
  {#if lines.length < parsed.lines.length}<p class="px-3 font-sans text-xs/5 whitespace-normal text-zinc-500">
      Whitespace-only changes hidden.
    </p>{/if}
  {#if split}
    <div class="diff-split" aria-label="Side-by-side diff: original left, updated right">
      {#each rows as row, index (index)}
        {#if row.full}<div class="col-span-2 text-zinc-500"><DiffLine line={row.full} {old} {next} {streaming} /></div>
        {:else}<DiffLine line={row.left} {old} {next} {streaming} /><DiffLine
            line={row.right}
            {old}
            {next}
            {streaming}
          />{/if}
      {/each}
    </div>
  {:else}
    <div class="inline-block min-w-full">
      {#each lines as line, index (index)}<DiffLine {line} {old} {next} {streaming} />{/each}
    </div>
  {/if}
</div>
