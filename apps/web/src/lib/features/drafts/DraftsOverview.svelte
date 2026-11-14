<script lang="ts">
  import { onMount } from "svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import DraftsDialog from "./DraftsDialog.svelte";
  import { remoteDrafts } from "./remote.svelte.ts";
  import { webDrafts } from "./local.svelte.ts";

  let open = $state(false);

  $effect(() => {
    if (webDrafts.ready) void remoteDrafts.load().catch(() => {});
  });

  onMount(() => remoteDrafts.subscribe());
</script>

<IconButton icon="document-text" label="Open drafts" onclick={() => (open = true)} />
<DraftsDialog bind:open />
