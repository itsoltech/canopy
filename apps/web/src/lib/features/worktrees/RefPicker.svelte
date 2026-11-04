<script lang="ts">
  import type { GitRef, GitRefs } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import PillText from "#lib/shared/ui/PillText.svelte";
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
</script>

{#if editable}
  <SearchPicker
    label="Choose a base ref"
    searchLabel="Search refs"
    placeholder="Search refs…"
    items={refs.refs}
    key={(ref) => ref.name}
    text={(ref) => ref.name}
    value={branch}
    {onselect}
    groupOf={(ref) => (ref.remote ? "Remote branches" : "Branches")}
  >
    {#snippet trigger(props)}
      <PillButton {...props} class={["max-w-56", className]} aria-label="Base ref: {branch || 'default branch'}">
        <Icon name="git-fork" class="size-3.5 shrink-0" />
        <span class="truncate font-mono text-zinc-800 dark:text-zinc-200">{branch || "HEAD"}</span>
      </PillButton>
    {/snippet}
    {#snippet option(ref, state)}
      <PickerRow title={ref.name} selected={state.selected} class="font-mono">
        {#snippet leading()}<Icon name="git-fork" />{/snippet}
        {#snippet trailing()}
          {#each marks(ref) as mark (mark)}<Badge
              compact
              tone={mark === "current" ? "sky" : "neutral"}
              class="font-sans">{mark}</Badge
            >{/each}
        {/snippet}
      </PickerRow>
    {/snippet}
    {#snippet empty(query)}No refs match “{query}”.{/snippet}
  </SearchPicker>
{:else if branch}
  <PillText class={["flex max-w-56 min-w-0 items-center gap-1.5 font-mono", className]}>
    <Icon name="git-fork" size="sm" /><span class="truncate">{branch}</span>
  </PillText>
{/if}
