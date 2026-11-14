<script lang="ts">
  import type { Visual } from "@canopy/contracts";
  import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import MenuGroup from "#lib/shared/ui/MenuGroup.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { loadVisual, visualUrl } from "./visual-source.ts";

  /**
   * A visual's actions, all in the host's chrome (never inside the sandbox): download the standalone HTML, copy
   * the spec, cite the version, pick an earlier version. Every action uses `version`, the one on screen.
   */
  let {
    threadId,
    itemId,
    visual,
    version,
    versions,
    selected = $bindable(0),
  }: {
    threadId: string;
    itemId: string;
    visual: Visual;
    /** The version shown: a picked older one, or the one kept while a newer version waits for Reload. */
    version: number;
    versions: readonly number[];
    selected?: number;
  } = $props();

  const drafts = useQuoteDrafts();

  async function copySpec() {
    try {
      const response = await loadVisual(threadId, visual.visualId, version);
      await navigator.clipboard.writeText(JSON.stringify(JSON.parse(response.specJson), null, 2));
      toast("Spec copied");
    } catch {
      toast("Couldn't copy the spec. Try again.", { tone: "error" });
    }
  }

  async function cite() {
    let shown = visual;

    try {
      shown = (await loadVisual(threadId, visual.visualId, version)).visual ?? visual;
    } catch {
      toast("Couldn't cite this visual. Try again.", { tone: "error" });

      return;
    }

    const added = drafts.add(threadId, {
      text: `Visual "${shown.title}" · Version ${version} (visual:${visual.visualId}@${version})\n${shown.description}`,
      source: { itemId, threadId, kind: "text_selection", language: "" },
    });

    if (!added) toast("A message can carry up to 20 quotes", { tone: "error" });
  }
</script>

<DropdownMenu label="Visual actions" placement="bottom-end" sheet>
  {#snippet trigger(props)}<IconButton
      icon="ellipsis-horizontal"
      label="Visual actions"
      size="sm"
      {...props}
    />{/snippet}
  <MenuItem icon="arrow-down-tray" href="{visualUrl(threadId, visual.visualId, version)}&download"
    >Download HTML</MenuItem
  >
  <MenuItem icon="document-duplicate" onselect={copySpec}>Copy spec</MenuItem>
  <MenuItem icon="chat-bubble-left-right" onselect={cite}>Cite visual</MenuItem>
  {#if versions.length > 1}
    <MenuSeparator />
    <MenuGroup label="Versions">
      {#each [...versions].reverse() as entry (entry)}
        <MenuCheckItem
          type="radio"
          checked={entry === version}
          onselect={() => (selected = entry === versions.at(-1) ? 0 : entry)}
          >Version {entry}{entry === versions.at(-1) ? " (latest)" : ""}</MenuCheckItem
        >
      {/each}
    </MenuGroup>
  {/if}
</DropdownMenu>
