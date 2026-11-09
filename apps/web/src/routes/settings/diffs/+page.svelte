<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { devicePreferences as device, diffDeviceKeys } from "#lib/features/settings/device-preferences.svelte.ts";
  import DeviceChoiceRow from "#lib/features/settings/DeviceChoiceRow.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Diff from "#lib/features/threads/components/Diff.svelte";

  const diff =
    "--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-const count = 1;\n+const count = 2;\n console.log(count);\n@@ -5 +5 @@\n-  render();\n+    render();";
</script>

<svelte:head><title>Diffs · Settings · {applicationName}</title></svelte:head>
<div class="settings-stack">
  <div class="flex justify-end">
    <Button size="sm" icon="arrow-path" onclick={() => device.reset(diffDeviceKeys)}>Restore device defaults</Button>
  </div>
  <SettingsGroup title="Diff viewer" description="This device · Applies to file changes and diff code blocks.">
    <DeviceChoiceRow
      preference="diffLayout"
      title="Diff layout"
      description="Show original and updated lines stacked or side by side."
      options={[
        { value: "stacked", label: "Stacked" },
        { value: "split", label: "Side by side" },
      ]}
    />
    <DeviceChoiceRow
      preference="hideWhitespace"
      title="Hide whitespace changes"
      description="Hide replacements that differ only in spacing."
      options={[
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ]}
    />
    <DeviceChoiceRow
      preference="diffFileState"
      title="Default file state"
      description="Set whether file changes start expanded or collapsed."
      options={[
        { value: "expanded", label: "Expanded" },
        { value: "collapsed", label: "Collapsed" },
      ]}
    />
    <DeviceChoiceRow
      preference="diffColors"
      title="Diff colors"
      description="Set the colors for additions and deletions."
      options={[
        { value: "red-green", label: "Red & green" },
        { value: "blue-orange", label: "Blue & orange" },
      ]}
    />
  </SettingsGroup>
  <SettingsGroup title="Preview"
    ><div class="min-w-0 p-4"><Diff {diff} label="Diff settings preview" lang="typescript" /></div></SettingsGroup
  >
</div>
