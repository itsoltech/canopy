<script lang="ts">
  import IconButton from "#lib/shared/ui/IconButton.svelte";

  /**
   * The composer's paperclip: opens the system picker for any number of files. On phones the system offers the
   * camera, the photo library and files from the same picker.
   */
  let { onfiles, disabled = false }: { onfiles: (files: File[]) => void; disabled?: boolean } = $props();
  let input = $state<HTMLInputElement>();
</script>

<IconButton icon="paper-clip" label="Attach files" size="sm" {disabled} onclick={() => input?.click()} />
<input
  bind:this={input}
  type="file"
  name="files"
  multiple
  class="sr-only"
  tabindex="-1"
  aria-hidden="true"
  onchange={(event) => {
    const target = event.currentTarget;
    onfiles([...(target.files ?? [])]);
    target.value = "";
  }}
/>
