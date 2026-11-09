<script lang="ts">
  import type { Mention, ui } from "@canopy/contracts";
  import { mentionLabel } from "@canopy/domain";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { CHIP_ICON_CLASS, kindLook } from "#lib/features/mentions/kinds.ts";
  import MentionChip from "#lib/features/mentions/MentionChip.svelte";
  import { attachmentChipClass } from "./inline-chip.ts";
  import AttachmentPreview from "./AttachmentPreview.svelte";
  import { attachmentPreviewKind } from "@canopy/domain/attachment-preview";
  import { attachmentUrl } from "./preview.ts";

  /**
   * A file the user placed in their message, where they placed it (docs/ui-api.md, "Załączniki w tekście"): the
   * composer's badge. Images and text open a preview; other files download. Hover shows content or metadata.
   * Without the file's record (an item of the transcript) it is a plain chip.
   */
  let { mention, file }: { mention: Mention; file: ui.Attachment | undefined } = $props();

  let open = $state(false);
  let anchor = $state<HTMLElement>();

  const name = $derived(file?.name ?? mentionLabel(mention));
</script>

{#snippet body()}
  <Icon name={kindLook(mention).icon} class={CHIP_ICON_CLASS} /><span class="truncate">{name}</span>
{/snippet}

{#if file && attachmentPreviewKind(file) !== "file"}
  <button
    bind:this={anchor}
    type="button"
    class={[attachmentChipClass(), "cursor-pointer focus-ring hover:bg-brand-600/14 dark:hover:bg-brand-400/18"]}
    aria-label="Open {name}"
    onclick={() => (open = true)}>{@render body()}</button
  >
{:else if file}
  <a
    bind:this={anchor}
    href={attachmentUrl(file, "download")}
    download={name}
    class={[attachmentChipClass(), "focus-ring hover:bg-brand-600/14 dark:hover:bg-brand-400/18"]}
    aria-label="Download {name}">{@render body()}</a
  >
{:else}
  <MentionChip {mention} />
{/if}
{#if file}<AttachmentPreview {file} {anchor} bind:open />{/if}
