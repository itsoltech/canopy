<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";
  import { languageOfDiff, parseDiff } from "./diff.ts";
  import { visibleDiffLines, splitDiffLines } from "./diff-layout.ts";
  import DiffLine from "./DiffLine.svelte";
  import { Highlight } from "./highlight.svelte.ts";
  import type { LanguageId } from "./languages.ts";
  import type { DiffReview } from "./diff-review.ts";

  let {
    diff,
    lang,
    streaming = false,
    class: className,
    review,
  }: {
    diff: string;
    lang?: LanguageId | undefined;
    streaming?: boolean;
    class?: ClassValue;
    review?: DiffReview | undefined;
  } = $props();

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
        {:else}<DiffLine line={row.left} {old} {next} {streaming} {review} side="LEFT" /><DiffLine
            line={row.right}
            {old}
            {next}
            {streaming}
            {review}
            side="RIGHT"
          />{/if}
        {#if review?.editor && review.editorAfter !== undefined && (row.left?.anchor?.index === review.editorAfter || row.right?.anchor?.index === review.editorAfter)}
          <div class="col-span-2 min-w-0 font-sans whitespace-normal">{@render review.editor()}</div>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="inline-block min-w-full">
      {#each lines as line, index (index)}<DiffLine {line} {old} {next} {streaming} {review} />
        {#if review?.editor && review.editorAfter !== undefined && line.anchor?.index === review.editorAfter}
          <div class="min-w-0 font-sans whitespace-normal">{@render review.editor()}</div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
