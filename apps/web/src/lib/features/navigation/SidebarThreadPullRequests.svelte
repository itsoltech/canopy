<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { threadPullRequestBadge } from "@canopy/domain/github-pr";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { toneClasses } from "#lib/features/github/presentation.ts";
  import { formatCount } from "#lib/shared/format.ts";

  /**
   * The linked pull requests in the sidebar row's meta line (docs/threads.md, "Wiersz wątku"): the newest one's state
   * icon and number, then `+N` for the others. The label is the title (the row's hover card is the floating layer)
   * and the accessible name.
   */
  let { thread }: { thread: ui.Thread } = $props();

  const badge = $derived(threadPullRequestBadge(thread));

  const text = $derived(
    !badge
      ? ""
      : badge.number
        ? `#${badge.number}${badge.more ? ` +${formatCount(badge.more)}` : ""}`
        : formatCount(badge.more),
  );
</script>

{#if badge}
  <span class="flex shrink-0 items-center gap-1 tabular-nums" title={badge.label}>
    <span class={["flex", toneClasses[badge.look.tone]]}><Icon name={badge.look.icon} size="sm" tone="inherit" /></span>
    <span aria-hidden="true">{text}</span>
    <span class="sr-only">{badge.label}</span>
  </span>
{/if}
