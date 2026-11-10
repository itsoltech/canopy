<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { paletteHeaderClass } from "#lib/features/commands/palette-style.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import DisabledControlHint from "#lib/shared/ui/DisabledControlHint.svelte";

  /** The search row of an Add project step: Back (or a search mark on the first step), the input, an action. */
  let {
    onback,
    onclose,
    children,
    onsubmit,
    actionLabel = "Continue",
    disabledReason,
    busy = false,
    modifiedEnter = false,
    class: className,
  }: {
    onback?: (() => void) | undefined;
    onclose: () => void;
    children: Snippet;
    onsubmit: () => void;
    actionLabel?: string;
    disabledReason?: string | undefined;
    busy?: boolean;
    modifiedEnter?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<div class={[paletteHeaderClass, className]}>
  <div class="step-navigation flex shrink-0 items-center justify-center">
    {#if onback}
      <IconButton icon="arrow-left" label="Back" size="sm" onclick={onback} />
    {:else}
      <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
    {/if}
  </div>
  {@render children()}
  <div class="step-action shrink-0">
    <DisabledControlHint reason={disabledReason} label={actionLabel}>
      <Button
        size="sm"
        variant="primary"
        disabled={Boolean(disabledReason) || busy}
        aria-busy={busy || undefined}
        aria-keyshortcuts={modifiedEnter ? "Control+Enter Meta+Enter" : "Enter"}
        onclick={onsubmit}
      >
        {actionLabel}
        <span class="inline-flex w-4 shrink-0 items-center justify-center" aria-hidden="true">
          {#if busy}<Spinner />{:else}↵{/if}
        </span>
      </Button>
    </DisabledControlHint>
  </div>
  <div class="step-navigation flex shrink-0 items-center justify-center">
    <IconButton icon="x-mark" label="Close" size="sm" onclick={onclose} />
  </div>
</div>

<style>
  .step-navigation {
    width: 2.75rem;
    height: 3rem;
  }

  .step-action :global(button),
  .step-navigation :global(button) {
    min-height: 2.75rem;
  }

  .step-navigation :global(button) {
    min-width: 2.75rem;
  }

  @media (min-width: 40rem) and (pointer: fine) {
    .step-navigation {
      width: 1.75rem;
      height: 2.75rem;
    }

    .step-action :global(button),
    .step-navigation :global(button) {
      min-height: 1.75rem;
      min-width: 0;
    }
  }
</style>
