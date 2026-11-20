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

  let retry = $state(0);
  const connection = attachmentConnection(() => entityId);
  const preview = $derived({ src, availability: connection(), retry, controller: new AbortController() });
  let failure = $state.raw<{ attempt: typeof preview; message: string }>();
  let loaded = $state.raw<typeof preview>();

  $effect(() => {
    const { controller } = preview;

    return () => controller.abort();
  });

  async function imageError(attempt: typeof preview) {
    const { signal } = attempt.controller;
    let message = "Could not show the image. Download it to open it.";

    try {
      // Only a failed image needs a second request for the gateway's explanation.
      const response = await previewResponse(attempt.src, signal);
      await response.body?.cancel();
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
      {#snippet loadedImage()}<img
          src={attempt.src}
          {alt}
          onload={(event) => {
            if (attempt !== preview) return;
            loaded = attempt;
            onload?.(event);
          }}
          onerror={() => void imageError(attempt)}
          class={imageClass}
        />{/snippet}
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
