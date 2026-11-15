<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { checkLook, threadPullRequestBadge } from "@canopy/domain/github-pr";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { toneClasses } from "#lib/features/github/presentation.ts";
  import { formatCount } from "#lib/shared/format.ts";
  import PullRequestChecksDot from "#lib/features/github/PullRequestChecksDot.svelte";

  /**
   * The linked pull requests in the sidebar row's meta line (docs/threads.md, "Wiersz wątku"): the newest one's state
   * icon and number, then `+N` for the others. A corner dot shows its known checks from the overview, without
   * extra reads. The title and accessible name include the checks (the row's hover card is the floating layer).
   */
  let { thread }: { thread: ui.Thread } = $props();

  const badge = $derived(threadPullRequestBadge(thread));
  const checks = $derived(checkLook(thread.newestPullRequest?.checksState ?? ""));

  const showChecks = $derived(
    !!badge?.number && thread.newestPullRequest?.state !== "unavailable" && checks.tone !== "muted",
  );

  const label = $derived(`${badge?.label ?? ""}${showChecks ? `, Checks: ${checks.label}` : ""}`);

  const text = $derived(
    !badge
      ? ""
      : badge.number
        ? `#${badge.number}${badge.more ? ` +${formatCount(badge.more)}` : ""}`
        : formatCount(badge.more),
  );
</script>

{#if badge}
  <span class="flex shrink-0 items-center gap-1 tabular-nums" title={label}>
    <span class={["relative flex shrink-0", toneClasses[badge.look.tone]]}>
      <Icon name={badge.look.icon} size="sm" tone="inherit" />
      {#if showChecks}<PullRequestChecksDot {checks} />{/if}
    </span>
    <span aria-hidden="true">{text}</span>
    <span class="sr-only">{label}</span>
  </span>
{/if}
