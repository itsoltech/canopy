<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { duration } from "#lib/shared/ui/motion.ts";

  let { syncing, children, class: className }: { syncing: boolean; children: Snippet; class?: ClassValue } = $props();
  let shown = $state(false);
  let announced = $state(false);
  const visible = $derived(syncing && shown);

  $effect(() => {
    if (!syncing) {
      shown = false;
      announced = false;

      return;
    }

    const reveal = setTimeout(() => (shown = true), duration("very-slow"));
    const announce = setTimeout(() => (announced = true), duration("very-slow") * 4);

    return () => {
      clearTimeout(reveal);
      clearTimeout(announce);
    };
  });
</script>

<!-- The project mark keeps its exact slot. Only opacity and the glyph's rotation change. -->
<span class={["relative inline-flex size-4.5 shrink-0", className]}>
  <span class="sync-mark flex items-center justify-center" data-syncing={visible}>{@render children()}</span>
  <span
    class="sync-icon absolute inset-0 flex items-center justify-center"
    data-syncing={visible}
    role="img"
    aria-label="Syncing…"
    aria-hidden={!visible}
  >
    <span class="sync-rotation"><Icon name="arrow-path" /></span>
  </span>
  <span role="status" aria-atomic="true" class="sr-only">{syncing && announced ? "Syncing…" : ""}</span>
</span>

<style>
  .sync-mark,
  .sync-icon {
    transition: opacity var(--duration-quick) var(--ease-smooth-out);
  }
  .sync-mark[data-syncing="true"],
  .sync-icon {
    opacity: 0;
  }
  .sync-icon[data-syncing="true"] {
    opacity: 1;
  }
  .sync-rotation {
    animation: sync-rotate calc(var(--duration-very-slow) * 4) var(--ease-linear) infinite;
    animation-play-state: paused;
  }
  .sync-icon[data-syncing="true"] .sync-rotation {
    animation-play-state: running;
  }
  @keyframes sync-rotate {
    to {
      rotate: 360deg;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sync-rotation {
      animation: none !important;
    }
  }
</style>
