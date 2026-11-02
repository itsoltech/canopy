<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import SwapText from "#lib/shared/ui/SwapText.svelte";
  import { useThreadActions } from "../thread-actions.svelte.ts";
  import { requestTitleRegeneration } from "../title-actions.ts";

  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  const actions = useThreadActions();
  const closed = $derived(thread.status === "archived");
  // From the click until the gateway reports the generation (and then until it ends): the button spins and
  // the title shimmers, so a request never looks ignored.
  let requested = $state(false);
  const generating = $derived(thread.titleGenerating || requested);
  $effect(() => {
    if (thread.titleGenerating) requested = false;
  });

  async function regenerate() {
    requested = true;
    try {
      await requestTitleRegeneration(thread.id);
    } finally {
      // The thread update with titleGenerating normally arrives first; without it (a failure) stop here.
      setTimeout(() => (requested = false), 1500);
    }
  }

</script>

<section aria-label="Thread title" class={["grid min-w-0 gap-2 p-3", className]}>
    <div class="flex min-w-0 items-center gap-2 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
      <SwapText text={thread.title || "New thread"} class={["min-w-0 flex-1 overflow-hidden", generating && "shimmer"]} />
      <IconButton icon="pencil-square" size="sm" label="Rename thread" disabled={closed} onclick={() => void actions.run("rename", thread)} />
    </div>
    <div><Button size="sm" icon="arrow-path" loading={generating} disabled={closed || generating} onclick={regenerate}>{generating ? "Generating title…" : "Regenerate title"}</Button></div>
</section>
