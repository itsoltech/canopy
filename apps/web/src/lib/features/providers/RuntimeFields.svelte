<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider } from "@canopy/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  /**
   * How the worker runs the instance's harness: its executable, the CLI home its login is linked from,
   * the isolated ("shadow") home it runs with, and launch arguments. Empty = the worker's settings. With `inherited`
   * (one worker's overrides) an empty field follows the definition, shown as the placeholder.
   */
  let {
    harness,
    binaryPath = $bindable(""),
    homePath = $bindable(""),
    shadowHomePath = $bindable(""),
    launchArgs = $bindable(""),
    inherited,
    prefix,
    class: className,
  }: {
    harness: Provider;
    binaryPath: string;
    homePath: string;
    shadowHomePath: string;
    launchArgs: string;
    /** The definition's values (placeholders on a worker). */
    inherited?: { binaryPath: string; homePath: string; shadowHomePath: string; launchArgs: string } | undefined;
    prefix: string;
    class?: ClassValue;
  } = $props();

  const codex = $derived(harness === Provider.CODEX);
  const antigravity = $derived(harness === Provider.ANTIGRAVITY);
  const binary = $derived(antigravity ? "agy" : harness === Provider.GROK ? "grok" : codex ? "codex" : "claude");

  const hint = (value: string | undefined, fallback: string) =>
    inherited ? value || `Definition: ${fallback}` : fallback;
</script>

<div class={["settings-form", className]}>
  <Field layout="row" label="CLI path" description="Empty: {binary} from the worker's settings or PATH.">
    <Input
      name="{prefix}-binary"
      bind:value={binaryPath}
      placeholder={hint(inherited?.binaryPath, binary)}
      autocomplete="off"
      spellcheck="false"
      class="font-mono"
    />
  </Field>
  {#if !antigravity}
    <Field
      layout="row"
      label={harness === Provider.GROK ? "GROK_HOME path" : codex ? "CODEX_HOME path" : "Login source"}
      description={harness === Provider.CLAUDE
        ? "Uses the Claude account signed in here, independently of user configuration."
        : codex
          ? "The worker detects the CLI home when no path is set."
          : "The device's CLI home the login is linked from."}
    >
      <Input
        name="{prefix}-home"
        bind:value={homePath}
        placeholder={hint(inherited?.homePath, `~/.${binary}`)}
        autocomplete="off"
        spellcheck="false"
        class="font-mono"
      />
    </Field>
  {/if}
  <Field
    layout="row"
    label={antigravity
      ? "Managed skills home"
      : harness === Provider.GROK
        ? "Shadow home path"
        : "Private state directory"}
    description={antigravity
      ? "Canopy stores the skills assigned to this instance here."
      : harness === Provider.GROK
        ? "Login home for an instance with its own login. ACP sessions live in the worker's data directory."
        : harness === Provider.CLAUDE
          ? "Stores private thread history and state when user configuration is isolated or local."
          : "Stores Canopy’s private Codex state, including the thread index."}
  >
    <Input
      name="{prefix}-shadow"
      bind:value={shadowHomePath}
      placeholder={hint(inherited?.shadowHomePath, antigravity ? "Worker default" : `<data dir>/${binary}-home`)}
      autocomplete="off"
      spellcheck="false"
      class="font-mono"
    />
  </Field>
  {#if !antigravity}
    <Field
      layout="row"
      label="Launch arguments"
      description={harness === Provider.GROK
        ? "Agent flags before stdio, e.g. --reasoning-effort low."
        : codex
          ? 'After app-server, e.g. -c model_verbosity="low".'
          : "Claude Code flags, e.g. --debug."}
    >
      <Input
        name="{prefix}-args"
        bind:value={launchArgs}
        placeholder={hint(inherited?.launchArgs, "none")}
        autocomplete="off"
        spellcheck="false"
        class="font-mono"
      />
    </Field>
  {/if}
</div>
