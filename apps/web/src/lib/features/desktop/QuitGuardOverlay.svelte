<script lang="ts">
  import { onMount } from "svelte";
  import type { QuitGuardState } from "@canopy/ui/desktop";
  import { rise } from "#lib/shared/ui/motion.ts";

  let state = $state<QuitGuardState>();
  onMount(() => window.canopyDesktop?.onQuitGuard?.((value) => {
    state = value.phase === "cancel" ? undefined : value;
  }));
</script>

<div class="pointer-events-none fixed inset-x-0 bottom-0 top-(--window-safe-top) z-[1000] flex items-center justify-center p-6 macos:overflow-y-auto">
  {#if state}
    {#key state}
      <div transition:rise class="flex max-w-full items-center gap-4 rounded-2xl border border-zinc-950/10 bg-white px-5 py-4 text-zinc-950 shadow-xl dark:border-white/10 dark:bg-zinc-900 dark:text-white" data-window-no-drag role="status" aria-live="polite">
        {#if state.phase === "holding"}
          <div class="relative flex size-16 shrink-0 items-center justify-center" style:--hold-duration={`${state.durationMs}ms`}>
            <svg class="quit-ring absolute inset-0 size-full -rotate-90" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-width="3" class="text-zinc-200 dark:text-zinc-700" />
              <circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" pathLength="1" class="quit-progress text-brand-600 dark:text-brand-400" />
            </svg>
            <kbd class="text-sm font-semibold">{state.shortcut}</kbd>
          </div>
          <div class="grid gap-1"><p class="font-medium">Keep holding…</p><p class="text-sm text-zinc-500 dark:text-zinc-400">Release to cancel</p></div>
        {:else}
          <p class="text-sm font-medium">Press <kbd class="font-semibold">{state.shortcut}</kbd> again to quit</p>
        {/if}
      </div>
    {/key}
  {/if}
</div>

<style>
  .quit-progress {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: quit-fill var(--hold-duration) linear forwards;
  }
  @keyframes quit-fill { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .quit-progress { animation: none; }
    .quit-ring { display: none; }
  }
</style>
