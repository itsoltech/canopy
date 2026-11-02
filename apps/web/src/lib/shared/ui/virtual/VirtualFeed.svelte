<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import { tick, untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import Button from "../Button.svelte";
  import { rise } from "../motion.ts";
  import { UiMemory } from "../memory.ts";
  import { SizeIndex } from "./size-index.ts";
  import VirtualRow from "./VirtualRow.svelte";

  /**
   * A chat's scroll area: one scroll container with the rows (`role="feed"`, virtualized) and a sticky
   * `footer` (the composer) at the bottom of the chat column, with a fade above it and "Jump to latest".
   *
   * - Only the rows near the viewport are mounted; the others are padding sized from measurements
   *   (ResizeObserver, kept by key) or the average of their group.
   * - While the reader is at the bottom it stays there (new rows, streaming growth, a taller composer,
   *   the keyboard opening); once they scroll up, the first visible row keeps its place on screen when
   *   rows above change height or are added (also prepended older history).
   * - The first snapshot mounts its last rows; a layout effect pins them before the browser paints.
   * - `placeholder` stands where the rows will be while there are none (a skeleton, bottom-aligned
   *   above the footer like the end of the feed); the first rows after it resolve in. Rows added at the
   *   end later rise in once, when they first mount (`VirtualRow` `enter`); rows mounted by scrolling,
   *   prepended history do not. Rows inserted between shown ones enter only
   *   as `inserted` says (e.g. a fold that opened: its rows unfold, staggered). "Jump to latest" rises
   *   in and out.
   * - Keyboard: the scroll area is focusable (Page Up/Down, Home/End scroll it); inside a row, Page
   *   Up/Down move to the previous/next row (WAI-ARIA feed), Ctrl+End to the composer, Ctrl+Home back
   *   to the scroll area. A focused row stays mounted.
   */
  let {
    rows,
    key,
    group,
    estimate,
    label,
    busy = false,
    top,
    placeholder,
    row,
    footer,
    inserted,
    atEnd = $bindable(true),
  }: {
    rows: readonly T[];
    key: (row: T) => string;
    /** Rows of a group have similar heights (e.g. the row's kind): unmeasured rows take the group's average. */
    group: (row: T) => string;
    /** Height of a group before any of its rows was measured, in px. */
    estimate: (group: string) => number;
    label: string;
    busy?: boolean;
    top?: Snippet;
    /** In place of the rows while there are none (loading). */
    placeholder?: Snippet;
    row: Snippet<[T, number]>;
    footer?: Snippet;
    /** How a row inserted between shown rows enters (none by default: e.g. older history above). */
    inserted?: (row: T) => "unfold" | "reveal" | undefined;
    /** Out: the reader follows the end (the latest rows are on screen). */
    atEnd?: boolean;
  } = $props();

  const uid = $props.id();
  const id = `feed-${uid}`;
  /** Enough rows from the end to fill the viewport before its first measurement. */
  const INITIAL_HEIGHT = 2400;
  const memory = new UiMemory();
  const index = new SizeIndex((name) => untrack(() => estimate(name)));

  let scroller = $state<HTMLElement>();
  let list = $state<HTMLElement>();
  let footerElement = $state<HTMLElement>();
  /** Viewport height; 0 until measured (server, hydration): then the last rows render. */
  let viewport = $state(0);
  let scrollTop = $state(0);
  let listTop = $state(0);
  let footerHeight = $state(0);
  /** Width of the scroller's vertical scrollbar (the backdrop under the composer stops before it). */
  let gutter = $state(0);
  let measured = $state(0);
  /** Following the end (the reader is at the bottom). */
  let stuck = $state(true);
  $effect(() => {
    atEnd = stuck;
  });
  let focusedKey = $state<string>();
  /** The first row at the top of the viewport and its distance from the top edge. */
  let anchor: { key: string; element: HTMLElement; top: number } | undefined;

  const sized = $derived(rows.map((r) => ({ key: key(r), group: group(r) })));
  const positions = $derived(new Map(sized.map((r, i) => [r.key, i])));
  const layout = $derived.by(() => {
    void measured;
    index.setRows(sized);
    return { total: index.total, count: sized.length };
  });
  const range = $derived.by((): [number, number] => {
    void layout;
    void scrollTop;
    if (viewport === 0) return index.tail(INITIAL_HEIGHT);
    const overscan = Math.max(viewport, 480);
    // Reading above: the window follows the anchor row, also when rows were added or resized above it
    // (its scroll position is corrected only once it is mounted).
    const at = anchor && positions.get(anchor.key);
    const top = at === undefined || !anchor ? scrollTop : listTop + index.offset(at) - anchor.top;
    let [start, end] = stuck ? index.tail(viewport + 2 * overscan) : index.range(top - listTop - overscan, top - listTop + viewport + overscan);
    const focused = focusedKey === undefined ? undefined : positions.get(focusedKey);
    // Keep a focused row mounted (not across a long jump away).
    if (focused !== undefined && focused >= start - 100 && focused < end + 100) {
      start = Math.min(start, focused);
      end = Math.max(end, focused + 1);
    }
    return [start, end];
  });
  const padTop = $derived.by(() => (void layout, index.offset(range[0])));
  const padBottom = $derived.by(() => (void layout, layout.total - index.offset(range[1])));
  const visible = $derived(rows.slice(range[0], range[1]));

  // --- New rows ---------------------------------------------------------------------------------------
  /** Keys shown so far (undefined until the first rows); rows that arrive later enter until they mount. */
  let known: Set<string> | undefined;
  /** The feed started empty (client navigation): its first rows replace the placeholder. */
  const startedEmpty = untrack(() => rows.length === 0);
  const entering = new Map<string, { kind: "rise" | "reveal" | "unfold"; order: number }>();
  let enterFrame = 0;
  $effect.pre(() => {
    const keys = sized.map((r) => r.key);
    if (keys.length === 0) return;
    if (known) {
      let last = -1;
      keys.forEach((rowKey, at) => {
        if (known?.has(rowKey)) last = at;
      });
      let order = 0;
      keys.forEach((rowKey, at) => {
        if (known?.has(rowKey)) return;
        if (at > last) entering.set(rowKey, { kind: "rise", order: 0 });
        else {
          const kind = inserted?.(rows[at] as T);
          if (kind) entering.set(rowKey, { kind, order: order++ });
        }
      });
    } else if (startedEmpty) for (const rowKey of keys) entering.set(rowKey, { kind: "reveal", order: 0 });
    // What did not mount with this update (scrolled away) is not new any more.
    cancelAnimationFrame(enterFrame);
    enterFrame = requestAnimationFrame(() => entering.clear());
    known = new Set(keys);
  });
  /** How a row enters the first time it mounts (once), if it is new. */
  function takeEnter(rowKey: string) {
    const enter = entering.get(rowKey);
    entering.delete(rowKey);
    return enter;
  }

  // --- Measuring ------------------------------------------------------------------------------------
  const elements = new Map<string, HTMLElement>();
  let commitFrame = 0;
  let measuredViewport = 0;
  let measuredFooter = 0;
  // Reactive updates from measurements wait for the next frame: changing the DOM inside the observer
  // callback would postpone the new rows' notifications (a ResizeObserver loop).
  const commit = () => {
    commitFrame ||= requestAnimationFrame(() => {
      commitFrame = 0;
      measured++;
      viewport = measuredViewport;
      footerHeight = measuredFooter;
      if (scroller) gutter = scroller.offsetWidth - scroller.clientWidth;
      if (scroller && list) listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    });
  };
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            const target = entry.target as HTMLElement;
            const height = entry.borderBoxSize[0]?.blockSize ?? target.offsetHeight;
            if (target === scroller) measuredViewport = target.clientHeight;
            else if (target === footerElement) measuredFooter = height;
            else if (target.dataset.key) {
              const at = positions.get(target.dataset.key);
              const meta = at === undefined ? undefined : sized[at];
              if (meta) index.measure(meta.key, meta.group, height);
            }
          }
          settle();
          commit();
        });

  const measure: Attachment<HTMLElement> = (element) => {
    const rowKey = element.dataset.key ?? "";
    elements.set(rowKey, element);
    observer?.observe(element);
    return () => {
      observer?.unobserve(element);
      if (elements.get(rowKey) === element) elements.delete(rowKey);
    };
  };

  $effect(() => {
    if (!observer || !scroller || !list || !footerElement) return;
    for (const element of [scroller, list, footerElement]) observer.observe(element);
    return () => {
      for (const element of [scroller, list, footerElement]) if (element) observer.unobserve(element);
    };
  });
  $effect(() => () => {
    observer?.disconnect();
    cancelAnimationFrame(commitFrame);
    cancelAnimationFrame(enterFrame);
  });
  // After every DOM change of the window: keep the reader's place (or the end).
  $effect(() => {
    void padTop;
    void padBottom;
    void visible;
    untrack(settle);
  });

  // --- Keeping the place ----------------------------------------------------------------------------
  /** scrollTop we set ourselves (its scroll event is not the reader's). */
  let expected = Number.NaN;
  let lastTop = 0;
  let smoothUntil = 0;

  function setTop(value: number) {
    if (!scroller) return;
    scroller.scrollTop = value;
    expected = scroller.scrollTop;
    lastTop = expected;
  }

  function settle() {
    if (!scroller || !list) return;
    // The reader scrolled and its scroll event is still to come: take it in first, or the old anchor
    // would undo the scroll.
    if (Math.abs(scroller.scrollTop - lastTop) >= 1) onscroll();
    if (stuck) {
      if (performance.now() < smoothUntil) return;
      const end = scroller.scrollHeight - scroller.clientHeight;
      if (Math.abs(scroller.scrollTop - end) >= 1) setTop(end);
      return;
    }
    const element = anchor && (anchor.element.isConnected ? anchor.element : elements.get(anchor.key));
    if (anchor && element) {
      anchor.element = element;
      const delta = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) >= 0.5) setTop(scroller.scrollTop + delta);
    } else capture();
  }

  function capture() {
    if (!scroller || !list) return;
    const edge = scroller.getBoundingClientRect().top;
    const children = list.children;
    let low = 0;
    let high = children.length - 1;
    // The first mounted row whose bottom is below the top edge (rows are in order).
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((children[middle] as HTMLElement).getBoundingClientRect().bottom > edge + 1) high = middle;
      else low = middle + 1;
    }
    const element = children[low] as HTMLElement | undefined;
    anchor = element?.dataset.key ? { key: element.dataset.key, element, top: element.getBoundingClientRect().top - edge } : undefined;
  }

  function onscroll() {
    if (!scroller) return;
    const top = scroller.scrollTop;
    const ours = Math.abs(top - expected) < 1;
    expected = Number.NaN;
    if (!ours) {
      const distance = scroller.scrollHeight - top - scroller.clientHeight;
      if (distance <= 8) stuck = true;
      else if (top < lastTop - 0.5) stuck = false;
    }
    lastTop = top;
    scrollTop = top;
    if (!stuck) capture();
  }

  function onwheel(event: WheelEvent) {
    // Scrolling up during a stream: let go at once, before the next growth pins the end again.
    if (event.deltaY < 0 && scroller && scroller.scrollHeight > scroller.clientHeight + 8) stuck = false;
  }

  function onscrollend() {
    smoothUntil = 0;
    settle();
  }

  function jump() {
    if (!scroller) return;
    stuck = true;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const smooth = distance < viewport * 2 && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (smooth) {
      smoothUntil = performance.now() + 1000;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    } else setTop(scroller.scrollHeight);
  }

  // --- Keyboard ---------------------------------------------------------------------------------------
  async function focusRow(at: number) {
    const rowKey = index.keyAt(at);
    if (rowKey === undefined || !scroller) return;
    focusedKey = rowKey;
    await tick();
    const element = elements.get(rowKey);
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: element.offsetHeight > scroller.clientHeight - footerHeight ? "start" : "nearest" });
  }

  /**
   * Scrolls to the row with this key and focuses it (e.g. "N running in background" jumping to a task);
   * the reader stops following the end. False when no row has the key.
   */
  export async function reveal(rowKey: string): Promise<boolean> {
    const at = positions.get(rowKey);
    if (at === undefined || !scroller) return false;
    stuck = false;
    anchor = undefined;
    // Near its estimated place first, so the window mounts it; then exactly onto it.
    setTop(Math.max(0, listTop + index.offset(at) - 8));
    scrollTop = scroller.scrollTop;
    await focusRow(at);
    return true;
  }

  /**
   * The rows the reader is on: the focused one and, while they are not following the end (scrolled up),
   * the rows on screen above the footer. Empty while following the end with nothing focused.
   */
  export function reading(): string[] {
    const keys = focusedKey === undefined ? [] : [focusedKey];
    if (stuck || !scroller) return keys;
    const box = scroller.getBoundingClientRect();
    const bottom = box.bottom - footerHeight;
    for (const [rowKey, element] of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > box.top && rect.top < bottom && rowKey !== focusedKey) keys.push(rowKey);
    }
    return keys;
  }

  /**
   * Makes this row (mounted, on screen) the one that keeps its place while the reader is scrolled up,
   * e.g. before rows are inserted above it that would otherwise push it down.
   */
  export function hold(rowKey: string): void {
    const element = elements.get(rowKey);
    if (stuck || !scroller || !element) return;
    anchor = { key: rowKey, element, top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
  }

  function onkeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (event.ctrlKey && event.key === "End") {
      event.preventDefault();
      // The message box first, else the first control of the footer.
      const field = footerElement?.querySelector<HTMLElement>("textarea:not([disabled])") ?? footerElement?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])");
      field?.focus();
      return;
    }
    if (event.ctrlKey && event.key === "Home") {
      event.preventDefault();
      scroller?.focus({ preventScroll: true });
      return;
    }
    if (event.key !== "PageDown" && event.key !== "PageUp") return;
    // Text fields and scrollable code keep their own Page keys.
    if (target.closest("pre, textarea, input, select, [contenteditable]")) return;
    const current = target.closest<HTMLElement>("article[data-key]")?.dataset.key;
    const at = current === undefined ? undefined : positions.get(current);
    if (at === undefined) return;
    event.preventDefault();
    void focusRow(at + (event.key === "PageDown" ? 1 : -1));
  }

  function onfocusin(event: FocusEvent) {
    focusedKey = (event.target as HTMLElement).closest<HTMLElement>("article[data-key]")?.dataset.key;
  }
  function onfocusout(event: FocusEvent) {
    if (!list?.contains(event.relatedTarget as Node | null)) focusedKey = undefined;
  }
