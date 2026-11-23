<script lang="ts">
  import { MentionKind, type Mention } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { parseIssueUrl } from "@canopy/domain";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ConnectorIcon from "#lib/features/connectors/ConnectorIcon.svelte";
  import { CHIP_CLASS, CHIP_ICON_CLASS, chipLabel, chipTitle, kindLook } from "./kinds.ts";

  /** A mention in a sent message: the composer's chip (kinds.ts), its whole name on hover. */
  let { mention, class: className }: { mention: Mention; class?: ClassValue } = $props();
  const href = $derived(mention.kind === MentionKind.ISSUE ? parseIssueUrl(mention.path)?.href : undefined);
</script>

<svelte:element
  this={href ? "a" : "span"}
  {href}
  target={href ? "_blank" : undefined}
  rel={href ? "noopener noreferrer" : undefined}
  title={chipTitle(mention)}
  class={[CHIP_CLASS, href && "focus-ring hover:underline", className]}
>
  {#if mention.kind === MentionKind.ISSUE && mention.issue && !mention.issue.pullRequest}
    <ConnectorIcon type={mention.issue.provider} class={CHIP_ICON_CLASS} />
  {:else}
    <Icon name={kindLook(mention).icon} class={CHIP_ICON_CLASS} />
  {/if}
  <span class="truncate">{chipLabel(mention)}</span>
</svelte:element>
