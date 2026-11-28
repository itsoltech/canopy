<script lang="ts" generics="T">
  import { motionPreferences } from "#lib/shared/ui/motion-preferences.svelte.ts";
  import { FeedHandoff } from "./feed-handoff.ts";
  import type { VirtualFeedProps } from "./feed-props.ts";
  import { tick, untrack } from "svelte";
  import { on } from "svelte/events";
  import { whenIdle } from "../../idle.ts";
  import FeedFooterActions from "./FeedFooterActions.svelte";
  import { UiMemory } from "../memory.ts";
  import { captureAnchor, holdAnchor, readingKeys, settleAnchor, type FeedAnchor } from "./feed-anchor.ts";
  import { followScroll } from "./feed-anchor.ts";
  import { FeedEntrances } from "./feed-entrances.ts";
  import { EndScroll } from "./end-scroll.ts";
  import { FeedMeasurements, observeFeed, publishViewport, rowAttachment } from "./feed-measure.ts";
  import { FeedRows } from "./feed-rows.ts";
  import { COLD_OVERSCAN, feedRange, OVERSCAN_STEP, rowAlignmentSpace } from "./feed-range.ts";
  import { feedRowKey, focusFeedRow, handleFeedScrollKey, navigateFeedKey } from "./feed-keys.ts";
  import { SizeIndex } from "./size-index.ts";
  import VirtualRow from "./VirtualRow.svelte";
  import { FEED_END_THRESHOLD, followingAfterScroll, ScrollIntent, scrollOrigin } from "./scroll.ts";
  import { FeedExtent } from "./feed-extent.svelte.ts";
  import { trackEmbedHover } from "./embed-hover.ts";
  import { watchFooterEdge } from "./footer-edge.ts";
  import { FooterReserve } from "./footer-reserve.ts";
  import { FeedScrollOpening } from "./feed-scroll-memory.svelte.ts";
  import { answerStart, moveToAnswer } from "./answer-scroll.ts";

  /**
   * A chat's scroll area: one scroll container with the rows (`role="feed"`, virtualized) and an overlay
   * `footer` (the composer) at the bottom of the chat column, with a fade above it and "Jump to latest".
   *
   * - Only the rows near the viewport are mounted; the others are padding sized from measurements
   *   (ResizeObserver, kept by key) or the average of their group.
   * - While the reader is at the bottom it stays there (new rows, streaming growth,
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
    footerAccessory,
    footerFit = { fold: "open", margin: 0 },
    inserted,
    atEnd = $bindable(true),
    onreaderscroll,
    onreaderscrollend,
    onlatest,
    onviewport,
    scrollMemory,
    sizes,
    loading = false,
    ready = true,
    onready,
  }: VirtualFeedProps<T> = $props();

  const uid = $props.id();
  const id = `feed-${uid}`;

  const memory = new UiMemory();
  const index = untrack(() => sizes) ?? new SizeIndex((name) => untrack(() => estimate(name)));

  let scroller = $state<HTMLElement>();
  let list = $state<HTMLElement>();
  let footerElement = $state<HTMLElement>();
  let footerShell = $state<HTMLElement>();

  /** Viewport height; 0 until measured (server, hydration): then the last rows render. */
  let viewport = $state(0);
  let scrollTop = $state(0);
  let listTop = $state(0);

  /** The end space under the rows: the footer's full height plus `footerMargin`, not its current height. */
  let footerHeight = $state(0);
  const footerReserve = new FooterReserve((height) => (footerHeight = height));

  /** From the footer's bottom to its visible top edge (footer-edge.ts). */
  let footerEdge = $state(0);

  /** Width reserved by the scroller for a classic scrollbar. */
  let gutter = $state(0);
  let measured = $state(0);

  /** Following the end (the reader is at the bottom); a saved reading position starts away from it. */
  let stuck = $state(untrack(() => scrollMemory?.initial?.mode !== "anchor"));
  const opening = new FeedScrollOpening(untrack(() => scrollMemory));

  $effect(() => opening.connect(() => ({ following: stuck, anchor })));

  $effect(() => {
    if (!loading && !opening.positioned) return opening.startDeadline(settle);
  });

  // The overscan (most of it above the end, where the reader starts) grows to its full size in idle-time
  // steps after the first rows were measured, instead of rendering in the frame that opens the thread.
  let overscanLimit = $state(COLD_OVERSCAN);
  const fullOverscan = $derived(Math.max(viewport, 480));
  const shown = $derived(viewport > 0 && rows.length > 0);

  $effect(() => {
    if (!shown || overscanLimit >= fullOverscan) return;

    return whenIdle(() => (overscanLimit = Math.min(fullOverscan, overscanLimit + OVERSCAN_STEP)), 1000);
  });

  const extent = new FeedExtent();

  $effect(() => void (atEnd = stuck || !extent.overflows));

  let focusedKey = $state<string>();

  /** The first row at the top of the viewport and its distance from the top edge. */
  let anchor: FeedAnchor | undefined;

  const structure = new FeedRows<T>();
  const sized = $derived(structure.update(rows, key, group));
  const positions = $derived(new Map(sized.map((r, i) => [r.key, i])));

  const layout = $derived.by(() => {
    void measured;
    index.setRows(sized);

    return { total: index.total, count: sized.length };
  });

  const range = $derived.by((): [number, number] => {
    void layout;

    return feedRange(index, positions, {
      viewport,
      scrollTop,
      listTop,
      anchor: anchor && { ...anchor, key: scrollMemory?.key?.(anchor.identity ?? anchor.key) ?? anchor.key },
      stuck,
      overscan: Math.min(fullOverscan, overscanLimit),
      focused: focusedKey,
      restoring: opening.positioned ? undefined : opening.target,
    });
  });

  const padTop = $derived.by(() => (void layout, index.offset(range[0])));

  // Both ends from the live index: a measurement not yet committed to `layout` must not leave a gap below the rows.
  const padBottom = $derived.by(() => (void layout, index.total - index.offset(range[1])));
  const visible = $derived(rows.slice(range[0], range[1]));

  $effect(() => {
    void layout;

    return publishViewport(index, scrollTop - listTop, Math.max(0, viewport - footerHeight), onviewport);
  });

  // A start-aligned last row needs enough space below it to reach the viewport's top.
  let alignedKey = $state<string>();

  const alignmentSpace = $derived(
    (void layout, rowAlignmentSpace(index, alignedKey, positions, viewport, footerHeight)),
  );

  const footerSpace = $derived(footerHeight + alignmentSpace);

  let rowTarget: string | undefined;
  let rowTimer: ReturnType<typeof setTimeout> | undefined;

  // --- New rows ---------------------------------------------------------------------------------------
  const entrances = new FeedEntrances();

  $effect.pre(() => {
    entrances.update(
      sized.map((r) => r.key),
      (at) => {
        const row = rows[at];

        return row === undefined ? undefined : inserted?.(row);
      },
    );
  });

  // --- Measuring ------------------------------------------------------------------------------------
  const elements = new Map<string, HTMLElement>();

  const measurements = new FeedMeasurements(
    index,
    () => ({ positions, sized, scroller, list }),
    settle,
    (size) => {
      measured++;
      viewport = size.viewport;
      gutter = size.gutter;
      listTop = size.listTop;
    },
  );

  const observer = measurements.observer;

  const measure = rowAttachment(elements, observer);

  $effect(() =>
    observeFeed(observer, scroller, list, footerShell, (node) => {
      if (untrack(() => viewport) === 0) viewport = measurements.viewport = node.clientHeight;
    }),
  );

  // A footer that just finished folding or opening: its settled height is the new baseline.
  $effect(() => footerReserve.settled(footerFit.fold === "moving" ? undefined : footerShell, footerState, setTop));

  $effect(() => () => {
    measurements.dispose();
    entrances.dispose();
    endScroll.cancel();
    clearTimeout(rowTimer);
  });

  // Structural changes need a settle; content growth is already measured by ResizeObserver.
  // Reading scrollHeight for every text delta forces layout even when the row's height stays fixed.
  $effect(() => {
    void padTop;
    void padBottom;
    void sized;
    void footerSpace;
    void loading;
    void ready;
    void viewport;

    untrack(settle);

    if (!loading && ready && opening.positioned) untrack(() => onready?.());
  });

  // --- Keeping the place ----------------------------------------------------------------------------
  const scrollIntent = new ScrollIntent();
  let lastTop = 0;
  let smoothUntil = 0;
  const endScroll = new EndScroll();

  // One observer for the footer: its visible edge (Jump to latest, fade) and its height (the end reserve).
  // Untracked: the attachment measures once synchronously and must not resubscribe to the feed's state.
  const footerResized = (height: number, first: boolean) =>
    untrack(() =>
      first ? footerReserve.start(height, footerState()) : footerReserve.measure(height, footerState(), setTop),
    );

  const footerState = () => ({ ...footerFit, following: stuck && !endScroll.active, scroller });

  function setTop(value: number) {
    if (!scroller) return;
    scroller.scrollTop = value;
    scrollIntent.programmatic(scroller.scrollTop);
    lastTop = scroller.scrollTop;
    scrollTop = scroller.scrollTop;
  }

  function settle() {
    if (!scroller || !list) return;

    if (!opening.positioned) {
      if (loading) return;
      const restored = opening.place(scroller, elements, index, positions, visible.map(key), ready, viewport, setTop);

      if (restored === false) return;
      anchor = restored;
      stuck = !restored;
    }

    // The reader scrolled and its scroll event is still to come: take it in first, or the old anchor
    // would undo the scroll.
    if (Math.abs(scroller.scrollTop - lastTop) >= 1) onscroll();

    if (endScroll.active || performance.now() < smoothUntil) return;

    if (rowTarget) {
      const element = elements.get(rowTarget);
      const at = positions.get(rowTarget);

      if (at === undefined) rowTarget = undefined;
      else if (!element) {
        setTop(listTop + index.offset(at));
        scrollTop = scroller.scrollTop;

        return;
      } else {
        anchor = { key: rowTarget, element, top: 0 };
        identifyAnchor();
        rowTarget = undefined;
      }
    }

    if (!extent.follows(scroller, stuck)) {
      if (anchor) anchor.key = scrollMemory?.key?.(anchor.identity ?? anchor.key) ?? anchor.key;

      if (!settleAnchor(anchor, elements, scroller, setTop) && (!anchor || !positions.has(anchor.key))) capture();

      return;
    }

    stuck = true;

    footerReserve.follow(footerFit.margin);
    extent.pin(scroller, setTop);
  }

  /** With `moved`, a scroll taken in before its event: the anchor follows it while still mounted. */
  function capture(moved?: number) {
    if (!scroller || !list || (moved !== undefined && followScroll(anchor, elements, moved))) return;
    const box = scroller.getBoundingClientRect();
    anchor = captureAnchor(list.children, box.top, box.bottom);
    identifyAnchor();
  }

  function identifyAnchor() {
    if (anchor) anchor.identity = scrollMemory?.identity?.(anchor.key) ?? anchor.key;
  }

  function reportReaderScroll(distance: number, up: number, top: number) {
    if (!onreaderscroll) return;
    const height = Math.max(0, viewport - footerHeight);
    const [start, end] = index.range(top - listTop, top - listTop + height);
    onreaderscroll({ distance, up }, { start, end, height });
  }

  /** Without `event`, a scroll taken in before its event: rows on screen may still show uncorrected layout. */
  function onscroll(event?: Event) {
    if (!scroller) return;
    const top = scroller.scrollTop;

    // Multiple observer/effect passes may consume the same pending native scroll event. An
    // unchanged position is neither fresh reader intent nor a reason to recapture the anchor.
    if (Math.abs(top - lastTop) < 0.5) return;
    const origin = scrollOrigin(scrollIntent, scroller, lastTop, endScroll.active ? Infinity : smoothUntil);

    if (origin === "reader") {
      const distance = scroller.scrollHeight - top - scroller.clientHeight;

      stuck = followingAfterScroll(stuck, origin, distance, lastTop - top, Boolean(rowTarget));

      reportReaderScroll(distance, lastTop - top, top);
    }

    // A smooth scroll moves ahead of its events. Taken in by `settle`, after rows above were re-estimated, the
    // rows on screen are not corrected yet: the anchor moves by the reader's distance and settle restores the rest.
    if (!stuck && origin === "reader" && performance.now() >= smoothUntil) capture(event ? undefined : top - lastTop);
    lastTop = scrollTop = top;
    opening.schedule(() => ({ following: stuck, anchor }));

    if (origin === "unattributed") settle();
  }

  function onwheel(event: WheelEvent) {
    readerGesture();

    // Scrolling up during a stream: let go at once, before the next growth pins the end again.
    if (event.deltaY < 0 && scroller && scroller.scrollHeight > scroller.clientHeight + FEED_END_THRESHOLD) {
      // A previous reading anchor may survive a jump to latest. Capture the current end before
      // releasing it: streaming's observer can settle between the wheel and its scroll event.
      if (stuck) capture();
      stuck = false;
    }
  }

  $effect(() => (scroller ? trackEmbedHover(scroller, scrollIntent) : undefined));

  function readerGesture() {
    endScroll.cancel();
    rowTarget = undefined;
    clearTimeout(rowTimer);

    if (smoothUntil > 0) {
      smoothUntil = 0;
      // Stop a programmatic smooth scroll at its current position before handing control back.
      scroller?.scrollTo({ top: scroller.scrollTop, behavior: "instant" });

      if (!stuck) capture();
    }

    scrollIntent.gesture();
  }

  function onscrollend() {
    // Frame-driven end navigation writes scrollTop itself, which also emits scrollend.
    if (endScroll.active) return;
    onscroll();
    onreaderscrollend?.();
    const wasSmooth = smoothUntil > 0;
    smoothUntil = 0;

    // Only a completed smooth navigation needs a new anchor. Our integer scrollTop
    // corrections also fire scrollend: recapturing those would accumulate rounding error
    // on each streamed paragraph instead of holding the original fractional offset.
    if (wasSmooth && !stuck) capture();
    settle();
  }

  export function jumpToLatest(animate = false) {
    if (!scroller) return;
    endScroll.cancel();
    smoothUntil = 0;
    rowTarget = undefined;
    clearTimeout(rowTimer);
    alignedKey = undefined;
    onlatest?.();
    stuck = true;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const smooth = animate && distance < viewport * 2 && !motionPreferences.reduced;

    if (smooth) {
      endScroll.start(scroller, setTop, settle);
    } else setTop(scroller.scrollHeight);
  }

  // --- Keyboard ---------------------------------------------------------------------------------------
  const handoff = new FeedHandoff(
    () => ({ scroller, elements, memory: scrollMemory }),
    (value) => {
      stuck = !value || !extent.overflows;
      anchor = value;
      identifyAnchor();
    },
    () => opening.save(stuck, anchor),
    setTop,
  );

  export const savePosition = () => handoff.save();
  export const restorePosition = (position: Parameters<FeedHandoff["restore"]>[0]) => handoff.restore(position);

  export const showsLatest = () =>
    !loading && ready && opening.positioned && viewport > 0 && extent.endVisible && (stuck || !extent.overflows);

  /** Read-only estimated/measured row offset, relative to the start of the list. */
  export const rowOffset = (at: number): number => (void layout, index.offset(at));

  /** Jump even to an unmounted row; measurements then keep its start exactly at the top. */
  export async function scrollToRow(
    at: number,
    options: { align: "start"; smooth?: boolean } = { align: "start" },
  ): Promise<boolean> {
    const rowKey = index.keyAt(at);

    if (!scroller || rowKey === undefined) return false;
    endScroll.cancel();
    stuck = false;
    anchor = undefined;
    alignedKey = rowKey;
    rowTarget = rowKey;
    clearTimeout(rowTimer);
    await tick();

    if (!scroller || rowTarget !== rowKey) return false;
    const smooth = options.smooth && !motionPreferences.reduced;
    smoothUntil = smooth ? performance.now() + 1000 : 0;
    scroller.scrollTo({ top: listTop + index.offset(at), behavior: smooth ? "smooth" : "instant" });
    scrollTop = scroller.scrollTop;
    // scrollend need not fire if the estimated destination was already the current position.
    rowTimer = setTimeout(
      () => {
        smoothUntil = 0;
        settle();
      },
      smooth ? 1050 : 0,
    );

    return true;
  }

  async function focusRow(at: number) {
    const rowKey = index.keyAt(at);

    if (rowKey === undefined || !scroller) return;
    endScroll.cancel();
    focusedKey = rowKey;
    await tick();
    focusFeedRow(elements.get(rowKey), scroller, footerHeight);
  }

  /**
   * Scrolls to the row with this key and focuses it (e.g. "N running in background" jumping to a task);
   * the reader stops following the end. False when no row has the key.
   */
  export async function reveal(rowKey: string): Promise<boolean> {
    const at = positions.get(rowKey);

    if (at === undefined || !scroller) return false;
    endScroll.cancel();
    rowTarget = undefined;
    alignedKey = undefined;
    smoothUntil = 0;
    clearTimeout(rowTimer);
    stuck = false;
    anchor = undefined;
    // Near its estimated place first, so the window mounts it; then exactly onto it.
    setTop(Math.max(0, listTop + index.offset(at) - 8));
    scrollTop = scroller.scrollTop;
    await focusRow(at);

    return true;
  }

  /** After a turn, let a following reader start an oversized answer at its first line.
   * No focus change, no movement for a short answer or a reader who scrolled away. */
  export async function scrollRowToTop(rowKey: string): Promise<boolean> {
    const target = await answerStart(() => ({
      following: stuck,
      scroller,
      element: elements.get(rowKey),
      footer: footerHeight,
    }));

    if (!target) return false;
    endScroll.cancel();
    stuck = false;
    anchor = { key: rowKey, element: target.element, top: 8 };
    identifyAnchor();
    smoothUntil = moveToAnswer(target.scroller, target.top, setTop);

    return true;
  }

  /**
   * The rows the reader is on: the focused one and, while they are not following the end (scrolled up),
   * the rows on screen above the footer. Empty while following the end with nothing focused.
   */
  export function reading(): string[] {
    return readingKeys(elements, scroller, stuck, focusedKey, footerHeight);
  }

  /**
   * Makes this row (mounted, on screen) the one that keeps its place while the reader is scrolled up,
   * e.g. before rows are inserted above it that would otherwise push it down.
   */
  export function hold(rowKey: string, removedKey: string): void {
    if (focusedKey === removedKey) stuck = false;

    if (!stuck && !elements.has(rowKey)) rowTarget = rowKey;

    if (!stuck) anchor = holdAnchor(rowKey, elements, scroller, focusedKey === removedKey) ?? anchor;
    identifyAnchor();
  }

  /**
   * Keeps this row (a header the reader just opened or closed) where it is on screen: what is below it grows or
   * shrinks, what is above stays. A reader following the end stops following, so the end does not pull it up.
   */
  export function keep(rowKey: string): void {
    const element = elements.get(rowKey);

    if (!scroller || !element) return;
    endScroll.cancel();
    stuck = false;
    rowTarget = undefined;
    anchor = { key: rowKey, element, top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
    identifyAnchor();
  }

  const onkeydown = (event: KeyboardEvent) => navigateFeedKey(event, footerElement, scroller, positions, focusRow);
</script>

<div
  class="feed-shell relative h-full [--feed-end-gap:--spacing(8)]"
  style:--feed-edge="{footerEdge}px"
  style:--feed-gutter="{gutter}px"
>
  <!-- The viewport already has a fixed height and clips overflow. Size/layout/paint containment
       prevents growing descendants from invalidating the surrounding application layout. -->
  <!-- The labelled, focusable scroll region supports native scrolling keys. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={scroller}
    {id}
    class="relative h-full scroll-pt-2 scroll-pb-(--feed-footer) scroll-stable overflow-y-auto overscroll-contain [contain:strict] [overflow-anchor:none] focus-visible:outline-none"
    style:--feed-footer="{footerHeight}px"
    style:visibility={loading || opening.positioned ? undefined : "hidden"}
    role="region"
    aria-label={label}
    tabindex="0"
    {onscroll}
    {onscrollend}
    {@attach (node) => on(node, "wheel", onwheel, { passive: true })}
    ontouchmove={readerGesture}
    onpointerdown={(event) => {
      if (event.target === scroller) readerGesture();
    }}
    onpointermove={(event) => {
      if (event.buttons === 1 && event.target === scroller) readerGesture();
    }}
    onkeydown={(event) =>
      handleFeedScrollKey(event, scroller, list, readerGesture, (edge) => {
        if (!scroller) return;
        alignedKey = undefined;

        if (edge === "End") handoff.restore({ mode: "following" });
        else {
          const previous = scroller.scrollTop;
          stuck = !extent.overflows;
          anchor = undefined;
          setTop(0);

          if (previous > 0) reportReaderScroll(Math.max(0, scroller.scrollHeight - scroller.clientHeight), previous, 0);
        }

        opening.schedule(() => ({ following: stuck, anchor }));
      })}
  >
    <div class="chat-column flex min-h-full flex-col px-4 sm:px-6">
      <!-- A steady containing block: row transitions start and cancel without relayout of the list. -->
      <div class="flex grow [transform:translateY(0)] flex-col pt-2 pb-(--feed-end-gap)">
        {@render top?.()}
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
          onfocusin={(event) => (focusedKey = feedRowKey(event.target))}
          onfocusout={(event) => {
            if (!(event.relatedTarget instanceof Node) || !list?.contains(event.relatedTarget)) focusedKey = undefined;
          }}
        >
          {#each visible as item, offset (key(item))}
            <VirtualRow
              key={key(item)}
              position={range[0] + offset + 1}
              count={sized.length}
              {memory}
              {measure}
              enter={opening.positioned ? entrances.take(key(item)) : undefined}
              exiting={() => !positions.has(key(item)) && inserted?.(item) === "unfold"}
            >
              {@render row(item, range[0] + offset)}
            </VirtualRow>
          {/each}
        </div>
        <div
          {@attach (end) => (scroller ? extent.watchEnd(scroller, end, footerEdge) : undefined)}
          aria-hidden="true"
          class="-mt-px h-px shrink-0"
        ></div>
      </div>
      <!-- The end reserve (full footer plus margin): the footer folds and grows inside it without moving rows. -->
      <div aria-hidden="true" style:height="{footerSpace}px" class="shrink-0"></div>
    </div>
  </div>
  <!-- Top fade: rows scrolled under the header blend into the thread surface, so the active tab continues into the
       thread and the edge hints that there is more above. Hidden at the very top, where nothing is above. -->
  <div
    aria-hidden="true"
    class={[
      "pointer-events-none absolute top-0 right-(--feed-gutter) left-0 z-10 h-6 bg-linear-to-b from-(--feed-fade) to-transparent transition-opacity duration-(--duration-fast) ease-smooth-out motion-reduce:transition-none",
      scrollTop < 1 && "opacity-0",
    ]}
  ></div>
  <!-- The footer and its fade are siblings of the scroller. Resizing them cannot move a row,
     change the virtual window, or make the browser reveal a contenteditable's flow position. -->
  <div class="pointer-events-none absolute right-(--feed-gutter) bottom-0 left-0 isolate z-10 [contain:layout]">
    <div class="relative">
      <!-- Fade: the composer's shadow in the thread surface colour. Solid only below the composer's visible edge,
           then a gradient that starts right at that edge, so Jump to latest sits on the transition.
           The shell takes the footer's natural height; the rows' end space is the separate, steadier reserve. -->
      <div bind:this={footerShell} class="absolute inset-x-0 bottom-0 isolate">
        <div class="[clip-path:inset(-2rem_-4px_0)]">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="chat-column px-4 sm:px-6" {onkeydown}>
            <div
              bind:this={footerElement}
              {@attach (element) => watchFooterEdge(element, (edge) => (footerEdge = edge), footerResized)}
              class="pointer-events-auto relative composer-bottom"
              onfocusin={() => scrollIntent.reset()}
              onbeforeinput={() => scrollIntent.reset()}
            >
              {@render footer?.()}
            </div>
          </div>
        </div>
        <div class="footer-backdrop inset-x-0 -z-10" aria-hidden="true"></div>
        <FeedFooterActions
          accessory={footerAccessory}
          showJump={!stuck && extent.overflows && !extent.endVisible}
          onjump={() => jumpToLatest(true)}
        />
      </div>
    </div>
  </div>
</div>

<style>
  /* The fades blend rows into the background the feed sits on: the thread surface unless the host sets
     `--feed-backdrop` (a bot chat sits on the canvas). */
  .feed-shell {
    --feed-fade: var(--feed-backdrop, var(--color-surface));
  }

  .feed-shell::before,
  .footer-backdrop {
    position: absolute;
    bottom: 0;
    height: calc(var(--feed-edge) + var(--feed-end-gap));
    background: linear-gradient(to top, var(--feed-fade) var(--feed-edge), transparent);
    pointer-events: none;
  }

  /* Continue the backdrop under the transparent scrollbar track, behind the thumb. */
  .feed-shell::before {
    content: "";
    right: 0;
    width: var(--feed-gutter);
  }
</style>
