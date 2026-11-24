<script lang="ts">
  import { useSettings } from "./settings-state.svelte.ts";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
  import FontPicker from "./FontPicker.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import Diff from "#lib/features/threads/components/Diff.svelte";
  import Terminal from "#lib/shared/ui/Terminal.svelte";
  import { installedFontAccess, installedFonts, type FontDiscovery } from "./local-fonts.ts";

  const settings = useSettings();
  let discovery = $state<FontDiscovery>({ state: "idle" });

  async function discoverFonts(requestAccess = false) {
    if (discovery.state === "loading" || discovery.state === "ready") return;
    discovery = { state: "loading" };

    if (!requestAccess) {
      const access = await installedFontAccess();

      if (access !== "granted") {
        discovery = { state: access };

        return;
      }
    }

    try {
      const families = await installedFonts();

      if (families.length) {
        discovery = { state: "ready", families };

        return;
      }
    } catch {
      // The browser can reject enumeration when permission is dismissed or denied.
    }

    const canRequestAgain = requestAccess && (await installedFontAccess()) === "prompt";
    discovery = { state: canRequestAgain ? "prompt" : "failed" };
  }

  const sample =
    'The agent can explain **changes** and inline math $E = mc^2$.\n\n```ts\nconst message = "A long code line follows your code wrapping preference without changing the saved source.";\n```';

  const diff =
    '--- a/settings.ts\n+++ b/settings.ts\n@@ -1,2 +1,2 @@\n-const theme = "light";\n+const theme = "system";\n export { theme };';
</script>

<SettingsGroup title="Typography" description="This device · Unavailable fonts use local fallbacks.">
  <FontPicker kind="interface" {discovery} {discoverFonts} />
  <DeviceChoiceRow
    preference="interfaceSize"
    title="Interface size"
    description="Scale interface text from the desktop base size."
    options={[12, 14, 16, 18].map((v) => ({ value: String(v), label: `${v} px` }))}
  />
  <FontPicker kind="mono" {discovery} {discoverFonts} />
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
  {#if settings.moduleEnabled("threads")}
    <DeviceChoiceRow
      preference="wrapDiffs"
      title="Wrap diffs"
      description="Fit long lines in diffs to the available width."
      options={[
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ]}
    />
  {/if}
</SettingsGroup>
<SettingsGroup title="Previews">
  <div class="grid min-w-0 gap-4 p-4">
    <Markdown text={sample} />
    {#if settings.moduleEnabled("threads")}
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
    {/if}
  </div>
</SettingsGroup>
