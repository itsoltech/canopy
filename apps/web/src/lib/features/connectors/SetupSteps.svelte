<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import ExternalLink from "#lib/shared/ui/ExternalLink.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StepList from "./StepList.svelte";

  /**
   * What to do for the chosen authentication method: numbered steps, then the page where the credential is
   * made and the connector's setup guide (both open in a new tab). `description` leads when no method picker
   * already shows it.
   */
  let {
    method,
    documentationUrl,
    name,
    description = false,
    class: className,
  }: {
    method: connectors.ConnectorAuthMethod;
    documentationUrl: string;
    name: string;
    description?: boolean;
    class?: ClassValue;
  } = $props();
</script>

{#snippet link(href: string, label: string)}
  <ExternalLink {href} class="inline-flex items-center gap-1"
    >{label}<Icon name="arrow-top-right-on-square" size="sm" tone="inherit" /></ExternalLink
  >
{/snippet}

<div class={["grid gap-3 rounded-lg bg-zinc-950/2.5 p-3 text-base/6 sm:text-sm/6 dark:bg-white/5", className]}>
  {#if description && method.description}<p class="text-pretty text-zinc-600 dark:text-zinc-300">
      {method.description}
    </p>{/if}
  {#if method.steps.length > 0}
    <StepList steps={method.steps} />
  {/if}
  {#if method.setupUrl || documentationUrl}
    <p class="flex flex-wrap gap-x-4 gap-y-1">
      {#if method.setupUrl}{@render link(method.setupUrl, method.setupLabel || "Open setup page")}{/if}
      {#if documentationUrl}{@render link(documentationUrl, `${name} setup guide`)}{/if}
    </p>
  {/if}
</div>
