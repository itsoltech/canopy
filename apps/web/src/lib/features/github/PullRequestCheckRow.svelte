<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { checkLook } from "@canopy/domain/github-pr";
  import { safeHref } from "@canopy/domain/markdown";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import PullRequestJobs from "./PullRequestJobs.svelte";
  import { toneClasses } from "./presentation.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import CiActions from "./CiActions.svelte";

  let {
    snapshot,
    check,
    class: className,
  }: { snapshot: github.PullRequestSnapshot; check: github.PullRequestCheck; class?: ClassValue } = $props();

  const id = $derived(snapshot.summary?.ref?.id ?? "");
  let open = $state(false);
  const look = $derived(checkLook(check.state));
</script>

<li class={["min-w-0 text-sm/5 sm:text-xs/5", className]}>
  <div class="flex min-w-0 items-center pr-2">
    <button
      type="button"
      title={`${check.name} · ${look.label}`}
      aria-label={`${check.name}, ${look.label}`}
      aria-expanded={open}
      onclick={() => (open = !open)}
      class="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left focus-ring hover:bg-zinc-950/3 sm:min-h-9 dark:hover:bg-white/5"
    >
      <span {@attach tooltip(look.label)}
        ><Icon name={look.icon} label={look.label} tone="inherit" class={toneClasses[look.tone]} /></span
      >
      <p class="min-w-0 flex-1 truncate font-medium" title={check.name}>{check.name}</p>
      <p class="max-w-24 truncate text-zinc-500 max-sm:hidden dark:text-zinc-400">{check.provider}</p>
      <Icon name={open ? "chevron-down" : "chevron-right"} />
    </button>
    <CiActions {snapshot} runId={check.runId} state={check.state} name={check.name} />
  </div>
  {#if open}
    {#if check.runId}<PullRequestJobs {snapshot} runId={check.runId} />
    {:else if check.output}<div class="p-3"><Markdown text={check.output} /></div>{/if}
    {#if safeHref(check.url)}<a
        href={safeHref(check.url)}
        target="_blank"
        rel="noreferrer"
        class="flex min-h-9 items-center px-3 text-zinc-500 hover:underline">Open check on provider</a
      >{/if}
  {/if}
</li>
