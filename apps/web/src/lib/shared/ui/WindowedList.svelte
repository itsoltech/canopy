<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { SizeIndex } from "./virtual/size-index.ts";

  /**
   * A long list inside a page that scrolls as a whole (a settings pane): only the rows near the scroller's viewport
   * enter the DOM. Rows are measured as they mount; `estimate` sizes the others by `group`. The focused row stays
   * mounted, and the next rows are already there when keyboard focus scrolls it into view.
   */
  let {
    items,
    key,
    group,
    estimate,
    row,
    overscan = 480,
    class: className,
  }: {
    items: readonly T[];
    key: (item: T) => string;
    group: (item: T) => string;
    estimate: (group: string) => number;
    row: Snippet<[T]>;
    overscan?: number;
    class?: ClassValue;
  } = $props();

  // The index is plain state: `version` tells the layout that measurements changed.
  const sizes = new SizeIndex((name) => estimate(name));
  let version = $state(0);
  let list = $state<HTMLDivElement>();
  let top = $state(0);
  let height = $state(0);
  let focused = $state<string>();
  const rows = $derived(items.map((item) => ({ key: key(item), group: group(item) })));

  const layout = $derived.by(() => {
    void version;
    sizes.setRows(rows);
    let [start, end] = sizes.range(top - overscan, top + Math.max(height, 1) + overscan);
    const pinned = focused === undefined ? -1 : rows.findIndex((r) => r.key === focused);

    if (pinned >= 0) [start, end] = [Math.min(start, pinned), Math.max(end, pinned + 1)];

    return { start, end, offset: sizes.offset(start), total: sizes.total };
  });

  const visible = $derived(items.slice(layout.start, layout.end));

  function scrollParent(node: HTMLElement): HTMLElement | undefined {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
    }

    return undefined;
  }

  $effect(() => {
    if (!list) return;
    const node = list;
    const scroller = scrollParent(node);

    const update = () => {
      const view = scroller?.getBoundingClientRect() ?? { top: 0, height: innerHeight };
      top = view.top - node.getBoundingClientRect().top;
      height = view.height;
    };

    update();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    // Content above the list (an alert, a banner) moves it without a scroll.
    const observer = new ResizeObserver(update);

    for (const watched of [scroller, scroller?.firstElementChild]) if (watched) observer.observe(watched);

    return () => {
      target.removeEventListener("scroll", update);
      observer.disconnect();
    };
  });

  function measure(item: T) {
    return (node: HTMLElement) => {
      const observer = new ResizeObserver(([entry]) => {
        const size = entry?.borderBoxSize[0]?.blockSize;

        if (size && sizes.measure(key(item), group(item), size)) version++;
      });

      observer.observe(node);

      return () => observer.disconnect();
    };
  }

  const rowKey = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>("[data-row-key]")?.dataset["rowKey"] : undefined;
</script>

<div
  bind:this={list}
  class={["relative", className]}
  style:height="{layout.total}px"
  onfocusin={(event) => (focused = rowKey(event.target))}
  onfocusout={(event) => {
    if (!(event.relatedTarget instanceof Node && list?.contains(event.relatedTarget))) focused = undefined;
  }}
>
  <div class="absolute inset-x-0 top-0" style:translate="0 {layout.offset}px">
    {#each visible as item (key(item))}
      <div data-row-key={key(item)} {@attach measure(item)}>{@render row(item)}</div>
    {/each}
  </div>
</div>
