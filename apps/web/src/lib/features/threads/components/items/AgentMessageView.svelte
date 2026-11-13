<script lang="ts">
  import type { AgentMessage } from "@canopy/contracts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { runningAnimation } from "#lib/shared/activity.ts";
  import MessageImage from "./MessageImage.svelte";
  import GalleryLightbox from "#lib/features/attachments/GalleryLightbox.svelte";

  /** Agent prose stays the primary reading content, inside work folds and in the answer slot. */
  let { message, streaming }: { message: AgentMessage; streaming: boolean } = $props();
  let open = $state(false);
  let selected = $state(0);
</script>

<div data-quote-kind="agent_message" class="min-w-0" aria-busy={streaming}>
  <!-- While it streams, it shows line by line and each new block resolves in; the caret breathes. -->
  <Markdown text={message.text} {streaming}>
    {#snippet image(value)}<MessageImage
        {value}
        {message}
        {streaming}
        onopen={(image) => {
          selected = Math.max(0, message.images.indexOf(image));
          open = true;
        }}
      />{/snippet}
  </Markdown>
  {#if message.imageError}<p role="status" class="mt-2 text-sm/6 text-zinc-600 dark:text-zinc-400">
      {message.imageError}
    </p>{/if}
  {#if message.images.length}<GalleryLightbox images={message.images} bind:selected bind:open />{/if}
  {#if streaming}<span
      data-quote-skip
      class="t-pulse mt-1 inline-block h-4 w-1.5 rounded-xs bg-zinc-400 dark:bg-zinc-500"
      aria-hidden="true"
      {@attach runningAnimation}
    ></span>{/if}
</div>
