<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import type { UpdateStatus } from "@canopy/domain/release/update-status";
  import UpdateBadge from "./UpdateBadge.svelte";
  import UpdatePercent from "./UpdatePercent.svelte";
  import UpdateProgress from "./UpdateProgress.svelte";

  /**
   * The name, status and action share a row. Installed and target versions stay visible above status details or errors.
   */
  let {
    name,
    title = name,
    wrapName = false,
    icon,
    current,
    target = "",
    status,
    line = "",
    linePercent,
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
    wrapName?: boolean;
    icon: IconName;
    current: string;
    target?: string | undefined;
    status: UpdateStatus | string;
    /** More detail about this update state. */
    line?: string;
    linePercent?: number | undefined;
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
      <div class={["flex min-h-5 min-w-0 items-start gap-2", !wrapName && "h-5"]}>
        <p class={["min-w-0 flex-1 text-sm/5 font-medium", wrapName ? "break-anywhere" : "truncate"]} {title}>{name}</p>
        <!-- Every shared word fits the slot, so state changes never move the name; a rare long edge word widens it. -->
        <span class="flex min-h-5 min-w-28 shrink-0 items-center justify-end sm:min-w-23"><UpdateBadge {status} /></span
        >
      </div>
      <p class="break-anywhere mt-0.5 font-mono text-xs/4 text-muted tabular-nums select-text" title={versions}>
        {versions}
      </p>
    </div>
    <div class="flex w-8 shrink-0 items-center justify-center self-start sm:w-7">{@render action?.()}</div>
  </div>
  {#if error || line}
    <div class="mt-1 ml-6 min-w-0 text-xs/4">
      {#if error}
        <button
          type="button"
          class="flex w-full min-w-0 rounded text-left text-rose-600 focus-ring dark:text-rose-400 desktop:cursor-pointer"
          aria-expanded={expanded}
          title={error}
          onclick={() => (expanded = !expanded)}
        >
          {#key error}<span
              class={[
                "t-swap min-w-0",
                expanded ? "break-anywhere max-h-40 scroll-stable overflow-y-auto select-text" : "truncate",
              ]}>{error}</span
            >{/key}
        </button>
        {#if expanded && errorActions}
          <div class="mt-1 grid gap-1">{@render errorActions()}</div>
        {/if}
      {:else}
        {#key line}<p
            class={[
              "t-swap break-anywhere tabular-nums",
              lineTone === "amber" ? "text-amber-700 dark:text-amber-400" : "text-muted",
            ]}
          >
            {line}
            {#if linePercent !== undefined}
              · <UpdatePercent value={linePercent} />
            {/if}
          </p>{/key}
      {/if}
    </div>
  {/if}
  {#if busy}<UpdateProgress
      label={`${name}: ${status}`}
      value={progress}
      class="t-rise absolute right-0 bottom-0.5 left-6"
    />{/if}
</div>
