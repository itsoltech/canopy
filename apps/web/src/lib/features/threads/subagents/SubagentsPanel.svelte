<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import { providerKeyOf } from "../providers.ts";
  import ComposerPanelHeader from "../components/ComposerPanelHeader.svelte";
  import SubagentRow from "./SubagentRow.svelte";
  import { subagentSummary, type Subagent } from "./subagents.ts";

  /**
   * A thread's subagents, attached above the composer like the queue (and stacked above it): one line that sums
   * them up ("3 subagents · 2 running · 1 done") with the providers they run on, opening into a row per subagent
   * (accordion, motion.css `t-acc-panel`). Live from the thread index; `class` sets the overlap with what is below.
   */
  let { subagents, embedded = false, class: className }: { subagents: readonly Subagent[]; embedded?: boolean; class?: ClassValue } = $props();

  const id = $props.id();
  let open = $state(false);
  const summary = $derived(subagentSummary(subagents));
  const providers = $derived([...new Set(subagents.map((s) => providerKeyOf(s.thread.provider)).filter((p) => p !== undefined))]);
</script>

<section aria-labelledby="{id}-summary" class={[!embedded && "rounded-t-2xl bg-white ring-1 ring-zinc-950/10 dark:bg-zinc-950 dark:ring-white/10", className]}>
  <ComposerPanelHeader
    expanded={open}
    controls="{id}-list"
    onclick={() => (open = !open)}
  >
    <Icon name="sparkles" size="sm" class="fill-violet-500 dark:fill-violet-400" />
    <p id="{id}-summary" class="min-w-0 flex-1 truncate text-zinc-700 tabular-nums dark:text-zinc-300">
      {#key summary}<span in:swap>{summary}</span>{/key}
    </p>
    <span class="flex shrink-0 items-center gap-1" aria-hidden="true">
      {#each providers as provider (provider)}<ProviderIcon {provider} size="sm" class="opacity-70" />{/each}
    </span>
  </ComposerPanelHeader>
  <div id="{id}-list" class="t-acc-panel" data-open={open || undefined} inert={!open}>
    <div>
      <ul role="list" class="grid max-h-[30dvh] overflow-y-auto border-t border-zinc-950/5 py-1 dark:border-white/10">
        {#each subagents as subagent (subagent.thread.id)}
          <li><SubagentRow {subagent} /></li>
        {/each}
      </ul>
    </div>
  </div>
</section>
