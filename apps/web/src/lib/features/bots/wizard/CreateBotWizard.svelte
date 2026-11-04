<script lang="ts" module>
  export type { BotProviderInstance, CreateBotDraft } from "./draft.ts";
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import BotFormDialog from "./BotFormDialog.svelte";
  import type { BotProviderInstance, CreateBotDraft } from "./draft.ts";

  /** Presentational: the caller supplies availability and persists the validated draft. */
  let {
    open = $bindable(false),
    instances,
    existingNames,
    oncreate,
    class: className,
  }: {
    open?: boolean;
    instances: readonly BotProviderInstance[];
    existingNames: readonly string[];
    oncreate: (draft: CreateBotDraft) => Promise<void>;
    class?: ClassValue;
  } = $props();
</script>

<BotFormDialog bind:open {instances} {existingNames} {oncreate} class={className} />
