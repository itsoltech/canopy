<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";

  let { error, class: className }: { error: connectors.ConnectorError; class?: ClassValue } = $props();
</script>

<Alert tone="error" class={className}>
  <div class="grid min-w-0 gap-2">
    <p class="text-pretty">{error.message}</p>
    {#if error.detail}
      <Disclosure class="min-w-0">
        {#snippet summary()}Show details{/snippet}
        <div class="flex min-w-0 items-start gap-2 py-2">
          <pre class="min-w-0 flex-1 font-mono break-words whitespace-pre-wrap select-text">{error.detail}</pre>
          <CopyButton text={error.detail} label="Copy error details" />
        </div>
      </Disclosure>
    {/if}
  </div>
</Alert>
