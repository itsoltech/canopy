<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import type { UpdateStatus } from "@canopy/domain/release/update-status";
  import UpdateBadge from "./UpdateBadge.svelte";
  import UpdateProgress from "./UpdateProgress.svelte";

  /**
   * One update row (docs/updates.md): always two lines. A state change swaps the badge and the second line; the bar
   * sits in the bottom padding and the action keeps its slot, so nothing moves. Only an error expands, on request.
   */
  let {
    name,
    title = name,
    icon,
    current,
    target = "",
    status,
    line = "",
    lineTone,
    error = "",
    busy = false,
    progress,
    action,
    errorActions,
    class: className,
  }: {
    name: string;
    /** The full name in the tooltip when the row shows a shorter one ("This computer"). */
    title?: string;
    icon: IconName;
    current: string;
    target?: string | undefined;
    status: UpdateStatus | string;
    /** Replaces the versions on the second line: a state that says more than them. */
    line?: string;
    lineTone?: "amber" | undefined;
    error?: string;
    busy?: boolean;
    progress?: number | undefined;
    /** At most one icon button: Update, Restart to update, Retry, Install or details. */
    action?: Snippet | undefined;
    /** Shown with the full error once it is expanded (Dismiss). */
    errorActions?: Snippet | undefined;
    class?: ClassValue;
  } = $props();

  let expanded = $state(false);
  const versions = $derived(`${current || "Version unknown"}${target && target !== current ? ` → ${target}` : ""}`);
</script>

<div class={["relative min-w-0 py-2", className]}>
  <div class="flex min-w-0 items-center gap-2">
    <span class="flex h-5 shrink-0 items-center self-start"><Icon name={icon} /></span>
    <div class="min-w-0 flex-1">
      <div class="flex h-5 min-w-0 items-center gap-2">
        <p class="min-w-0 flex-1 truncate text-sm/5 font-medium" {title}>{name}</p>
        <!-- Every shared word fits the slot, so state changes never move the name; a rare long edge word widens it. -->
        <span class="flex min-w-28 shrink-0 justify-end sm:min-w-23"><UpdateBadge {status} /></span>
      </div>
      {#if error}
        <button
          type="button"
          class="mt-0.5 flex h-4 w-full min-w-0 rounded text-left text-xs/4 text-rose-600 focus-ring dark:text-rose-400"
          aria-expanded={expanded}
          title={error}
          onclick={() => (expanded = !expanded)}
        >
          {#key error}<span class="t-swap min-w-0 truncate">{error}</span>{/key}
        </button>
      {:else}
        <p
          class={[
            "mt-0.5 flex h-4 min-w-0 text-xs/4 tabular-nums",
            line ? "" : "font-mono select-text",
            lineTone === "amber" ? "text-amber-700 dark:text-amber-400" : "text-muted",
          ]}
          title={line || versions}
        >
          {#key line || versions}<span class="t-swap min-w-0 truncate">{line || versions}</span>{/key}
        </p>
      {/if}
    </div>
    <div class="flex w-8 shrink-0 items-center justify-center sm:w-7">{@render action?.()}</div>
  </div>
  {#if busy}<UpdateProgress
      label={`${name}: ${status}`}
      value={progress}
      class="t-rise absolute right-0 bottom-0.5 left-6"
    />{/if}
  {#if error && expanded}
    <div class="mt-1 ml-6 grid gap-1">
      <p
        class="break-anywhere max-h-40 scroll-stable overflow-y-auto text-xs/5 text-rose-600 select-text dark:text-rose-400"
      >
        {error}
      </p>
      {@render errorActions?.()}
    </div>
  {/if}
</div>
