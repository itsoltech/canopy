<script lang="ts">
  import type { AgentMessage } from "@canopy/contracts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import MessageImage from "./MessageImage.svelte";
  import GalleryLightbox from "#lib/features/attachments/GalleryLightbox.svelte";
  import { splitReplySuggestions } from "@canopy/domain/reply-suggestions";
  import { useThreadDirectory } from "../../thread-directory.ts";

  /** Agent prose stays the primary reading content, inside work folds and in the answer slot. */
  let { message, streaming, itemId }: { message: AgentMessage; streaming: boolean; itemId: string } = $props();
  const directory = useThreadDirectory();
  let open = $state(false);
  let selected = $state(0);
  const text = $derived(directory.isReplySource?.(itemId) ? splitReplySuggestions(message.text).text : message.text);
</script>

<div data-quote-kind="agent_message" class="min-w-0" aria-busy={streaming}>
  <!-- While it streams, it shows line by line and each new block resolves in; the caret breathes. -->
  <Markdown {text} {streaming} caret>
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
</div>
