<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Dialog from "#lib/shared/ui/Dialog.svelte";

  let {
    open = $bindable(false),
    ownerId,
    children,
    panel,
    class: className,
  }: {
    open?: boolean;
    ownerId: string;
    children: Snippet;
    panel: Snippet;
    class?: ClassValue;
  } = $props();

  let desktop = $state(false);
  let loadedOwner = $state("");
  let mobileOpen = $state(false);
  const id = $props.id();

  $effect(() => {
    const query = window.matchMedia("(min-width: 64rem)");

    const update = () => {
      desktop = query.matches;
    };

    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  });

  $effect(() => {
    const owner = ownerId;

    if (!owner || loadedOwner === owner) return;
    untrack(() => {
      try {
        open = localStorage.getItem(`canopy:bot-details:${owner}`) !== "closed";
      } catch {
        open = true;
      }

      loadedOwner = owner;
    });
  });

  $effect(() => {
    if (loadedOwner !== ownerId || !loadedOwner) return;

    try {
      localStorage.setItem(`canopy:bot-details:${ownerId}`, open ? "open" : "closed");
    } catch {
      /* Storage can be disabled. */
    }
  });

  // A desktop preference never opens a modal on arrival on a phone.
  $effect(() => {
    if (desktop) mobileOpen = false;
  });

  export function toggle() {
    if (desktop) open = !open;
    else mobileOpen = !mobileOpen;
  }

  export function close() {
    if (desktop) open = false;
    else mobileOpen = false;
  }

  export function isExpanded() {
    return desktop ? open : mobileOpen;
  }
</script>

<div class={["flex min-h-0 min-w-0 flex-1", className]} data-window-side-panel={desktop && open ? "shown" : undefined}>
  <div class="min-h-0 min-w-0 flex-1">{@render children()}</div>
  {#if desktop}
    <aside {id} aria-label="Bot details" class="shrink-0 overflow-hidden" class:is-open={open} inert={!open}>
      <div
        class="t-panel-slide h-full w-84 scroll-stable overflow-y-auto overscroll-contain border-l border-zinc-950/6 bg-zinc-50/60 dark:border-white/8 dark:bg-zinc-950/60"
        data-open={open ? "true" : "false"}
      >
        {@render panel()}
      </div>
    </aside>
  {/if}
</div>
{#if !desktop}<Dialog bind:open={mobileOpen} title="Bot details" bare class="sm:max-w-md">{@render panel()}</Dialog
  >{/if}

<style>
  aside {
    width: 0;
    transition: width var(--duration-medium) var(--ease-smooth-out);
  }
  aside.is-open {
    width: 21rem;
    transition-duration: var(--duration-slow);
  }
  .t-panel-slide {
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--duration-medium) var(--ease-smooth-out);
  }
  .t-panel-slide[data-open="true"] {
    opacity: 1;
    pointer-events: auto;
    transition-duration: var(--duration-slow);
  }
  @media (prefers-reduced-motion: reduce) {
    aside,
    .t-panel-slide {
      transition: none !important;
    }
  }
</style>
