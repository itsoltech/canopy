<script lang="ts">
  import type { AgentToolActions } from "./agent-tools.svelte.ts";
  import ActionNote from "#lib/features/workers/ActionNote.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";

  let { actions, actionKey }: { actions: AgentToolActions; actionKey: string } = $props();
</script>

<ActionNote error={actions.errors[actionKey]} note={actions.notes[actionKey]} />
{#if actions.details[actionKey]}
  <Disclosure>
    {#snippet summary()}<span class="text-sm/5 text-zinc-500 dark:text-zinc-400">Show details</span>{/snippet}
    <div class="pt-2"><CodeBlock text={actions.details[actionKey]} label="Tool request details" /></div>
  </Disclosure>
{/if}
