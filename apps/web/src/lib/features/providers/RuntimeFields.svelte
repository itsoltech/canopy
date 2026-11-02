<script lang="ts">
  import { Provider } from "@open-agents/contracts";
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
  }: {
    harness: Provider;
    binaryPath: string;
    homePath: string;
    shadowHomePath: string;
    launchArgs: string;
    /** The definition's values (placeholders on a worker). */
    inherited?: { binaryPath: string; homePath: string; shadowHomePath: string; launchArgs: string } | undefined;
    prefix: string;
  } = $props();

  const codex = $derived(harness === Provider.CODEX);
  const hint = (value: string | undefined, fallback: string) => (inherited ? value || `Definition: ${fallback}` : fallback);
</script>

<div class="grid gap-4 sm:grid-cols-2">
  <Field label="Binary path" description="Empty: {codex ? 'codex' : 'claude'} from the worker's settings or PATH.">
    <Input name="{prefix}-binary" bind:value={binaryPath} placeholder={hint(inherited?.binaryPath, codex ? "codex" : "claude")} autocomplete="off" spellcheck="false" class="font-mono" />
  </Field>
  <Field label={codex ? "CODEX_HOME path" : "Claude config dir"} description="The device's CLI home the login is linked from.">
    <Input name="{prefix}-home" bind:value={homePath} placeholder={hint(inherited?.homePath, codex ? "~/.codex" : "~/.claude")} autocomplete="off" spellcheck="false" class="font-mono" />
  </Field>
  <Field label="Shadow home path" description="Isolated home the harness runs in: sessions and state, the login linked or its own.">
    <Input name="{prefix}-shadow" bind:value={shadowHomePath} placeholder={hint(inherited?.shadowHomePath, codex ? "<data dir>/codex-home" : "<data dir>/claude-home")} autocomplete="off" spellcheck="false" class="font-mono" />
  </Field>
  <Field label="Launch arguments" description={codex ? "After app-server, e.g. -c model_verbosity=\"low\"." : "Claude Code flags, e.g. --debug."}>
    <Input name="{prefix}-args" bind:value={launchArgs} placeholder={hint(inherited?.launchArgs, "none")} autocomplete="off" spellcheck="false" class="font-mono" />
  </Field>
</div>
