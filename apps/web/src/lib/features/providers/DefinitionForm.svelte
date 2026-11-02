<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@open-agents/contracts";
  import { untrack } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import AccentPicker from "./AccentPicker.svelte";
  import ConnectionFields from "./ConnectionFields.svelte";
  import EnvVarEditor from "./EnvVarEditor.svelte";
  import { draftOf, draftProblems, hasProblems, providerCall, saveRequest } from "./instances.ts";
  import RuntimeFields from "./RuntimeFields.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  /**
   * The global definition of an instance (scope "All workers"): name and color, connection, runtime and variables.
   * Saving makes new configuration versions for the workers it runs on. Threads keep the instance's id; an instance
   * threads use keeps its kind of connection.
   */
  let { instance, onsaved, class: className }: { instance: ui.ProviderInstance; onsaved: (instance: ui.ProviderInstance | undefined) => void; class?: ClassValue } = $props();

  let draft = $state(untrack(() => draftOf(instance)));
  let tried = $state(false);
  let busy = $state(false);
  let failure = $state<string>();
  // Back to the stored definition whenever another revision arrives (after a save, or a change elsewhere).
  $effect.pre(() => {
    void instance.revision;
    draft = draftOf(instance);
    tried = false;
  });

  const problems = $derived(draftProblems(draft, { builtIn: instance.builtIn, creating: false, takenIds: new Set() }));
  const shown = $derived(tried ? problems : { env: {} });
  const locked = $derived(instance.builtIn || instance.threadCount > 0);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    tried = true;
    failure = undefined;
    if (hasProblems(problems)) return;
    busy = true;
    try {
      const saved = await providerCall("save", saveRequest(draft, { creating: false, expectedRevision: instance.revision }));
      onsaved(saved.instance);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<form class={["grid gap-8", className]} onsubmit={submit} novalidate>
  <SettingsSection title="Identity">
    <div class="grid gap-4 sm:grid-cols-2">
      <Field label="Display name" error={shown.label}>
        <Input name="label" bind:value={draft.label} placeholder={instance.builtIn ? "Device login" : "Team proxy"} autocomplete="off" />
      </Field>
      <Field label="Instance ID" description="Fixed: threads store it.">
        <Input name="id" value={instance.id} readonly class="font-mono text-zinc-500" />
      </Field>
    </div>
    <AccentPicker name="accent" bind:value={draft.accentColor} />
  </SettingsSection>

  <SettingsSection title="Connection" description={locked ? (instance.builtIn ? "The built-in device login keeps its connection." : "Threads use this instance: it keeps its kind of connection.") : undefined}>
    <ConnectionFields
      harness={instance.harness}
      bind:kind={draft.kind}
      bind:baseUrl={draft.baseUrl}
      apiKeySet={draft.apiKeySet}
      bind:keyAction={draft.keyAction}
      bind:apiKey={draft.apiKey}
      bind:ownLogin={draft.ownLogin}
      kindLocked={locked}
      errors={shown}
      prefix="def"
    />
  </SettingsSection>

  <SettingsSection title="Runtime" description="For every worker; a worker can override paths for its system.">
    <RuntimeFields harness={instance.harness} bind:binaryPath={draft.binaryPath} bind:homePath={draft.homePath} bind:shadowHomePath={draft.shadowHomePath} bind:launchArgs={draft.launchArgs} prefix="def" />
  </SettingsSection>

  <SettingsSection title="Environment" description="Variables of the harness process. A secret is stored encrypted and never shown again.">
    <EnvVarEditor bind:rows={draft.env} kind={draft.kind} problems={shown.env} />
  </SettingsSection>

  {#if failure}<Alert tone="error">{failure}</Alert>{/if}
  <DialogActions>
    <Button variant="ghost" onclick={() => ((draft = draftOf(instance)), (tried = false))}>Discard changes</Button>
    <Button type="submit" variant="primary" loading={busy}>Save for all workers</Button>
  </DialogActions>
</form>
