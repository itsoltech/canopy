<script lang="ts">
  import type { PublishedVideo } from "@canopy/contracts";
  import FileAvailability from "./FileAvailability.svelte";
  import VideoPlayer from "./VideoPlayer.svelte";
  import { attachmentUrl } from "./preview.ts";

  let { video }: { video: PublishedVideo } = $props();
</script>

<div class="grid w-full max-w-2xl min-w-0 gap-2" data-quote-skip>
  {#if video.caption}
    <p class="text-base/7 wrap-anywhere text-zinc-800 sm:text-sm/6 dark:text-zinc-200">{video.caption}</p>
  {/if}
  {#if video.attachment?.id}
    {@const file = video.attachment}
    <FileAvailability entityId={file.id} name={file.name} class="grid min-w-0 gap-1">
      {#key file.id}
        <VideoPlayer src={attachmentUrl(file)} label={file.name} placement="chat" />
      {/key}
      <a
        class="justify-self-start rounded-sm text-sm text-muted underline-offset-4 focus-ring hover:underline sm:text-xs"
        href={attachmentUrl(file, "download")}
        aria-label="Download video {file.name}"
        download={file.name}>Download video</a
      >
    </FileAvailability>
  {:else}
    <p class="text-sm text-muted sm:text-xs">Video unavailable</p>
  {/if}
</div>
