<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import AccountConfigNotices from "#lib/features/computers/AccountConfigNotices.svelte";
  import TextGenerationFields from "#lib/features/settings/TextGenerationFields.svelte";
</script>

<svelte:head><title>Text generation · Settings · {applicationName}</title></svelte:head>

<div class="settings-stack">
  <TextGenerationFields />

  <AccountConfigNotices section="textGeneration" />
</div>
