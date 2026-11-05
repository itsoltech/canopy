<script lang="ts">
  import type { Mention, ui } from "@canopy/contracts";
  import { formatSize, mentionLabel } from "@canopy/domain";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { CHIP_ICON_CLASS, kindLook } from "#lib/features/mentions/kinds.ts";
  import MentionChip from "#lib/features/mentions/MentionChip.svelte";
  import { attachmentChipClass } from "./inline-chip.ts";
  import Lightbox from "./Lightbox.svelte";

  /**
   * A file the user placed in their message, where they placed it (docs/ui-api.md, "Załączniki w tekście"): the
   * composer's badge. An image opens in the Lightbox, another file downloads; the name and size are in the tooltip.
   * Without the file's record (an item of the transcript) it is a plain chip.
   */
  let { mention, file }: { mention: Mention; file: ui.Attachment | undefined } = $props();

  let open = $state(false);

  const url = (a: ui.Attachment, variant?: "download") =>
    `/api/attachments/${encodeURIComponent(a.id)}${variant ? `?${variant}` : ""}`;

  const detail = $derived(
    file
      ? [file.width && file.height ? `${file.width}×${file.height}` : "", formatSize(file.sizeBytes)]
          .filter(Boolean)
          .join(" · ")
      : "",
  );

  const name = $derived(file?.name ?? mentionLabel(mention));
</script>

{#snippet body()}
  <Icon name={kindLook(mention).icon} class={CHIP_ICON_CLASS} /><span class="truncate">{name}</span>
{/snippet}

{#if file?.kind === "image"}
  <button
    type="button"
    class={[attachmentChipClass(), "cursor-pointer focus-ring hover:bg-brand-600/14 dark:hover:bg-brand-400/18"]}
    title="{name} · {detail}"
    aria-label="Open {name}"
    onclick={() => (open = true)}>{@render body()}</button
  >
  <Lightbox bind:open src={url(file)} {name} {detail} download={url(file, "download")} />
{:else if file}
  <a
    href={url(file, "download")}
    download={name}
    class={[attachmentChipClass(), "focus-ring hover:bg-brand-600/14 dark:hover:bg-brand-400/18"]}
    title="{name} · {detail}"
    aria-label="Download {name}">{@render body()}</a
  >
{:else}
  <MentionChip {mention} />
{/if}
