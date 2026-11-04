<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatRelative } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import { choiceIcon, type WorkspaceChoice } from "./workspace-draft.svelte.ts";

  /**
   * The new-thread composer's workspace pill (docs/worktrees.md): the project's checkout, a new git worktree, or
   * a previous worktree of this project on the chosen machine. The footer links to the worktree settings.
   */
  let {
    choice,
    worktrees,
    onselect,
    class: className,
  }: {
    class?: ClassValue;
    choice: WorkspaceChoice;
    worktrees: readonly ui.ThreadWorktree[];
    onselect: (choice: WorkspaceChoice) => void;
  } = $props();

  interface Item {
    readonly key: string;
    readonly choice: WorkspaceChoice;
    readonly title: string;
    readonly detail: string;
  }

  const items = $derived<Item[]>([
    {
      key: "checkout",
      choice: { kind: "checkout" },
      title: "Current checkout",
      detail: "Works in the project's directory",
    },
    { key: "new", choice: { kind: "new" }, title: "New worktree", detail: "A new branch in its own directory" },
    ...worktrees.map((w) => ({
      key: w.id,
      choice: { kind: "existing", worktree: w } as const,
      title: w.branch,
      detail: `Created ${formatRelative(w.createdAt)}`,
    })),
  ]);

  const value = $derived(choice.kind === "existing" ? choice.worktree.id : choice.kind);

  const label = $derived(
    choice.kind === "existing" ? choice.worktree.branch : choice.kind === "new" ? "New worktree" : "Current checkout",
  );
</script>

<SearchPicker
  label="Choose a workspace"
  searchLabel="Search worktrees"
  placeholder="Search worktrees…"
  {items}
  key={(item) => item.key}
  text={(item) => item.title}
  {value}
  onselect={(item) => onselect(item.choice)}
  groupOf={(item) => (item.choice.kind === "existing" ? "Previous worktrees" : "Workspace")}
  link={{ href: "/settings/worktrees", label: "Worktree settings" }}
>
  {#snippet trigger(props)}
    <PillButton {...props} class={["max-w-56", className]} aria-label="Workspace: {label}">
      <Icon name={choiceIcon(choice)} class="size-3.5 shrink-0" />
      <span class="truncate text-zinc-800 dark:text-zinc-200">{label}</span>
    </PillButton>
  {/snippet}
  {#snippet option(item, state)}
    <PickerRow
      title={item.title}
      detail={item.detail}
      selected={state.selected}
      detailClass={item.choice.kind === "existing" ? "font-mono" : undefined}
    >
      {#snippet leading()}
        <Icon name={choiceIcon(item.choice)} />
      {/snippet}
    </PickerRow>
  {/snippet}
  {#snippet empty(query)}No worktrees match “{query}”.{/snippet}
</SearchPicker>
