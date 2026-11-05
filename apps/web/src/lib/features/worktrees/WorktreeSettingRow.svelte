<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import ResettableControl from "#lib/shared/ui/ResettableControl.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { getContext } from "svelte";
  import type { WorktreeField, WorktreeSettingsState } from "./worktree-settings.svelte.ts";

  /**
   * One worktree setting: its control, and when this scope overrides it, what it would inherit and a reset
   * (docs/worktrees.md, "Ustawienia i zakresy").
   */
  let {
    title,
    field,
    description,
    overridden,
    inherited,
    onreset,
    control: rowControl,
    class: className,
  }: {
    title: string;
    field: WorktreeField;
    description: string;
    /** This scope sets the value itself. */
    overridden: boolean;
    /** The value from broader scopes and the defaults, for the hint. */
    inherited: string;
    onreset: () => void;
    control: Snippet;
    class?: ClassValue;
  } = $props();

  const settingsState = getContext<WorktreeSettingsState>("worktree-settings");
  const overview = useOverview();
  const source = $derived(settingsState.current?.inheritedSources.find((s) => s.field === field));

  const sourceLabel = $derived(
    source
      ? `${source.projectId ? (overview.project(source.projectId)?.name ?? "Project") : "All projects"} · ${source.workerId ? (overview.worker(source.workerId)?.name ?? "Computer") : "All computers"}`
      : "Canopy defaults",
  );
</script>

<SettingsRow {title} {description} class={className}>
  {#snippet control()}
    <ResettableControl changed={overridden}>
      {@render rowControl()}
      {#snippet reset()}<Button size="sm" variant="ghost" icon="arrow-uturn-left" onclick={onreset}>Reset</Button
        >{/snippet}
    </ResettableControl>
  {/snippet}
  <p class="mt-1 grid text-base/6 wrap-anywhere text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
    <span class="invisible col-start-1 row-start-1" aria-hidden="true">Overrides {inherited} · {sourceLabel}</span>
    <span class="col-start-1 row-start-1">{overridden ? `Overrides ${inherited}` : "Inherited"} · {sourceLabel}</span>
  </p>
</SettingsRow>
