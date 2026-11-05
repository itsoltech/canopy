<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import PasteCode from "./PasteCode.svelte";

  /**
   * After sign-in starts in the browser, Canopy waits for the app to open; the sign-in code field appears
   * after a few seconds or on request. Before that it is a disclosure for a sign-in that already happened.
   */
  let {
    waiting = false,
    onconnected,
    class: className,
  }: {
    waiting?: boolean;
    onconnected: (account: connectors.ConnectorAccount, alreadyConnected?: boolean) => void;
    class?: ClassValue;
  } = $props();

  let manual = $state(false);

  $effect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => (manual = true), 5000);

    return () => clearTimeout(timer);
  });
</script>

{#if waiting}
  <div class={["grid gap-3 text-base/6 sm:text-sm/6", className]}>
    <p role="status" class="text-pretty text-zinc-600 dark:text-zinc-300">
      Finish signing in in your browser. Canopy connects the account when you return.
    </p>
    {#if manual}<GrowIn><PasteCode {onconnected} /></GrowIn>
    {:else}<div><Button size="sm" variant="ghost" onclick={() => (manual = true)}>Paste a code</Button></div>{/if}
  </div>
{:else}
  <Disclosure summaryClass="text-base/6 sm:text-sm/6" class={className}
    >{#snippet summary()}Paste a sign-in code{/snippet}
    <PasteCode {onconnected} class="pt-4" /></Disclosure
  >
{/if}
