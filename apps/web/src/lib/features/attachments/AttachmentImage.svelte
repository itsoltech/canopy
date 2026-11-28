<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { isHeicAttachment } from "@canopy/domain/attachment-preview";
  import Button from "#lib/shared/ui/Button.svelte";
  import { attachmentConnection, previewResponse } from "./preview.ts";
  import { decodeHeic } from "./heic.ts";

  let {
    src,
    alt = "",
    entityId = "",
    localHeic,
    imageClass,
    class: className,
    onload,
    onopen,
  }: {
    src: string;
    alt?: string;
    entityId?: string;
    localHeic?: Blob | undefined;
    imageClass?: ClassValue;
    class?: ClassValue;
    onload?: ((width: number, height: number) => void) | undefined;
    onopen?: (() => void) | undefined;
  } = $props();

  let retry = $state(0);
  const connection = attachmentConnection(() => entityId);

  // Linked computer metadata can change while the attachment's availability stays the same.
  const availability = $derived(connection());
  const preview = $derived({ src, localHeic, availability, retry, controller: new AbortController() });
  let failure = $state.raw<{ attempt: typeof preview; message: string }>();
  let loaded = $state.raw<typeof preview>();
  let nativeFailed = $state.raw<typeof preview>();

  $effect(() => {
    const { controller } = preview;

    return () => controller.abort();
  });

  async function loadFallback(canvas: HTMLCanvasElement, attempt: typeof preview) {
    const { signal } = attempt.controller;
    let message = "Could not show the image. Download it to open it.";

    try {
      let source = attempt.localHeic;

      if (!source) {
        // Recover the original bytes for HEIF, or the gateway's explanation for a failed request.
        const response = await previewResponse(attempt.src, signal);

        if (isHeicAttachment(response.headers.get("content-type") ?? "")) source = await response.blob();
        else await response.body?.cancel();
      }

      const pixels = source && (await decodeHeic(source, signal));

      if (pixels && !signal.aborted && attempt === preview) {
        const context = canvas.getContext("2d");

        if (context) {
          canvas.width = pixels.width;
          canvas.height = pixels.height;
          context.putImageData(pixels, 0, 0);
          loaded = attempt;
          onload?.(canvas.width, canvas.height);

          return;
        }
      }
    } catch (cause) {
      if (cause instanceof Error) message = cause.message;
    }

    if (!signal.aborted && attempt === preview) failure = { attempt, message };
  }
</script>

<span class={["grid min-w-0 items-center gap-2", className]}>
  {#if failure?.attempt === preview}
    <span class="grid min-w-0 justify-items-start gap-1 p-3">
      <span role="alert" class="max-w-prose break-words">{failure.message}</span>
      <Button variant="ghost" size="sm" onclick={() => retry++}>Retry</Button>
    </span>
  {:else}
    {#key preview}
      {@const attempt = preview}
      {#if loaded !== attempt}<span role="status" class="p-3">Loading image…</span>{/if}
      <!-- Hidden until loaded, the image never gets Chromium's visible-image boost. At low priority, Desktop's HTTP/1.1
           BFF lets Chromium hold it behind the open event streams, up to its 15 s queuing limit. -->
      {#snippet loadedImage()}
        {#if nativeFailed === attempt}
          <canvas
            {@attach (node) => {
              void loadFallback(node, attempt);
            }}
            role={alt ? "img" : "presentation"}
            aria-label={alt || undefined}
            class={imageClass}
          ></canvas>
        {:else}<img
            src={attempt.src}
            {alt}
            fetchpriority="high"
            onload={(event) => {
              if (attempt !== preview || !(event.currentTarget instanceof HTMLImageElement)) return;
              loaded = attempt;
              onload?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
            }}
            onerror={() => (nativeFailed = attempt)}
            class={imageClass}
          />{/if}
      {/snippet}
      <span hidden={loaded !== attempt} class:contents={loaded === attempt}>
        {#if onopen}
          <button
            type="button"
            onclick={onopen}
            aria-label="Open image: {alt}"
            class="group h-full w-full min-w-0 overflow-hidden rounded-lg focus-ring">{@render loadedImage()}</button
          >
        {:else}
          {@render loadedImage()}
        {/if}
      </span>
    {/key}
  {/if}
</span>
