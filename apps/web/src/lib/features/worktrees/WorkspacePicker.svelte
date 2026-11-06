<script lang="ts">
  import { headLabel, shortWorktreePath } from "@canopy/domain/git-heads";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import { choiceIcon, type WorkspaceChoice } from "./workspace-draft.svelte.ts";
  import { swap } from "#lib/shared/ui/motion.ts";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";

  /**
   * The new-thread composer's workspace pill (docs/worktrees.md): the project's checkout, a new git worktree, or
   * a previous worktree of this project on the chosen machine. The footer links to the worktree settings.
   */
  let {
    choice,
    worktrees,
    onselect,
    class: className,
    note,
    warning = false,
    onopen,
  }: {
    class?: ClassValue;
    note?: string | undefined;
    warning?: boolean;
    choice: WorkspaceChoice;
    worktrees: readonly ui.ThreadWorktree[];
    onselect: (choice: WorkspaceChoice) => void;
    onopen?: () => void;
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
      title: headLabel(w),
      detail: w.path,
    })),
  ]);

  const value = $derived(choice.kind === "existing" ? choice.worktree.id : choice.kind);
  let open = $state(false);

  $effect(() => {
    if (open) onopen?.();
  });

  const label = $derived(
    choice.kind === "existing"
      ? headLabel(choice.worktree)
      : choice.kind === "new"
        ? "New worktree"
        : "Current checkout",
  );
</script>

<div class={["flex min-w-0 items-center", className]}>
  <SearchPicker
    label="Choose a workspace"
    searchLabel="Search worktrees"
    placeholder="Search worktrees…"
    {items}
    bind:open
    key={(item) => item.key}
    text={(item) => `${item.title} ${item.detail}`}
    disabled={(item) => item.choice.kind === "existing" && Boolean(item.choice.worktree.unavailableReason)}
    {value}
    onselect={(item) => onselect(item.choice)}
    groupOf={(item) =>
      item.choice.kind === "existing"
        ? item.choice.worktree.external
          ? "Created outside Canopy"
          : "Managed by Canopy"
        : "Workspace"}
    link={{ href: "/settings/worktrees", label: "Worktree settings" }}
  >
    {#snippet trigger(props)}
      <PillButton {...props} class="min-w-0 flex-1" aria-label="Workspace: {label}">
        <Icon name={choiceIcon(choice)} class="size-3.5 shrink-0" />
        {#key choice.kind}<span class="min-w-0 truncate text-zinc-800 dark:text-zinc-200" in:swap>
            <span class="@max-[34rem]/context:hidden">{label}</span>
            <span class="@min-[34rem]/context:hidden"
              >{choice.kind === "checkout" ? "Checkout" : choice.kind === "new" ? "New" : "Worktree"}</span
            >
          </span>{/key}
      </PillButton>
    {/snippet}
    {#snippet option(item, state)}
      <div title={item.choice.kind === "existing" ? item.detail : undefined}>
        <PickerRow
          title={item.title}
          detail={item.choice.kind === "existing" ? shortWorktreePath(item.detail) : item.detail}
          status={item.choice.kind === "existing" ? item.choice.worktree.unavailableReason : undefined}
          selected={state.selected}
          detailClass={item.choice.kind === "existing" ? "font-mono" : undefined}
        >
          {#snippet leading()}
            <Icon name={choiceIcon(item.choice)} />
          {/snippet}
        </PickerRow>
      </div>
    {/snippet}
    {#snippet empty(query)}No worktrees match “{query}”.{/snippet}
  </SearchPicker>
  {#if note}<HintIcon label="Workspace information" text={note} {warning} />{/if}
</div>
