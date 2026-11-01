<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Slider from "#lib/shared/ui/Slider.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { effectiveEffort, effortLevel, providerName, type ModelOption } from "./catalog.ts";
  import ProviderIcon from "./ProviderIcon.svelte";

  /**
   * Reasoning effort (ChatGPT-style): a pill opens a compact popover — the effort's name, the model under
   * it (opens the model picker), a reset to the default, and a slider over the model's supported efforts.
   * `value` undefined = the default: `inherited` (the thread's) when the model takes it, else the model's
   * own; without either the provider decides ("Default", hollow slider thumb). Until you choose, the pill
   * names the default; after, it is just the icon (the model pill shows the effort).
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

  const steps = $derived(option.efforts.map((e) => ({ value: e.id, label: e.short })));
  const fallback = $derived(effectiveEffort(option, inherited));
  const fallbackLabel = $derived(fallback ? effortLevel(fallback).label : undefined);
  const level = $derived(value ? effortLevel(value) : undefined);
</script>

<Popover bind:open label="Reasoning effort" placement="top-start" class="w-[min(20rem,calc(100vw-1rem))]">
  {#snippet trigger(props)}
    {#if value}
      <PillButton {...props} class={["pl-1.5", className]} aria-label="Reasoning effort: {level?.label}" {@attach tooltip(`Effort: ${level?.label}`)}>
        <Icon name="light-bulb" class="size-3.5 fill-zinc-500 dark:fill-zinc-400" />
      </PillButton>
    {:else}
      <PillButton {...props} class={["pl-1.5", className]} aria-label="Reasoning effort: default{fallbackLabel ? ` (${fallbackLabel})` : ''}">
        <Icon name="light-bulb" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
        <span class="truncate">{fallbackLabel ?? "Default"}</span>
      </PillButton>
    {/if}
  {/snippet}

  <div class="grid gap-4 p-4">
    <div class="flex items-start gap-3">
      <div class="grid min-w-0 flex-1 gap-0.5">
        <p class="text-lg/7 font-medium text-zinc-950 dark:text-white" aria-live="polite">
          {#if level}{level.label}{:else if fallbackLabel}{fallbackLabel} <span class="font-normal text-zinc-500 dark:text-zinc-400">· default</span>{:else}Default{/if}
        </p>
        <button
          type="button"
          class="-ml-1 flex min-w-0 items-center gap-1.5 justify-self-start rounded-md px-1 text-left text-base/6 text-zinc-500 focus-ring hover:text-zinc-950 sm:text-sm/5 dark:text-zinc-400 dark:hover:text-white"
          onclick={() => {
            open = false;
            onmodel();
          }}
        >
          <ProviderIcon provider={option.provider} class="size-3.5" />
          <span class="truncate">{option.name}</span>
          <Icon name="chevron-right" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
        </button>
      </div>
      <IconButton
        icon="arrow-uturn-left"
        size="sm"
        label={fallbackLabel ? `Reset to the default (${fallbackLabel})` : "Reset to the default"}
        disabled={!value}
        onclick={(event) => {
          value = undefined;
          // The button disables itself: keep focus in the popover, on the slider.
          event.currentTarget.closest("[popover]")?.querySelector<HTMLElement>("[role=slider]")?.focus();
        }}
      />
    </div>
    <Slider {steps} label="Reasoning effort" unsetLabel="Default" value={value ?? fallback} onchange={(next) => (value = next)} autofocus />
    {#if !value && !fallback}
      <p class="text-sm/5 text-pretty text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{option.name} has no default effort listed: {providerName(option.provider)} uses its own.</p>
    {/if}
  </div>
</Popover>
