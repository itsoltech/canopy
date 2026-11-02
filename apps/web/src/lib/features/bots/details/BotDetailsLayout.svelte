<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Dialog from "#lib/shared/ui/Dialog.svelte";

  let { open = $bindable(false), ownerId, children, panel, class: className }: {
    open?: boolean; ownerId: string; children: Snippet; panel: Snippet; class?: ClassValue;
  } = $props();
  let desktop = $state(false);
  let loadedOwner = $state('');
  let mobileOpen = $state(false);
  const id = $props.id();
  $effect(() => {
    const query = window.matchMedia('(min-width: 64rem)');
    const update = () => { desktop = query.matches; };
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });
  $effect(() => {
    const owner = ownerId;
    if (!owner || loadedOwner === owner) return;
    untrack(() => {
      try { open = localStorage.getItem(`canopy:bot-details:${owner}`) !== 'closed'; } catch { open = true; }
      loadedOwner = owner;
    });
  });
  $effect(() => {
    if (loadedOwner !== ownerId || !loadedOwner) return;
    try { localStorage.setItem(`canopy:bot-details:${ownerId}`, open ? 'open' : 'closed'); } catch { /* Storage can be disabled. */ }
  });
  // A desktop preference never opens a modal on arrival on a phone.
  $effect(() => { if (desktop) mobileOpen = false; });
  export function toggle() { if (desktop) open = !open; else mobileOpen = !mobileOpen; }
  export function close() { if (desktop) open = false; else mobileOpen = false; }
  export function isExpanded() { return desktop ? open : mobileOpen; }
</script>

<div class={["flex min-h-0 min-w-0 flex-1", className]}>
  <div class="min-h-0 min-w-0 flex-1">{@render children()}</div>
  {#if desktop}
    <aside {id} aria-label="Bot details" class="t-resize shrink-0 overflow-hidden" class:is-open={open} inert={!open}>
      <div class="t-panel-slide h-full w-84 overflow-y-auto overscroll-contain border-l border-zinc-950/6 bg-zinc-50/60 dark:border-white/8 dark:bg-zinc-950/60" data-open={open ? 'true' : 'false'}>
        {@render panel()}
      </div>
    </aside>
  {/if}
</div>
{#if !desktop}<Dialog bind:open={mobileOpen} title="Bot details" bare class="sm:max-w-md">{@render panel()}</Dialog>{/if}

<style>
  :global(:root) {
    --resize-dur: 300ms;
    --resize-ease: cubic-bezier(0.22, 1, 0.36, 1);
    --panel-open-dur: 400ms;
    --panel-close-dur: 350ms;
    --panel-translate-y: 12px;
    --panel-blur: 2px;
    --panel-ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  aside { width: 0; }
  aside.is-open { width: 21rem; }
  .t-resize {
    transition:
      width  var(--resize-dur) var(--resize-ease),
      height var(--resize-dur) var(--resize-ease);
    will-change: width, height;
  }
  .t-panel-slide {
    transform: translateY(var(--panel-translate-y));
    opacity: 0;
    filter: blur(var(--panel-blur));
    pointer-events: none;
    transition:
      transform var(--panel-close-dur) var(--panel-ease),
      opacity   var(--panel-close-dur) var(--panel-ease),
      filter    var(--panel-close-dur) var(--panel-ease);
    will-change: transform, opacity, filter;
  }
  .t-panel-slide[data-open="true"] {
    transform: translateY(0);
    opacity: 1;
    filter: blur(0);
    pointer-events: auto;
    transition:
      transform var(--panel-open-dur) var(--panel-ease),
      opacity   var(--panel-open-dur) var(--panel-ease),
      filter    var(--panel-open-dur) var(--panel-ease);
  }
  @media (prefers-reduced-motion: reduce) {
    .t-resize { transition: none !important; }
    .t-panel-slide { transition: none !important; }
  }
</style>
