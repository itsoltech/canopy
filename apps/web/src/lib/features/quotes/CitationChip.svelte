<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { citationLabel } from "@canopy/domain";
  import HoverCard from "#lib/shared/ui/HoverCard.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { CHIP_CLASS } from "#lib/features/mentions/kinds.ts";
  import { useCitationSource } from "./citation-source.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { citationTitle } from "./inline.ts";

  let { quote, class: className }: { quote: ui.Quote; class?: ClassValue } = $props();
  const revealSource = useCitationSource();

  async function reveal() {
    if (!(await revealSource(quote)))
      toast("Could not find the source. Try loading earlier messages.", { tone: "error" });
  }
</script>

<HoverCard label="Citation" touch="press" class="max-w-[calc(100vw-1rem)]">
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      aria-label="Citation: {citationLabel(quote.text)}"
      onclick={reveal}
      class={[CHIP_CLASS, "max-w-64 text-left focus-ring", className]}
    >
      <Icon name="chat-bubble-bottom-center-text" class="size-4 shrink-0 self-center" />
      <span class="truncate">{citationLabel(quote.text)}</span>
    </button>
  {/snippet}
  <p class="max-h-72 overflow-y-auto break-words whitespace-pre-wrap select-text">{citationTitle(quote)}</p>
  {#if quote.comment}<p class="pt-2 whitespace-pre-wrap select-text">{quote.comment}</p>{/if}
</HoverCard>
