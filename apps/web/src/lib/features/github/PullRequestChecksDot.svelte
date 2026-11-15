<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { PullRequestLook, PullRequestTone } from "@canopy/domain/github-pr";
  import { workingColors } from "@canopy/ui/thread-row";

  /** Decorative corner dot; the containing PR mark supplies the checks label. Unknown checks leave no dot. */
  let { checks, class: className }: { checks: PullRequestLook; class?: ClassValue } = $props();

  const colors: Partial<Record<PullRequestTone, string>> = {
    success: "bg-emerald-600 dark:bg-emerald-400",
    danger: "bg-rose-600 dark:bg-rose-400",
    warning: "bg-amber-500 dark:bg-amber-400",
  };
</script>

{#if checks.tone !== "muted"}
  <span
    aria-hidden="true"
    class={[
      "pr-checks-dot absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full",
      checks.spinning ? "bg-(--working-light) dark:bg-(--working-dark)" : colors[checks.tone],
      className,
    ]}
    style:--working-light={workingColors.light.indicator}
    style:--working-dark={workingColors.dark.indicator}
    data-running={checks.spinning}
  ></span>
{/if}

<style>
  .pr-checks-dot {
    box-shadow: 0 0 0 1.5px var(--tab-fill, var(--color-surface));
  }
  .pr-checks-dot[data-running="true"] {
    animation: pr-checks-dot 1.6s var(--ease-in-out) infinite;
  }
  @keyframes pr-checks-dot {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pr-checks-dot[data-running="true"] {
      animation: none;
    }
  }
</style>
