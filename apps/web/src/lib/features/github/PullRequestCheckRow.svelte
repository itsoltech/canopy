<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { checkLook } from "@canopy/domain/github-pr";
  import { safeHref } from "@canopy/domain/markdown";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import PullRequestJobs from "./PullRequestJobs.svelte";
  import CheckStateIcon from "./CheckStateIcon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import CiActions from "./CiActions.svelte";
  import { prCitation, prCheckFailed } from "@canopy/domain";

  let {
    snapshot,
    check,
    class: className,
  }: { snapshot: github.PullRequestSnapshot; check: github.PullRequestCheck; class?: ClassValue } = $props();

  let open = $state(false);
  const look = $derived(checkLook(check.state));
  const providerUrl = $derived(safeHref(check.url));
</script>

<li class={["group/pr min-w-0 text-sm/5 sm:text-xs/5", className]}>
  <div class="flex min-w-0 items-center pr-2">
    <button
      type="button"
      title={`${check.name} · ${look.label}`}
      aria-label={`${check.name}, ${look.label}`}
      aria-expanded={open}
      onclick={() => (open = !open)}
      class="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left focus-ring hover:bg-zinc-950/3 sm:min-h-9 dark:hover:bg-white/5"
    >
      <span class="flex shrink-0" {@attach tooltip(look.label)}><CheckStateIcon {look} /></span>
      <p class="min-w-0 flex-1 truncate font-medium" title={check.name}>{check.name}</p>
      <p class="max-w-24 truncate text-zinc-500 max-sm:hidden dark:text-zinc-400">{check.provider}</p>
      <Icon name={open ? "chevron-down" : "chevron-right"} />
    </button>
    <CiActions
      {snapshot}
      runId={check.runId}
      state={check.state}
      name={check.name}
      quote={prCheckFailed(check.state)
        ? prCitation(
            snapshot,
            "check",
            check.nodeId || check.url || check.name,
            `${check.name}: ${check.state}${check.output ? `\n\n${check.output}` : ""}`,
            { author: check.provider, url: check.url },
          )
        : undefined}
    />
  </div>
  {#if open && (check.runId || check.output || providerUrl)}
    <div
      class="mx-3 mt-1 mb-3 grid min-w-0 gap-2 border-s border-zinc-950/15 ps-3 sm:ms-5 sm:ps-4 dark:border-white/15"
    >
      {#if check.runId}<PullRequestJobs {snapshot} runId={check.runId} />
      {:else if check.output}<Markdown text={check.output} />{/if}
      {#if providerUrl}<a
          href={providerUrl}
          target="_blank"
          rel="noreferrer"
          class="flex min-h-9 w-fit items-center text-zinc-500 hover:underline dark:text-zinc-400"
          >Open check on provider</a
        >{/if}
    </div>
  {/if}
</li>
