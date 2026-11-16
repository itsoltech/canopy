<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { ThreadDiffLineKind as Kind, type ThreadDiffFile, type ThreadDiffLine } from "./diff-api.ts";
  import { diffFileStatus } from "./diff-layout.ts";
  import type { DiffComment } from "./diff-drafts.svelte.ts";

  let {
    file,
    offset,
    line,
    oncomment,
    class: className,
  }: {
    file: ThreadDiffFile;
    offset: number;
    line?: ThreadDiffLine;
    oncomment: (side: DiffComment["side"], line: number, source: string) => void;
    class?: ClassValue;
  } = $props();

  const commentable = $derived(
    line && (line.kind === Kind.CONTEXT || line.kind === Kind.ADDITION || line.kind === Kind.DELETION),
  );
</script>

{#if offset === -1}
  <div
    class={[
      "flex h-full w-full min-w-0 items-center gap-3 border-y border-divider bg-surface px-3 font-sans text-base sm:text-sm",
      className,
    ]}
  >
    <span class="shrink-0 text-sm text-muted sm:text-xs">{diffFileStatus(file.status)}</span>
    <span class="min-w-0 truncate font-medium" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span
    >
    {#if file.binary}
      <span class="shrink-0 text-sm text-muted sm:text-xs">Binary</span>
    {:else}
      <span
        class="shrink-0 font-mono text-sm tabular-nums sm:text-xs"
        aria-label={`${file.additions} additions, ${file.deletions} deletions`}
      >
        <span class="text-emerald-700 dark:text-emerald-300">+{file.additions.toLocaleString()}</span>
        <span class="text-rose-700 dark:text-rose-300">−{file.deletions.toLocaleString()}</span>
      </span>
    {/if}
  </div>
{:else if !file.lineCount}
  <p class={["px-3 font-sans text-sm text-muted", className]}>
    {file.binary ? "Binary file changed" : "File metadata changed"}
  </p>
{:else if !line}
  <div class={["flex h-full items-center px-3 font-sans text-sm text-muted", className]} aria-hidden="true">
    Loading lines…
  </div>
{:else}
  <div
    class={[
      "flex h-full min-w-full items-center whitespace-pre",
      className,
      line.kind === Kind.ADDITION && "bg-emerald-500/10 dark:bg-emerald-400/10",
      line.kind === Kind.DELETION && "bg-rose-500/10 dark:bg-rose-400/10",
      line.kind === Kind.HUNK && "bg-sky-500/8 text-sky-800 dark:bg-sky-400/8 dark:text-sky-300",
      line.kind === Kind.META && "text-muted",
    ]}
  >
    <span
      class="sticky left-0 z-1 flex h-full shrink-0 items-center bg-surface text-sm text-muted tabular-nums select-none"
    >
      {#each ["old", "new"] as side}
        {@const number = side === "old" ? line.oldLine : line.newLine}
        {#if number && commentable}
          <button
            type="button"
            class="h-full w-14 shrink-0 px-1 text-right focus-ring hover:bg-zinc-950/6 focus-visible:-outline-offset-2 dark:hover:bg-white/10"
            aria-label={`Comment on ${file.path}, ${side === "old" ? "original" : "changed"} line ${number}`}
            onclick={() => oncomment(side === "old" ? "old" : "new", number, line.text)}>{number}</button
          >
        {:else}<span class="w-14 shrink-0 px-1 text-right">{number ?? ""}</span>{/if}
      {/each}
      <span aria-hidden="true" class="w-6 text-center"
        >{line.kind === Kind.ADDITION ? "+" : line.kind === Kind.DELETION ? "−" : ""}</span
      >
    </span>
    <span class="pr-4 selection:bg-sky-500/25">{line.text}</span>
  </div>
{/if}
