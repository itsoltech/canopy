<script lang="ts">
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
  import FontPicker from "./FontPicker.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import Diff from "#lib/features/threads/components/Diff.svelte";
  import Terminal from "#lib/shared/ui/Terminal.svelte";

  const sample =
    'The agent can explain **changes** and inline math $E = mc^2$.\n\n```ts\nconst message = "A long code line follows your code wrapping preference without changing the saved source.";\n```';

  const diff =
    '--- a/settings.ts\n+++ b/settings.ts\n@@ -1,2 +1,2 @@\n-const theme = "light";\n+const theme = "system";\n export { theme };';
</script>

<SettingsGroup title="Typography" description="This device · Unavailable fonts use local fallbacks.">
  <FontPicker kind="interface" />
  <DeviceChoiceRow
    preference="interfaceSize"
    title="Interface size"
    description="Scale interface text from the desktop base size."
    options={[12, 14, 16, 18].map((v) => ({ value: String(v), label: `${v} px` }))}
  />
  <FontPicker kind="mono" />
  <DeviceChoiceRow
    preference="monoSize"
    title="Monospace size"
    description="Set the text size for code, diffs and terminal output."
    options={[12, 13, 14, 16].map((v) => ({ value: String(v), label: `${v} px` }))}
  />
  <DeviceChoiceRow
    preference="wrapCode"
    title="Wrap code blocks"
    description="Fit long lines in message code blocks to the available width."
    options={[
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ]}
  />
  <DeviceChoiceRow
    preference="wrapDiffs"
    title="Wrap diffs"
    description="Fit long lines in diffs to the available width."
    options={[
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ]}
  />
</SettingsGroup>
<SettingsGroup title="Previews">
  <div class="grid min-w-0 gap-4 p-4">
    <Markdown text={sample} />
    <Diff {diff} label="Typography diff preview" lang="typescript" />
    <div class="h-64 min-w-0 overflow-hidden rounded-lg">
      <Terminal
        title="Terminal preview"
        cwd="~/project"
        command="bun run build"
        output={"$ bun run build\nBuilt successfully in 1.2s\nReady."}
        running={false}
      />
    </div>
  </div>
</SettingsGroup>
