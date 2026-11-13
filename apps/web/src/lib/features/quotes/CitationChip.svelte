<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { citationTokenLabel } from "@canopy/domain";
  import HoverCard from "#lib/shared/ui/HoverCard.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { CHIP_CLASS } from "#lib/features/mentions/kinds.ts";
  import { useCitationSource } from "./citation-source.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import CitationPreview from "./CitationPreview.svelte";

  let { quote, class: className }: { quote: ui.Quote; class?: ClassValue } = $props();
  const revealSource = useCitationSource();

  async function reveal() {
    if (!(await revealSource(quote)))
      toast("Could not find the source. Try loading earlier messages.", { tone: "error" });
  }
</script>

<HoverCard label="Citation" touch="press" class="w-max max-w-[min(20rem,calc(100vw-1rem))]">
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      aria-label="Citation: {citationTokenLabel(quote)}"
      onclick={reveal}
      class={[CHIP_CLASS, "max-w-64 text-left focus-ring", className]}
    >
      <Icon
        name={quote.pullRequest ? "git-fork" : "chat-bubble-bottom-center-text"}
        class="size-4 shrink-0 self-center"
      />
      <span class="truncate">{citationTokenLabel(quote)}</span>
    </button>
  {/snippet}
  <CitationPreview {quote} />
</HoverCard>
