<script lang="ts">
  import FileViewer from "./FileViewer.svelte";
  import { openedFile } from "./file-links.svelte.ts";

  /** The viewer of the file last clicked in a thread's messages (root layout, one at a time). */
</script>

{#if openedFile.current}
  {#key openedFile.current}<FileViewer
      target={openedFile.current}
      onclose={() => (openedFile.current = undefined)}
    />{/key}
{/if}
