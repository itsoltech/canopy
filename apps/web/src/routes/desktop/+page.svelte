<script lang="ts">
  import DesktopSetup from "#lib/features/desktop/DesktopSetup.svelte";
  import { page } from "$app/state";
</script>

<DesktopSetup settings={page.url.searchParams.get("settings") === "1"} />
