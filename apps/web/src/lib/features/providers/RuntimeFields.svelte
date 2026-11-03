<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider } from "@canopy/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  /**
   * How the worker runs the instance's harness (T3 Runtime): its executable, the CLI home its login is linked from,
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
  const binary = $derived(harness === Provider.GROK ? "grok" : codex ? "codex" : "claude");
  const hint = (value: string | undefined, fallback: string) => (inherited ? value || `Definition: ${fallback}` : fallback);
</script>

<div class={["grid gap-4 sm:grid-cols-2", className]}>
  <Field label="Binary path" description="Empty: {binary} from the worker's settings or PATH.">
    <Input name="{prefix}-binary" bind:value={binaryPath} placeholder={hint(inherited?.binaryPath, binary)} autocomplete="off" spellcheck="false" class="font-mono" />
  </Field>
  <Field label={harness === Provider.GROK ? "GROK_HOME path" : codex ? "CODEX_HOME path" : "Claude config dir"} description="The device's CLI home the login is linked from.">
    <Input name="{prefix}-home" bind:value={homePath} placeholder={hint(inherited?.homePath, `~/.${binary}`)} autocomplete="off" spellcheck="false" class="font-mono" />
  </Field>
  <Field label="Shadow home path" description={harness === Provider.GROK ? "Login home for an instance with its own login. ACP sessions live in the worker's data directory." : "Isolated home the harness runs in: sessions and state, the login linked or its own."}>
    <Input name="{prefix}-shadow" bind:value={shadowHomePath} placeholder={hint(inherited?.shadowHomePath, `<data dir>/${binary}-home`)} autocomplete="off" spellcheck="false" class="font-mono" />
  </Field>
  <Field label="Launch arguments" description={harness === Provider.GROK ? "Agent flags before stdio, e.g. --reasoning-effort low." : codex ? "After app-server, e.g. -c model_verbosity=\"low\"." : "Claude Code flags, e.g. --debug."}>
    <Input name="{prefix}-args" bind:value={launchArgs} placeholder={hint(inherited?.launchArgs, "none")} autocomplete="off" spellcheck="false" class="font-mono" />
  </Field>
</div>
