<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import PullRequestPeople from "./PullRequestPeople.svelte";
  import PullRequestLabels from "./PullRequestLabels.svelte";
  import PullRequestChecks from "./PullRequestChecks.svelte";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
</script>

<article class={["grid min-w-0 gap-5 text-zinc-800 dark:text-zinc-200", className]}>
  <PullRequestPeople {snapshot} />
  <PullRequestLabels {snapshot} />
  <PullRequestChecks {snapshot} />
  <section aria-label="Description" class="grid min-w-0 gap-3 border-t border-zinc-950/5 pt-4 dark:border-white/10">
    <h3 class="text-sm/5 font-medium text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Description</h3>
    {#if snapshot.body}<Markdown text={snapshot.body} />{:else}<p class="text-sm text-zinc-500 dark:text-zinc-400">
        No description provided
      </p>{/if}
  </section>
</article>
