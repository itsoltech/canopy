<script lang="ts">
  import { untrack } from "svelte";
  import type { SyntaxLine } from "@canopy/contracts";
  import type { WorkspaceFile } from "@canopy/domain/workspace-file";
  import { SourceIndex } from "@canopy/syntax/source";
  import { roleNames } from "@canopy/syntax/roles";
  import { gutterDigits, sourceShape } from "@canopy/syntax/layout";
  import { openHighlight } from "./highlight-client.ts";
  import type { HighlightClient } from "./highlight-client.ts";
  import type { FileNotice } from "./file-notice.ts";

  /**
   * The file's text, virtualised by line. Everything that sizes the frame (line height, font, gutter, plain or
   * highlighted) is fixed from the first paint; colours arrive later and never reflow. Notices go to the file bar
   * (`onnotice`) instead of rows above the text.
   */
  let {
    document,
    text,
    path,
    revision,
    highlight = $bindable(false),
    onnotice = () => {},
  }: {
    document: WorkspaceFile;
    text: string;
    path: string;
    revision: number;
    /** Colours a large file that opened as plain text. */
    highlight?: boolean;
    onnotice?: (notice: FileNotice | undefined) => void;
  } = $props();

  let source = $state.raw(new SourceIndex(""));
  const indexing = $derived(source.text !== text);

  const position = $derived.by(() => {
    void revision;

    return document.position;
  });

  const shape = $derived(sourceShape(text));
  const plain = $derived(shape.longest > 2000);

  // Vertical inset of the text inside the scroller; rows keep their positions relative to it.
  const inset = 8;

  let preparing = $state(false);
  let root = $state<HTMLDivElement>();
  let height = $state(500);
  let top = $state(0);
  let rowHeight = $state(24);
  let client = $state<HighlightClient>();
  let tokens = $state<ReadonlyMap<number, SyntaxLine>>(new Map());
  let tokenRevision = $state(0);

  const highlighted = $derived.by(() => {
    void tokenRevision;

    return (line: number) => tokens.get(line);
  });

  let note = $state("");

  /** Read exact source offsets, independent of highlighted spans and decorative line numbers. */
  export function selectedText(): string | undefined {
    const selection = getSelection();

    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);

    // The workspace's Select All selects the reader element and covers its mounted rows.
    if (
      root &&
      range.startContainer === root &&
      range.endContainer === root &&
      range.startOffset === 0 &&
      range.endOffset === root.childNodes.length
    ) {
      const start = rows[0];
      const end = rows.at(-1);

      return start && end ? text.slice(start.from, end.to) : undefined;
    }

    const offset = (node: Node, at: number) => {
      const element = node instanceof Element ? node : node.parentElement;
      const content = element?.closest<HTMLElement>("[data-source-from]");

      if (!content || !root?.contains(content)) return;
      const prefix = globalThis.document.createRange();
      prefix.selectNodeContents(content);
      prefix.setEnd(node, at);

      return Number(content.dataset.sourceFrom) + prefix.toString().length;
    };

    const start = offset(range.startContainer, range.startOffset);
    const end = offset(range.endContainer, range.endOffset);

    return start !== undefined && end !== undefined ? text.slice(start, end) : undefined;
  }

  function copySelection(event: ClipboardEvent) {
    if (event.defaultPrevented || !event.clipboardData) return;
    const selected = selectedText();

    if (selected === undefined) return;
    // Native copy follows the virtual row layout and can drop blank lines or add breaks to split lines.
    event.clipboardData.setData("text/plain", selected);
    event.preventDefault();
  }

  const first = $derived(Math.max(0, Math.floor(top / rowHeight) - 8));

  // Until the full index exists, the known line count holds the scroll height, so the scrollbar does not jump.
  const logicalHeight = $derived(Math.max(source.rows, shape.lines) * rowHeight + 2 * inset);
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
    note = "";
    // Short files index within a frame; only a slow index earns a notice.
    preparing = false;
    const slow = setTimeout(() => (preparing = source.text !== content), 300);

    return () => {
      cancelled = true;
      clearTimeout(slow);
    };
  });

  $effect(() => {
    if (!indexing) preparing = false;
  });

  $effect(() => {
    onnotice(
      preparing
        ? { text: "Preparing the file…", busy: true }
        : note
          ? { text: note }
          : plain && !highlight
            ? {
                text: "Plain text",
                detail: "Syntax highlighting is off by default for large files.",
                action: { label: "Enable highlighting", short: "Highlight", run: () => (highlight = true) },
              }
            : undefined,
    );
  });

  $effect(() => () => onnotice(undefined));

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
    root.scrollTop = Math.max(0, inset + row * rowHeight - 2 * rowHeight) / ratio;
    document.readerPositionRevision = revision;
  });

  $effect(() => {
    tokens = new Map();

    if (indexing || (plain && !highlight)) return;
    const current = openHighlight(path, text);
    client = current;
    tokens = current.tokens;
    const unsubscribe = current.subscribe(() => tokenRevision++);

    return () => {
      unsubscribe();
      current.close();
      client = undefined;
    };
  });

  $effect(() => {
    const current = client;
    const start = rows[0]?.line ?? 1;
    const end = rows.at(-1)?.line ?? start;
    let cancelled = false;

    if (!current) return;
    void current
      .window(start, Math.min(200, end - start + 1))
      .then((result) => {
        if (cancelled) return;
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={root}
  bind:clientHeight={height}
  role="region"
  aria-label={path}
  data-select-content
  tabindex="0"
  class="h-full min-h-0 overflow-auto overscroll-contain font-mono text-[length:var(--canopy-mono-size)] leading-[1.6] focus-ring select-text focus-visible:-outline-offset-2"
  style:color="var(--code-fg)"
  oncopy={copySelection}
  onscroll={() => {
    if (!root) return;
    top = root.scrollTop * ratio;
    if (!indexing) document.scroll = top;
  }}
>
  <div class="relative min-w-full" style:height={`${scrollHeight}px`}>
    {#each rows as row (row.index)}
      {@const line = highlighted(row.line)}
      {@const spans = row.continued ? [] : (line?.spans ?? [])}
      {@const selected = position && row.line >= position.line && row.line <= position.end}
      <div
        class={["absolute flex min-w-full whitespace-pre", selected && "bg-sky-500/10 dark:bg-sky-400/10"]}
        data-file-line={row.line}
        data-source-row={row.index}
        style:top={`${inset + row.index * rowHeight - top + top / ratio}px`}
        style:height={`${rowHeight}px`}
      >
        <span
          aria-hidden="true"
          data-quote-skip
          class={[
            "sticky left-0 z-1 shrink-0 bg-surface pr-4 pl-3 text-right select-none",
            selected
              ? "bg-linear-to-r from-sky-500/10 to-sky-500/10 text-sky-700 shadow-[inset_2px_0_0_var(--color-sky-500)] dark:from-sky-400/10 dark:to-sky-400/10 dark:text-sky-300"
              : "text-zinc-400 dark:text-zinc-500",
          ]}
          style:width={`calc(${gutterDigits(shape.lines)}ch + 1.75rem)`}>{row.continued ? "↳" : row.line}</span
        >
        <span data-select-content data-source-from={row.from} class="pr-4 selection:bg-sky-500/25"
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
