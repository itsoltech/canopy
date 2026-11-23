<script lang="ts">
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ResettableControl from "#lib/shared/ui/ResettableControl.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { providerName, type ModelOption } from "./catalog.ts";
  import ModelControls from "./ModelControls.svelte";

  let {
    options,
    option = $bindable(),
    effort = $bindable(),
    workerId,
    resetLabel,
    automaticEffort = false,
    disabled = false,
    missingSelection,
  }: {
    options: readonly ModelOption[];
    option?: ModelOption | undefined;
    effort?: string | undefined;
    workerId?: string | undefined;
    resetLabel: string;
    automaticEffort?: boolean;
    disabled?: boolean;
    missingSelection?: string | undefined;
  } = $props();

  const summary = $derived(option ? `${providerName(option.provider)} · ${option.profileName}` : missingSelection);
</script>

<div class="flex min-w-0 flex-wrap items-center gap-2">
  <fieldset {disabled} class="max-w-full min-w-0 disabled:opacity-50">
    <ResettableControl changed={!!effort} align="start">
      {#key disabled}
        <ModelControls {options} bind:option bind:effort {automaticEffort} {workerId} allowCustom={false} />
      {/key}
      {#snippet reset()}
        <IconButton icon="arrow-path" label={resetLabel} size="sm" onclick={() => (effort = undefined)} />
      {/snippet}
    </ResettableControl>
  </fieldset>
  {#if summary}
    <TruncatedText text={summary} class="max-w-full text-base/6 text-muted sm:text-sm/6" />
  {/if}
</div>
