<script lang="ts">
  import type { Mention } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { mentionLabel } from "@canopy/domain";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { CHIP_CLASS, CHIP_ICON_CLASS, chipTitle, kindLook } from "./kinds.ts";

  /** A mention in a sent message: the composer's chip (kinds.ts), its whole name on hover. */
  let { mention, class: className }: { mention: Mention; class?: ClassValue } = $props();
</script>

<span class={[CHIP_CLASS, className]} title={chipTitle(mention)}
  ><Icon name={kindLook(mention).icon} class={CHIP_ICON_CLASS} /><span class="truncate">{mentionLabel(mention)}</span
  ></span
>
