<script lang="ts">
  import { onMount } from "svelte";
  import type { QuitGuardState } from "@canopy/ui/desktop";
  import { duration, rise } from "#lib/shared/ui/motion.ts";

  let feedbackState = $state<QuitGuardState>();
  let draining = $state(false);
  let drainFrom = $state("1");
  let progress = $state<SVGCircleElement>();
  let layer = $state<HTMLDivElement>();

  /**
   * Modal dialogs (settings, confirmations) sit in the top layer, above any z-index. The overlay is a manual popover
   * so it can join the top layer too; re-showing it moves it above whatever opened since.
   */
  function raise() {
    if (!layer) return;

    if (layer.matches(":popover-open")) layer.hidePopover();
    layer.showPopover();
  }

  onMount(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const off = window.canopyDesktop?.onQuitGuard?.((value) => {
      clearTimeout(timer);

      if (value.phase === "cancel" && feedbackState?.phase === "holding") {
        drainFrom = progress ? getComputedStyle(progress).strokeDashoffset : "1";
        draining = true;
        timer = setTimeout(() => {
          feedbackState = undefined;
        }, duration("quick"));
      } else {
        draining = false;

        if (value.phase !== "cancel" && !feedbackState) raise();
        feedbackState = value.phase === "cancel" ? undefined : value;
      }
    }, 1);

    return () => {
      off?.();
      clearTimeout(timer);
    };
  });
</script>

<div
  bind:this={layer}
  popover="manual"
  class="pointer-events-none fixed inset-x-0 top-(--window-safe-top) bottom-0 m-0 hidden h-auto max-h-none w-auto max-w-none items-center justify-center overflow-visible border-0 bg-transparent p-6 text-inherit open:flex macos:overflow-y-auto"
>
  {#if feedbackState}
    {#key feedbackState}
      <div
        transition:rise
        class="flex max-w-full items-center gap-4 rounded-2xl border border-zinc-950/10 bg-white px-5 py-4 text-zinc-950 shadow-xl dark:border-white/10 dark:bg-zinc-900 dark:text-white"
        data-window-no-drag
        role="status"
        aria-live="polite"
      >
        {#if feedbackState.phase === "holding"}
          <div
            class="relative flex size-16 shrink-0 items-center justify-center"
            style:--hold-duration={`${feedbackState.durationMs}ms`}
          >
            <svg class="quit-ring absolute inset-0 size-full -rotate-90" viewBox="0 0 64 64" aria-hidden="true">
              <circle
                cx="32"
                cy="32"
                r="29"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                class="text-zinc-200 dark:text-zinc-700"
              />
              <circle
                bind:this={progress}
                cx="32"
                cy="32"
                r="29"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                pathLength="1"
                class="quit-progress text-brand-600 dark:text-brand-400"
                class:draining
                style:--drain-from={drainFrom}
              />
            </svg>
            <kbd class="text-sm font-semibold">{feedbackState.shortcut}</kbd>
          </div>
          <div class="grid gap-1">
            <p class="font-medium">Keep holding…</p>
            <p class="text-sm text-zinc-500 dark:text-zinc-400">Release to cancel</p>
          </div>
        {:else}
          <p class="text-sm font-medium">{feedbackState.message ?? `Press ${feedbackState.shortcut} twice to quit`}</p>
        {/if}
      </div>
    {/key}
  {/if}
</div>

<style>
  .quit-progress {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: quit-fill var(--hold-duration) var(--ease-linear) forwards;
  }
  @keyframes quit-fill {
    to {
      stroke-dashoffset: 0;
    }
  }
  .quit-progress.draining {
    animation: quit-drain var(--duration-quick) var(--ease-smooth-out) forwards;
  }
  @keyframes quit-drain {
    from {
      stroke-dashoffset: var(--drain-from);
    }
    to {
      stroke-dashoffset: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .quit-progress,
    .quit-progress.draining {
      animation: none;
    }
    .quit-ring {
      display: none;
    }
  }
</style>
