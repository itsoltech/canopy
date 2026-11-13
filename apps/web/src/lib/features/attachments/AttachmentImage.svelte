<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { attachmentConnection, previewResponse } from "./preview.ts";

  let {
    src,
    alt = "",
    entityId = "",
    imageClass,
    class: className,
    onload,
    onopen,
  }: {
    src: string;
    alt?: string;
    entityId?: string;
    imageClass?: ClassValue;
    class?: ClassValue;
    onload?: (event: Event) => void;
    onopen?: (() => void) | undefined;
  } = $props();

  let url = $state("");
  let failure = $state("");
  let retry = $state(0);
  const connection = attachmentConnection(() => entityId);
  const availability = $derived(connection());

  $effect(() => {
    void retry;
    void availability;
    const controller = new AbortController();
    let objectUrl = "";
    url = "";
    failure = "";

    void previewResponse(src, controller.signal)
      .then((response) => response.blob())
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        url = objectUrl;
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) failure = cause instanceof Error ? cause.message : "Could not load the image.";
      });

    return () => {
      controller.abort();

      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
</script>

<span class={["grid min-w-0 items-center gap-2", className]}>
  {#if failure}
    <span class="grid min-w-0 justify-items-start gap-1 p-3">
      <span role="alert" class="max-w-prose break-words">{failure}</span>
      <Button variant="ghost" size="sm" onclick={() => retry++}>Retry</Button>
    </span>
  {:else if url}
    {#snippet loadedImage()}<img
        src={url}
        {alt}
        {onload}
        onerror={() => (failure = "Could not show the image. Download it to open it.")}
        class={imageClass}
      />{/snippet}
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
  {:else}
    <span role="status" class="p-3">Loading image…</span>
  {/if}
</span>
