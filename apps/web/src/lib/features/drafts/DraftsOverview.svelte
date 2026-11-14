<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import DraftsDialog from "./DraftsDialog.svelte";
  import { remoteDrafts } from "./remote.svelte.ts";
  import { webDrafts } from "./local.svelte.ts";

  let open = $state(false);

  $effect(() => {
    if (webDrafts.ready) void remoteDrafts.load().catch(() => {});
  });

  onMount(() => remoteDrafts.subscribe());
</script>

<Button size="sm" variant="ghost" onclick={() => (open = true)}>Open drafts</Button>
<DraftsDialog bind:open />
