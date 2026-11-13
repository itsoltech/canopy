<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { formatSize } from "@canopy/domain";

  let { file, name }: { file: ui.ThreadFile; name: string } = $props();
  let url = $state("");
  let dimensions = $state("");
  let failed = $state(false);

  const safe = $derived(
    file.imageWidth > 0 &&
      file.imageHeight > 0 &&
      file.imageWidth * file.imageHeight <= 16_000_000 &&
      !file.imagePreviewError,
  );

  $effect(() => {
    if (!safe) return;
    const bytes = new Uint8Array(file.imagePreview.length ? file.imagePreview : file.content);

    const source = URL.createObjectURL(
      new Blob([bytes], { type: file.imagePreview.length ? "image/png" : file.mimeType }),
    );

    url = source;
    dimensions = "";
    failed = false;

    return () => URL.revokeObjectURL(source);
  });
</script>

<figure class="grid min-w-0 gap-2 p-3">
  {#if !safe}
    <p class="text-sm text-muted">
      {file.imagePreviewError || "Update Canopy on the thread’s computer to preview this image safely."}
    </p>
  {:else if failed}
    <p role="alert" class="text-base text-muted sm:text-sm">Could not show this image. Reload to try again.</p>
  {:else if url}
    <img
      src={url}
      alt={name}
      class="mx-auto max-h-[55dvh] max-w-full object-contain"
      onload={(event) => {
        if (!(event.currentTarget instanceof HTMLImageElement)) return;

        dimensions = `${event.currentTarget.naturalWidth.toLocaleString()} × ${event.currentTarget.naturalHeight.toLocaleString()}`;
      }}
      onerror={() => (failed = true)}
    />
  {/if}
  <figcaption class="text-center text-sm text-muted tabular-nums sm:text-xs">
    {dimensions ? `${dimensions} · ` : ""}{formatSize(Number(file.size))}
  </figcaption>
</figure>
