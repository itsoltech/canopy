<script lang="ts">
  import type { github } from "@canopy/contracts";
  import { checkLook, pullRequestLook, type PullRequestTone } from "@canopy/domain/github-pr";
  import { workingColors } from "@canopy/ui/thread-row";
  import { SharedRead, queries, revalidateEvery } from "#lib/shared/queries.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import * as api from "./api.ts";
  import { toneClasses } from "./presentation.ts";

  /**
   * A pull request tab's mark: its state icon in the state's colour, with a corner dot for its checks (none while
   * checks are unknown). Shares the panel's read, so an open tab costs no extra request; re-reads while checks run.
   */
  let { id, onlabel }: { id: string; onlabel?: (label: string) => void } = $props();

  const read = $derived(
    new SharedRead<github.PullRequestSnapshot>(queries, `GetPullRequest:${id}`, () => api.pullRequest(id)),
  );

  const summary = $derived(read.data?.summary);
  const state = $derived(pullRequestLook(summary?.state ?? ""));
  const checks = $derived(checkLook(summary?.checksState ?? ""));
  const showChecks = $derived(!!summary && checks.tone !== "muted");

  const dot: Partial<Record<PullRequestTone, string>> = {
    success: "bg-emerald-600 dark:bg-emerald-400",
    danger: "bg-rose-600 dark:bg-rose-400",
    warning: "bg-amber-500 dark:bg-amber-400",
  };

  $effect(() => onlabel?.(summary ? `${state.label}${showChecks ? `, Checks: ${checks.label}` : ""}` : ""));

  $effect(() => (checks.spinning ? revalidateEvery(read.key, 15_000) : undefined));
</script>

<span
  aria-hidden="true"
  class="relative flex size-4 shrink-0 items-center justify-center"
  style:--working-light={workingColors.light.indicator}
  style:--working-dark={workingColors.dark.indicator}
>
  <Icon
    name={summary ? state.icon : "git-pull-request"}
    tone={summary ? "inherit" : "muted"}
    class={summary ? toneClasses[state.tone] : undefined}
  />
  {#if showChecks}<span
      class={[
        "pr-tab-checks absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full",
        checks.spinning ? "bg-(--working-light) dark:bg-(--working-dark)" : dot[checks.tone],
      ]}
      data-running={checks.spinning}
    ></span>{/if}
</span>

<style>
  .pr-tab-checks {
    box-shadow: 0 0 0 1.5px var(--tab-fill, var(--color-surface));
  }
  .pr-tab-checks[data-running="true"] {
    animation: pr-tab-checks 1.6s var(--ease-in-out) infinite;
  }
  @keyframes pr-tab-checks {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pr-tab-checks[data-running="true"] {
      animation: none;
    }
  }
</style>
