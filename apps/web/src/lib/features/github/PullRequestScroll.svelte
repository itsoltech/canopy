<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  let {
    element = $bindable(),
    header,
    tabs,
    children,
    onscroll,
    class: className,
  }: {
    element?: HTMLDivElement;
    header: Snippet<[boolean]>;
    tabs: Snippet;
    children: Snippet;
    onscroll: (event: Event & { currentTarget: HTMLDivElement }) => void;
    class?: ClassValue;
  } = $props();

  let chrome = $state<HTMLDivElement>();
  let tabBar = $state<HTMLDivElement>();
  let compactSize = $state<HTMLDivElement>();
  let collapse = $state<HTMLDivElement>();
  let expand = $state<HTMLDivElement>();
  let offset = $state(0);
  let pinned = $state(0);
  let compact = $state(false);

  $effect(() => {
    const root = element;

    if (!root || !chrome || !tabBar || !compactSize || !collapse || !expand) return;
    const sizes = new Map<Element, number>();

    const sticky = chrome,
      tab = tabBar,
      bar = compactSize;

    const update = () => {
      if (root.scrollTop > offset + 16) compact = true;
      else if (root.scrollTop <= offset) compact = false;
    };

    // Only resize/threshold callbacks read geometry. Compaction never changes the flow height.
    const resize = new ResizeObserver((entries) => {
      for (const entry of entries) sizes.set(entry.target, entry.borderBoxSize[0]?.blockSize ?? 0);

      const height = sizes.get(sticky),
        tabsHeight = sizes.get(tab),
        barHeight = sizes.get(bar);

      if (height === undefined || tabsHeight === undefined || barHeight === undefined) return;
      pinned = tabsHeight + barHeight;
      offset = Math.max(0, height - pinned);
      update();
    });

    for (const target of [sticky, tab, bar]) resize.observe(target);
    const observer = new IntersectionObserver(update, { root, threshold: [0, 1] });
    observer.observe(collapse);
    observer.observe(expand);

    return () => {
      resize.disconnect();
      observer.disconnect();
    };
  });
</script>

<div
  bind:this={element}
  {onscroll}
  class={[
    "relative isolate h-full min-h-0 min-w-0 scroll-stable overflow-y-auto overscroll-contain bg-surface",
    className,
  ]}
  style:--pr-collapse-offset={`${offset}px`}
  style:--pr-chrome-height={`${pinned}px`}
  style:scroll-padding-top={`${pinned}px`}
>
  <div class="pointer-events-none relative h-0" aria-hidden="true">
    <div bind:this={compactSize} class="absolute h-12 w-px"></div>
    <div bind:this={expand} class="absolute top-(--pr-collapse-offset) h-px w-px"></div>
    <div bind:this={collapse} class="absolute top-[calc(var(--pr-collapse-offset)+1rem)] h-px w-px"></div>
  </div>
  <div bind:this={chrome} class="sticky top-[calc(-1*var(--pr-collapse-offset))] z-50 bg-surface">
    {@render header(compact)}
    <div bind:this={tabBar} class="bg-surface">{@render tabs()}</div>
  </div>
  {@render children()}
</div>