</script>

<div class="relative h-full">
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={scroller}
  {id}
  class="relative h-full scroll-pt-2 scroll-pb-(--feed-footer) overflow-y-auto overscroll-contain [overflow-anchor:none] focus-visible:outline-none"
  style:--feed-footer="{footerHeight}px"
  role="region"
  aria-label={label}
  tabindex="0"
  {onscroll}
  {onscrollend}
  {onwheel}
>
  <div class="mx-auto flex min-h-full max-w-(--chat-width) flex-col px-4 sm:px-6">
    {@render top?.()}
    <div class="flex grow flex-col pt-2 pb-8">
      {#if rows.length === 0 && placeholder}<div class="mt-auto">{@render placeholder()}</div>{/if}
      <!-- Keys and focus bubble up from the focusable articles (WAI-ARIA feed). -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        bind:this={list}
        role="feed"
        aria-label={label}
        aria-busy={busy}
        style:padding-top="{padTop}px"
        style:padding-bottom="{padBottom}px"
        {onkeydown}
        {onfocusin}
        {onfocusout}
      >
        {#each visible as item, offset (key(item))}
          <VirtualRow key={key(item)} position={range[0] + offset + 1} count={sized.length} {memory} {measure} enter={takeEnter(key(item))}>
            {@render row(item, range[0] + offset)}
          </VirtualRow>
        {/each}
      </div>
    </div>
    <div bind:this={footerElement} class="sticky bottom-0 z-10 pb-[max(--spacing(3),env(safe-area-inset-bottom))]">
      {#if !stuck}
        <div class="absolute bottom-full left-1/2 mb-3 -translate-x-1/2" transition:rise>
          <Button size="sm" icon="arrow-down" class="shadow-md dark:shadow-none" onclick={jump}>Jump to latest</Button>
        </div>
      {/if}
      {@render footer?.()}
    </div>
  </div>
</div>
<!-- Under the composer and its fade, across the whole width of the scroll area (not just the chat column), so
     content wider than the column (list numbers, wide tables) never shows beside or under the composer. Outside
     the scroller, it adds no scrollable overflow; it stops before the scrollbar and sits between the rows and the
     sticky footer (z-10). -->
{#if footerHeight > 0}
<div
  class="pointer-events-none absolute bottom-0 left-0 z-[5] bg-linear-to-t from-white from-[calc(100%-2rem)] to-transparent dark:from-black"
  style:right="{gutter}px"
  style:height="calc({footerHeight}px + 2rem)"
  aria-hidden="true"
></div>
{/if}
</div>
