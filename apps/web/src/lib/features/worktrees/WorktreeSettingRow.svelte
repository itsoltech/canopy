<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
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
    control,
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

<SettingsRow {title} {description} {control} class={className}>
  <p class="mt-1 flex flex-wrap items-center gap-x-2 text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
    <span>{overridden ? `Overrides ${inherited}` : "Inherited"} · {sourceLabel}</span>
    {#if overridden}<Button size="sm" variant="ghost" icon="arrow-uturn-left" onclick={onreset}>Reset</Button>{/if}
  </p>
</SettingsRow>
