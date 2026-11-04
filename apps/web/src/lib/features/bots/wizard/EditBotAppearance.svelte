<script lang="ts" module>
  export type { BotAppearanceDraft } from "./draft.ts";
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import BotFormDialog from "./BotFormDialog.svelte";
  import AppearanceFields from "./AppearanceFields.svelte";
  import type { BotAppearanceDraft } from "./draft.ts";

  /** existingNames may include this bot's current name once; it stays valid until another bot owns it. */
  let {
    open = $bindable(false),
    value = $bindable(),
    existingNames,
    onsave,
    inline = false,
    originalName,
    disabled = false,
    class: className,
  }: {
    open?: boolean;
    value: BotAppearanceDraft;
    existingNames: readonly string[];
    onsave?: (draft: BotAppearanceDraft) => Promise<void>;
    inline?: boolean;
    originalName?: string | undefined;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();
</script>

{#if inline}
  <AppearanceFields
    bind:name={value.name}
    bind:shape={value.shape}
    bind:color={value.color}
    {existingNames}
    {originalName}
    {disabled}
    class={className}
  />
{:else}
  <BotFormDialog bind:open initial={value} {existingNames} {onsave} class={className} />
{/if}
