<script lang="ts">
  import { untrack } from "svelte";
  import type { SyntaxLine } from "@canopy/contracts";
  import type { WorkspaceFile } from "@canopy/domain/workspace-file";
  import { SourceIndex } from "@canopy/syntax/source";
  import { roleNames } from "@canopy/syntax/roles";
  import { openHighlight } from "./highlight-client.ts";
  import type { HighlightClient } from "./highlight-client.ts";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    document,
    text,
    path,
    revision,
  }: {
    document: WorkspaceFile;
    text: string;
    path: string;
    revision: number;
  } = $props();

  let source = $state.raw(new SourceIndex(""));
  const indexing = $derived(source.text !== text);

  const position = $derived.by(() => {
    void revision;

    return document.position;
  });

  const plain = $derived(
    new TextEncoder().encode(text).length > 200 * 1024 || source.lines > 10_000 || source.longest > 2000,
  );

  let enabled = $state(false);
  let root = $state<HTMLDivElement>();
  let height = $state(500);
  let top = $state(0);
  let rowHeight = $state(24);
  let client = $state<HighlightClient>();
  let tokens = $state<ReadonlyMap<number, SyntaxLine>>(new Map());
  let note = $state("");
  const first = $derived(Math.max(0, Math.floor(top / rowHeight) - 8));
  const logicalHeight = $derived(source.rows * rowHeight);
  const scrollHeight = $derived(Math.min(8_000_000, logicalHeight));
  const ratio = $derived(Math.max(1, (logicalHeight - height) / Math.max(1, scrollHeight - height)));
  const count = $derived(Math.min(120, Math.ceil(height / rowHeight) + 16));

  const rows = $derived(
    Array.from({ length: Math.min(count, source.rows - first) }, (_, offset) => {
      const index = first + offset;

      return { index, ...source.row(index) };
    }),
  );

  $effect(() => {
    const content = text;
    source = new SourceIndex(content.slice(0, 8192));
    let cancelled = false;

    const yieldWork = () =>
      new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          if (cancelled) reject(new Error("Indexing was cancelled."));
          else resolve();
        }, 0),
      );

    void SourceIndex.create(content, yieldWork)
      .then((index) => {
        if (!cancelled) source = index;
      })
      .catch(() => {});
    enabled = false;
    note = "";

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const element = root;
    void source;

    if (!element) return;
    // Measure before the first line jump; the user's type scale may differ from the fallback.
    height = element.clientHeight;
    rowHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 24;
    element.scrollTop = untrack(() => document.scroll / ratio);

    const resize = new ResizeObserver(() => {
      height = element.clientHeight;
      rowHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 24;
    });

    resize.observe(element);

    return () => resize.disconnect();
  });

  $effect(() => {
    void revision;
    const index = source;

    if (!root || indexing || !position || document.readerPositionRevision === revision || position.line > index.lines)
      return;
    const row = index.rowForLine(position.line);
    root.scrollTop = Math.max(0, row * rowHeight - 2 * rowHeight) / ratio;
    document.readerPositionRevision = revision;
  });

  $effect(() => {
    tokens = new Map();

    if (indexing || (plain && !enabled)) return;
    const current = openHighlight(path, text);
    client = current;

    return () => {
      current.close();
      client = undefined;
    };
  });

  $effect(() => {
    const current = client;
    const start = rows[0]?.line ?? 1;
    const end = rows.at(-1)?.line ?? start;
    let cancelled = false;
    tokens = new Map();

    if (!current) return;
    void current
      .window(start, Math.min(200, end - start + 1))
      .then((result) => {
        if (cancelled) return;
        tokens = new Map(result.lines.map((line) => [line.line, line]));
        note = result.reason;
      })
      .catch(() => {
        if (!cancelled) note = "Highlighting is unavailable. The file remains readable.";
      });

    return () => {
      cancelled = true;
    };
  });
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if indexing}<p role="status" class="shrink-0 px-3 text-sm text-muted">Preparing the rest of the file…</p>{/if}
  {#if plain || note}<div class="flex min-h-8 shrink-0 items-center gap-2 px-3 text-sm text-muted" role="status">
      <span>{note || "Large files are shown as plain text to keep them responsive."}</span>
      {#if plain && !enabled}<Button size="sm" variant="ghost" onclick={() => (enabled = true)}
          >Enable highlighting</Button
        >{/if}
    </div>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={root}
    bind:clientHeight={height}
    role="region"
    aria-label={path}
    tabindex="0"
    class="min-h-0 flex-1 overflow-auto overscroll-contain font-mono text-[length:var(--canopy-mono-size)] leading-[1.6] focus-ring"
    style:color="var(--code-fg)"
    onscroll={() => {
      if (!root) return;
      top = root.scrollTop * ratio;
      if (!indexing) document.scroll = top;
    }}
  >
    <div class="relative min-w-full" style:height={`${scrollHeight}px`}>
      {#each rows as row (row.index)}
        {@const line = tokens.get(row.line)}
        {@const spans = row.continued ? [] : (line?.spans ?? [])}
        {@const selected = position && row.line >= position.line && row.line <= position.end}
        <div
          class={["absolute flex min-w-full whitespace-pre", selected && "bg-sky-500/10"]}
          data-file-line={row.line}
          data-source-row={row.index}
          style:top={`${row.index * rowHeight - top + top / ratio}px`}
          style:height={`${rowHeight}px`}
        >
          <span
            aria-hidden="true"
            data-quote-skip
            class="sticky left-0 z-1 shrink-0 bg-surface pr-3 pl-3 text-right text-muted select-none"
            style:width={`${String(source.lines).length + 3}ch`}>{row.continued ? "↳" : row.line}</span
          >
          <span data-select-content class="pr-3"
            >{#each spans as span, index (`${row.line}:${span.from}`)}{text.slice(
                row.from + (spans[index - 1]?.to ?? 0),
                row.from + span.from,
              )}<span style:color={`var(--code-${roleNames[span.role]})`}
                >{text.slice(row.from + span.from, row.from + span.to)}</span
              >{/each}{text.slice(row.from + (spans.at(-1)?.to ?? 0), row.to)}</span
          >
        </div>
      {/each}
    </div>
  </div>
</div>
