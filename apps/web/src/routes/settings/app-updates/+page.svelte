<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import AppUpdates from "#lib/features/desktop/AppUpdates.svelte";
  import LinkedAppUpdates from "#lib/features/desktop/LinkedAppUpdates.svelte";
  import WhatsNewSettings from "#lib/features/updates/WhatsNewSettings.svelte";
</script>

<svelte:head><title>App updates · Settings · {applicationName}</title></svelte:head>
<AppUpdates />
<WhatsNewSettings />
<LinkedAppUpdates />
