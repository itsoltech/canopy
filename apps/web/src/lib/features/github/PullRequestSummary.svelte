<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Markdown from "./GitHubMarkdown.svelte";
  import PullRequestPeople from "./PullRequestPeople.svelte";
  import PullRequestLabels from "./PullRequestLabels.svelte";
  import PullRequestChecks from "./PullRequestChecks.svelte";
  import MetadataEdit from "./MetadataEdit.svelte";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  let display = $state<github.PullRequestMetadata>();
  const body = $derived(display?.body ?? snapshot.body);
</script>

<article class={["grid min-w-0 gap-5 text-zinc-800 dark:text-zinc-200", className]}>
  <PullRequestPeople {snapshot} />
  <PullRequestLabels {snapshot} />
  <PullRequestChecks {snapshot} />
  <section
    aria-label="Description"
    class="relative grid min-w-0 gap-3 border-t border-zinc-950/5 pt-4 dark:border-white/10"
  >
    <h3 class="text-sm/5 font-medium text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Description</h3>
    <MetadataEdit
      {snapshot}
      kind="description"
      ondisplay={(value) => (display = value)}
      class="[&>button]:absolute [&>button]:top-3 [&>button]:right-0"
    />
    {#if body}<Markdown
        text={body}
        pullRequestId={snapshot.summary?.ref?.id ?? ""}
        contentId={snapshot.summary?.ref?.nodeId ?? ""}
        class="min-w-0 [overflow-wrap:anywhere]"
      />{:else}<p class="text-sm text-zinc-500 dark:text-zinc-400">No description provided</p>{/if}
  </section>
</article>
