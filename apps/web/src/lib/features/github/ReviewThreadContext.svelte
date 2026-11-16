<script lang="ts">
  import type { github } from "@canopy/contracts";
  import { parseDiff } from "#lib/shared/ui/code/diff.ts";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import { Highlight } from "#lib/shared/ui/code/highlight.svelte.ts";
  import DiffLine from "#lib/shared/ui/code/DiffLine.svelte";

  let { thread }: { thread: github.PullRequestReviewThread } = $props();

  const parsed = $derived(parseDiff(thread.comments[0]?.diffHunk ?? ""));
  const language = $derived(languageOfPath(thread.path));

  const old = new Highlight(
    () => parsed.old,
    () => language,
  );

  const next = new Highlight(
    () => parsed.next,
    () => language,
  );

  const lines = $derived.by(() => {
    const end = thread.originalLine || thread.line;
    const start = thread.originalStartLine || thread.startLine || end;
    const side = thread.side === "LEFT" ? "left" : "right";
    const last = parsed.lines.findIndex((line) => line.anchor?.[side] === end);
    const first = parsed.lines.findIndex((line) => line.anchor?.[side] === start);

    if (!end || last < 0) return [];

    return parsed.lines
      .slice(Math.max(0, (first < 0 ? last : first) - 2), last + 3)
      .filter((line) => line.anchor?.left || line.anchor?.right);
  });
</script>

{#if lines.length}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="diff-surface max-h-48 code-surface rounded-md border border-zinc-950/10 bg-zinc-950/2.5 py-1 focus-ring dark:border-white/10 dark:bg-white/5"
    role="region"
    aria-label={`Code at ${thread.path}`}
    tabindex="0"
  >
    <div class="diff-lines min-w-max text-(--code-fg)">
      {#each lines as line, index (index)}
        <div class="flex" data-kind={line.kind}>
          <span class="w-10 shrink-0 px-2 text-right text-zinc-500 select-none" aria-hidden="true"
            >{line.anchor?.left || ""}</span
          >
          <span class="w-10 shrink-0 px-2 text-right text-zinc-500 select-none" aria-hidden="true"
            >{line.anchor?.right || ""}</span
          >
          <div class="min-w-0 flex-1"><DiffLine {line} {old} {next} /></div>
        </div>
      {/each}
    </div>
  </div>
{/if}
