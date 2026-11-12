<script lang="ts">
  import { untrack } from "svelte";
  import EffortLabel from "./EffortLabel.svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Slider from "#lib/shared/ui/Slider.svelte";
  import SwapText from "#lib/shared/ui/SwapText.svelte";
  import { effectiveEffort, effortLevel, providerName, shortModelName, type ModelOption } from "./catalog.ts";

  /**
   * Reasoning effort (ChatGPT's picker): a pill naming the effort opens a compact popover — the effort's
   * name in the accent, centred, the model under it (opens the model picker), a reset to the default in
   * the corner and a pill slider over the model's supported efforts. The name swaps along the slider's
   * direction when it changes. `value` undefined = the default: `inherited` (the thread's) when the model
   * takes it, else the model's own; without either the provider decides ("Default", hollow thumb, no fill).
   * While the effort in force is the default, a muted "Default" sits beside its name.
   */
  let {
    option,
    value = $bindable(),
    inherited,
    open = $bindable(false),
    onmodel,
    class: className,
  }: {
    option: ModelOption;
    value?: string | undefined;
    /** Effort that applies when none is chosen (a thread's default). */
    inherited?: string | undefined;
    open?: boolean;
    /** Open the model picker (the model line in the popover). */
    onmodel: () => void;
    class?: ClassValue;
  } = $props();

  const steps = $derived(option.efforts.map((e) => ({ value: e.id, label: e.label })));
  const fallback = $derived(effectiveEffort(option, inherited));
  const current = $derived(value ?? fallback);
  const label = $derived(current ? effortLevel(current).label : "Default");
  const rank = $derived(option.efforts.findIndex((e) => e.id === current));
  const isDefault = $derived(fallback !== undefined && current === fallback);

  // While the picker is open the pill keeps the name it had when it opened, so neither it, the model pill beside
  // it nor the popover anchored to it moves as the effort changes; on close the name swaps in.
  let frozen = $state<{ label: string; rank: number }>();

  $effect(() => {
    frozen = open ? untrack(() => ({ label, rank })) : undefined;
  });

  const pillLabel = $derived(frozen?.label ?? label);
  const pillRank = $derived(frozen?.rank ?? rank);
</script>

<!-- rounded-*! wins over the panel's own rounded-xl (same specificity, later in the stylesheet). The radius
     is concentric with the slider's track: half its height (28px, sm 24px) plus the panel's p-3. -->
<Popover
  bind:open
  label="Reasoning effort"
  placement="top-start"
  class="w-[min(16rem,calc(100vw-1rem))] rounded-[1.625rem]! sm:rounded-3xl!"
>
  {#snippet trigger(props)}
    <PillButton
      {...props}
      class={["pl-1.5", className]}
      aria-label="Reasoning effort: {label}{isDefault && current ? ' (default)' : ''}"
    >
      <Icon
        name="light-bulb"
        class={["size-3.5", value ? "fill-zinc-500 dark:fill-zinc-400" : "fill-zinc-400 dark:fill-zinc-500"]}
      />
      <EffortLabel label={pillLabel} rank={pillRank} total={option.efforts.length} />
    </PillButton>
  {/snippet}

  <div class="relative grid gap-3 p-3">
    <div class="absolute top-1.5 right-1.5">
      <IconButton
        icon="arrow-path"
        size="sm"
        label={fallback ? `Reset to the default (${effortLevel(fallback).label})` : "Reset to the default"}
        disabled={!value}
        onclick={(event) => {
          value = undefined;
          // The button disables itself: keep focus in the popover, on the slider.
          event.currentTarget.closest("[popover]")?.querySelector<HTMLElement>("[role=slider]")?.focus();
        }}
      />
    </div>
    <div class="grid justify-items-center px-8 pt-1 text-center">
      <div class="relative flex text-lg/7 font-medium text-brand-600 dark:text-brand-400">
        <SwapText text={label} {rank} distance="base" align="center" />
        {#if isDefault}
          <div
            class="absolute inset-y-0 left-full ml-1.5 flex items-center text-xs/4 font-normal whitespace-nowrap text-zinc-400 dark:text-zinc-500"
            in:swap
          >
            Default
          </div>
        {/if}
      </div>
      <button
        type="button"
        class="flex max-w-full min-w-0 items-center gap-0.5 rounded-md px-1 text-base/6 text-zinc-500 focus-ring hover:text-zinc-950 sm:text-sm/5 dark:text-zinc-400 dark:hover:text-white"
        aria-label="Model: {option.name}"
        onclick={() => {
          open = false;
          onmodel();
        }}
      >
        <span class="truncate">{shortModelName(option.name)}</span>
        <Icon name="chevron-right" class="size-3.5 shrink-0 fill-zinc-400 dark:fill-zinc-500" />
      </button>
    </div>
    <Slider
      {steps}
      variant="pill"
      label="Reasoning effort"
      unsetLabel="Default"
      value={current}
      onchange={(next) => (value = next)}
      autofocus
    />
    <!-- Shown whatever the value (it is about the model), so choosing one never resizes the popover. -->
    {#if !fallback}
      <p class="text-center text-sm/5 text-pretty text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
        {option.name} has no default effort listed: {providerName(option.provider)} uses its own.
      </p>
    {/if}
  </div>
</Popover>
