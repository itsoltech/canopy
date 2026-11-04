<script lang="ts">
  import ShareSetting from "#lib/features/computers/ShareSetting.svelte";
  import SharingGroup from "#lib/features/computers/SharingGroup.svelte";
  import { sharedKey } from "@canopy/domain/computers";
  import TextGenerationFields from "#lib/features/settings/TextGenerationFields.svelte";
</script>

<svelte:head><title>Text generation · Settings · Canopy</title></svelte:head>

<div class="grid gap-6">
  <TextGenerationFields />

<SharingGroup>
  <ShareSetting itemKey={sharedKey.settings("text_generation")} label="Text generation" local="The chosen instance must exist on each computer that uses it." />
</SharingGroup>
</div>
