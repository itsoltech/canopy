<script lang="ts">
  import { ProviderProfileKind, type ui } from "@open-agents/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import EnvVarEditor from "./EnvVarEditor.svelte";
  import { joinArgs, overrideDraftOf, overrideProblems, overrideRequest, providerCall } from "./instances.ts";
  import RuntimeFields from "./RuntimeFields.svelte";
  import SecretValue from "./SecretValue.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  /**
   * One worker's overrides of an instance (scope = that worker): paths and arguments for its system, its own
   * endpoint address or key (e.g. another network), and variables added or replaced by name. An empty field follows
   * the definition (shown as the placeholder). Saving makes a new configuration version for this worker only.
   */
  let { instance, worker, onsaved }: { instance: ui.ProviderInstance; worker: ui.Worker; onsaved: (instance: ui.ProviderInstance | undefined) => void } = $props();

  const on = $derived(instance.workers.find((w) => w.workerId === worker.id));
  /** Text fields of the form; "" = follow the definition. */
  const textOf = (draft: ReturnType<typeof overrideDraftOf>) => ({
    binaryPath: draft.binaryPath ?? "",
    homePath: draft.homePath ?? "",
    shadowHomePath: draft.shadowHomePath ?? "",
    launchArgs: draft.launchArgs ?? "",
    baseUrl: draft.baseUrl ?? "",
  });
  let draft = $state(overrideDraftOf(undefined));
  let text = $state(textOf(overrideDraftOf(undefined)));
  let tried = $state(false);
  let busy = $state(false);
  let failure = $state<string>();
  $effect.pre(() => {
    draft = overrideDraftOf(on);
    text = textOf(draft);
    tried = false;
  });

  const merged = $derived({
    ...draft,
    binaryPath: text.binaryPath.trim() || undefined,
    homePath: text.homePath.trim() || undefined,
    shadowHomePath: text.shadowHomePath.trim() || undefined,
    launchArgs: text.launchArgs.trim() || undefined,
    baseUrl: text.baseUrl.trim() || undefined,
  });
  const problems = $derived(overrideProblems(instance, merged));
  const shown = $derived(tried ? problems : { env: {} });
  const endpoint = $derived(instance.kind === ProviderProfileKind.CLIPROXYAPI);
  const inherited = $derived({
    binaryPath: instance.runtime?.binaryPath ?? "",
    homePath: instance.runtime?.homePath ?? "",
    shadowHomePath: instance.runtime?.shadowHomePath ?? "",
    launchArgs: joinArgs(instance.runtime?.launchArgs ?? []),
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    tried = true;
    failure = undefined;
    if (problems.baseUrl || problems.apiKey || Object.keys(problems.env).length > 0) return;
    busy = true;
    try {
      onsaved((await providerCall("worker", overrideRequest(instance, worker.id, merged))).instance);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<form class="grid gap-8" onsubmit={submit} novalidate>
  {#if endpoint}
    <SettingsSection title="Connection on {worker.name}" description="Empty: the definition's address and key.">
      <div class="grid gap-4">
        <Field label="Endpoint URL" error={shown.baseUrl}>
          <Input name="ovr-url" bind:value={text.baseUrl} placeholder={instance.baseUrl} autocomplete="off" spellcheck="false" inputmode="url" class="font-mono" />
        </Field>
        <Field label="API key" description={draft.apiKeySet ? "This worker has its own key." : "Empty: the definition's key."} error={shown.apiKey}>
          <SecretValue set={draft.apiKeySet} bind:action={draft.keyAction} bind:value={draft.apiKey} name="ovr-key" placeholder="Key for this worker" allowClear />
        </Field>
      </div>
    </SettingsSection>
  {/if}

  <SettingsSection title="Runtime on {worker.name}" description="Empty fields follow the definition (shown greyed out).">
    <RuntimeFields
      harness={instance.harness}
      bind:binaryPath={text.binaryPath}
      bind:homePath={text.homePath}
      bind:shadowHomePath={text.shadowHomePath}
      bind:launchArgs={text.launchArgs}
      {inherited}
      prefix="ovr"
    />
  </SettingsSection>

  <SettingsSection title="Environment on {worker.name}" description="Added to the definition's variables; the same name replaces one.">
    {#if instance.env.length > 0}
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
        Definition: <span class="font-mono">{instance.env.map((v) => (v.secret ? `${v.name}=••••` : `${v.name}=${v.value}`)).join("  ")}</span>
      </p>
    {/if}
    <EnvVarEditor bind:rows={draft.env} kind={instance.kind} problems={shown.env} />
  </SettingsSection>

  {#if failure}<Alert tone="error">{failure}</Alert>{/if}
  <DialogActions>
    <Button variant="ghost" onclick={() => ((draft = overrideDraftOf(on)), (text = textOf(draft)), (tried = false))}>Discard changes</Button>
    <Button type="submit" variant="primary" loading={busy}>Save for {worker.name}</Button>
  </DialogActions>
</form>
