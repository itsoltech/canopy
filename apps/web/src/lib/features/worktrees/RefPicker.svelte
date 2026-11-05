<script lang="ts">
  import type { GitRef, GitRefs } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import RefLabel from "#lib/shared/ui/RefLabel.svelte";
  import { pop, swap } from "#lib/shared/ui/motion.ts";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";

  /**
   * The branch next to the workspace pill (docs/worktrees.md). For a new worktree it is the base ref and can be
   * searched; for the checkout or a previous worktree it only shows the branch: switching the checkout here could
   * change files under threads that work in it.
   */
  let {
    refs,
    branch,
    editable,
    onselect,
    class: className,
  }: {
    class?: ClassValue;
    refs: GitRefs;
    branch: string;
    editable: boolean;
    onselect: (ref: GitRef) => void;
  } = $props();

  const marks = (ref: GitRef) =>
    [ref.name === refs.defaultBranch && "default", !ref.remote && ref.name === refs.currentBranch && "current"].filter(
      Boolean,
    );

  const priority = (ref: GitRef) => (ref.name === refs.defaultBranch ? 0 : ref.name === refs.currentBranch ? 1 : 2);

  // Stable grouping keeps the default/current first, then the worker's recency order within each group.
  const groupedRefs = $derived(
    [...refs.refs].sort((a, b) => Number(a.remote) - Number(b.remote) || priority(a) - priority(b)),
  );
</script>

{#if branch || editable}
  <div class={["min-w-0", className]} transition:pop>
    {#if editable}
      <SearchPicker
        label="Choose a base ref"
        searchLabel="Search refs"
        placeholder="Search refs…"
        items={groupedRefs}
        key={(ref) => ref.name}
        text={(ref) => ref.name}
        value={branch}
        {onselect}
        groupOf={(ref) => (ref.remote ? "Remote branches" : "Branches")}
      >
        {#snippet trigger(props)}
          <PillButton {...props} class="w-full max-w-full" aria-label="Base ref: {branch || 'default branch'}">
            <Icon name="git-fork" class="size-3.5 shrink-0" />
            <RefLabel value={branch || "HEAD"} class="text-zinc-800 dark:text-zinc-200" />
          </PillButton>
        {/snippet}
        {#snippet option(ref, state)}
          <PickerRow title={ref.name} selected={state.selected} class="min-w-0 font-mono">
            {#snippet leading()}<Icon name="git-fork" />{/snippet}
            {#snippet trailing()}
              <div class="flex flex-wrap gap-1 py-px pl-px">
                {#each marks(ref) as mark (mark)}<Badge
                    compact
                    tone={mark === "current" ? "sky" : "neutral"}
                    class="font-sans">{mark}</Badge
                  >{/each}
              </div>
            {/snippet}
          </PickerRow>
        {/snippet}
        {#snippet empty(query)}No refs match “{query}”.{/snippet}
      </SearchPicker>
    {:else if branch}
      <div
        data-composer-branch
        class="flex min-h-8 min-w-0 items-center gap-1.5 px-2 text-sm/5 text-zinc-500 sm:text-[0.8125rem]/5 dark:text-zinc-400"
        title={branch}
      >
        <Icon name="git-fork" size="sm" />{#key branch}<span class="min-w-0" in:swap><RefLabel value={branch} /></span
          >{/key}
      </div>
    {/if}
  </div>
{/if}
