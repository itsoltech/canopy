<script lang="ts" module>
  export type { BotAppearanceDraft } from "./draft.ts";
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import BotFormDialog from "./BotFormDialog.svelte";
  import type { BotAppearanceDraft } from "./draft.ts";

  /** existingNames may include this bot's current name once; it stays valid until another bot owns it. */
  let { open = $bindable(false), value, existingNames, onsave, class: className }: {
    open?: boolean;
    value: BotAppearanceDraft;
    existingNames: readonly string[];
    onsave: (draft: BotAppearanceDraft) => Promise<void>;
    class?: ClassValue;
  } = $props();
</script>

<BotFormDialog bind:open initial={value} {existingNames} {onsave} class={className} />
