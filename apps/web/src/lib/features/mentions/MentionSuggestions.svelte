<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";

  /** Touch/narrow editors keep suggestions in their own surface above the input. The desktop
   * popover retains its existing anchor/placement. Only this wrapper owns responsive layout;
   * the list and editor keep the same selection and focus contract on both presentations.
   */
  let {
    open = $bindable(false),
    anchor,
    label,
    children,
    class: className,
  }: {
    open?: boolean;
    anchor?: HTMLElement | undefined;
    label: string;
    children: Snippet;
    class?: ClassValue;
  } = $props();

  let inline = $state(false);
  let viewportHeight = $state<number>();

  $effect(() => {
    const query = matchMedia("(pointer: coarse), (max-width: 39.999rem)");

    const sync = () => {
      inline = query.matches;
    };

    sync();
    query.addEventListener("change", sync);

    return () => query.removeEventListener("change", sync);
  });

  $effect(() => {
    if (!inline || !open) return;
    const viewport = window.visualViewport;

    const sync = () => {
      viewportHeight = viewport?.height ?? window.innerHeight;
    };

    sync();
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);

    return () => {
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  });
</script>

{#if inline}
  {#if open}
    <!-- expand is the shared panel/accordion transition: motion tokens,
         reversible height + opacity + blur, and prefers-reduced-motion support. -->
    <div class={className} transition:expand inert={!open}>
      <div
        data-mention-inline
        class="min-w-0 border-b border-zinc-950/10 text-zinc-950 dark:border-white/10 dark:text-white"
      >
        <!-- Own the scrolling here: kit Popover carries its own fixed positioning/padding. -->
        <div
          data-mention-scroll
          class="max-h-[40dvh] touch-pan-y scroll-py-1 scroll-stable overflow-y-auto overscroll-contain"
          style:max-height={viewportHeight === undefined ? undefined : `${viewportHeight * 0.4}px`}
        >
          {@render children()}
        </div>
      </div>
    </div>
  {/if}
{:else if anchor}
  <Popover
    bind:open
    {label}
    {anchor}
    role="none"
    focusOnOpen={false}
    placement="top-start"
    class="w-(--float-anchor-width) max-w-[calc(100vw-1rem)]"
  >
    <div class={className}>{@render children()}</div>
  </Popover>
{/if}
