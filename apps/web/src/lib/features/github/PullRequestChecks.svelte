<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { checkLook, checksSummary, sortedChecks } from "@canopy/domain/github-pr";
  import { safeHref } from "@canopy/domain/markdown";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { toneClasses } from "./presentation.ts";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  let expanded = $state(false);
  const checks = $derived(sortedChecks(snapshot.checks));
  const summary = $derived(checksSummary(snapshot));
</script>

<section aria-label="Checks" class={["grid min-w-0 gap-2", className]}>
  <div class="flex min-w-0 items-center justify-between gap-2 text-sm/5 sm:text-xs/5">
    <h3 class="font-medium">{summary}</h3>
    <p class="shrink-0 font-mono text-zinc-500 dark:text-zinc-400" title={snapshot.summary?.headSha}>
      {snapshot.summary?.headSha.slice(0, 7)}
    </p>
  </div>
  <ul
    role="list"
    class="min-w-0 divide-y divide-zinc-950/5 overflow-hidden rounded-lg border border-zinc-950/10 dark:divide-white/5 dark:border-white/10"
  >
    {#each expanded ? checks : checks.slice(0, 5) as check, i (`${check.name}:${i}`)}
      {@const look = checkLook(check.state)}
      {#snippet row()}
        <Icon name={look.icon} tone="inherit" class={toneClasses[look.tone]} />
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium">{check.name}</p>
          <p class="truncate text-zinc-500 sm:hidden dark:text-zinc-400">{check.provider}</p>
        </div>
        <p class="w-24 truncate text-zinc-500 max-sm:hidden dark:text-zinc-400">{check.provider}</p>
        <p class={["w-22 shrink-0 text-right", toneClasses[look.tone]]}>{look.label}</p>
      {/snippet}
      <li title={`${check.name} · ${check.provider} · ${look.label}`} class="min-w-0 text-sm/5 sm:text-xs/5">
        {#if safeHref(check.url)}<a
            href={safeHref(check.url)}
            target="_blank"
            rel="noreferrer"
            class="flex min-h-11 min-w-0 items-center gap-2 px-3 py-1.5 focus-ring hover:bg-zinc-950/3 sm:min-h-9 dark:hover:bg-white/5"
            >{@render row()}</a
          >
        {:else}<div class="flex min-h-11 min-w-0 items-center gap-2 px-3 py-1.5 sm:min-h-9">{@render row()}</div>{/if}
      </li>
    {/each}
  </ul>
  {#if checks.length > 5}<Button
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
      >{expanded ? "Show fewer checks" : `Show ${checks.length - 5} more checks`}</Button
    >{/if}
</section>
