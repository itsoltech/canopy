<script lang="ts">
  import type { github } from "@canopy/contracts";
  import { checkLook, pullRequestLook } from "@canopy/domain/github-pr";
  import { SharedRead, queries, revalidateEvery } from "#lib/shared/queries.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import * as api from "./api.ts";
  import { toneClasses } from "./presentation.ts";
  import PullRequestChecksDot from "./PullRequestChecksDot.svelte";

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

  $effect(() => onlabel?.(summary ? `${state.label}${showChecks ? `, Checks: ${checks.label}` : ""}` : ""));

  $effect(() => (checks.spinning ? revalidateEvery(read.key, 15_000) : undefined));
</script>

<span aria-hidden="true" class="relative flex size-4 shrink-0 items-center justify-center">
  <Icon
    name={summary ? state.icon : "git-pull-request"}
    tone={summary ? "inherit" : "muted"}
    class={summary ? toneClasses[state.tone] : undefined}
  />
  {#if showChecks}<PullRequestChecksDot {checks} />{/if}
</span>
