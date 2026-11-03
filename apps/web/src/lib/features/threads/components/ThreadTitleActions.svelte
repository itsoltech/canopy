<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
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

<section aria-label="Thread title" class={["flex min-w-0 items-center gap-2 p-3 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white", className]}>
  <SwapText text={thread.title || "New thread"} class={["min-w-0 flex-1 overflow-hidden", generating && "shimmer"]} />
  <!-- Rename and regenerate are occasional: behind "more", so the panel opens on the title alone. -->
  <DropdownMenu label="Title actions" placement="bottom-end">
    {#snippet trigger(props)}<IconButton {...props} icon="ellipsis-horizontal" size="sm" label="Title actions" disabled={closed} />{/snippet}
    <MenuItem icon="pencil-square" onselect={() => void actions.run("rename", thread)}>Rename…</MenuItem>
    <MenuItem icon="arrow-path" disabled={generating} onselect={regenerate}>{generating ? "Generating title…" : "Regenerate title"}</MenuItem>
  </DropdownMenu>
</section>
