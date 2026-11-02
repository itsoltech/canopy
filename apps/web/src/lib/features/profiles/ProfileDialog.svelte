<script lang="ts">
  import { ProviderProfileKind, type ui } from "@open-agents/contracts";
  import { HttpError } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Fieldset from "#lib/shared/ui/Fieldset.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import EnvVarEditor from "./EnvVarEditor.svelte";
  import KindChoice from "./KindChoice.svelte";
  import { draftOf, draftProblems, hasProblems, profileName, saveProfile, saveRequest } from "./profiles.ts";
  import SecretValue from "./SecretValue.svelte";

  /**
   * Creates or edits a provider profile. Saving makes a new configuration version that goes to the worker; the
   * built-in device login profile keeps its connection and cannot be turned off, but takes variables and a name.
   */
  let {
    open = $bindable(false),
    workerId,
    profile,
    configVersion,
    onsaved,
  }: {
    open?: boolean;
    workerId: string;
    /** Undefined = new profile. */
    profile: ui.ProviderProfileSettings | undefined;
    configVersion: bigint;
    onsaved: (saved: ui.SaveProviderProfileResponse) => void;
  } = $props();

  let draft = $state(draftOf(undefined));
  let tried = $state(false);
  let busy = $state(false);
  let failure = $state<string>();
  // A fresh form every time the dialog opens.
  $effect.pre(() => {
    if (!open) return;
    draft = draftOf(profile);
    tried = false;
    failure = undefined;
  });

  const problems = $derived(draftProblems(draft));
  const shown = $derived(tried ? problems : { env: {} });
  const endpoint = $derived(draft.kind === ProviderProfileKind.CLIPROXYAPI);
  const title = $derived(profile ? `Edit ${profileName(profile)}` : "New provider profile");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    tried = true;
    if (hasProblems(problems)) {
      // The first field that needs attention, after the messages rendered.
      const form = event.currentTarget as HTMLFormElement;
      requestAnimationFrame(() => form.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    busy = true;
    failure = undefined;
    try {
      onsaved(await saveProfile(saveRequest(workerId, draft, configVersion)));
      open = false;
    } catch (error) {
      failure =
        error instanceof HttpError && error.status === 409
          ? `${error.message}. Close this dialog to see the current profiles.`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open {title} description="How the agents on this worker reach their models. Changes reach the worker right away and apply to new turns." size="lg">
  <form class="grid gap-6" onsubmit={submit} novalidate>
    <Field label="Name" error={shown.displayName} optional={draft.builtIn}>
      <Input name="displayName" bind:value={draft.displayName} placeholder={draft.builtIn ? "Device login" : "e.g. Team proxy"} autocomplete="off" maxlength={80} data-autofocus />
    </Field>

    {#if !draft.builtIn}
      <Fieldset legend="Connection">
        <KindChoice bind:value={draft.kind} />
      </Fieldset>

      <Fieldset legend="Agents" error={shown.providers}>
        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <Checkbox name="claude" label="Claude" bind:checked={draft.claude} />
          <Checkbox name="codex" label="Codex" bind:checked={draft.codex} />
        </div>
      </Fieldset>
    {/if}

    {#if endpoint && !draft.builtIn}
      <GrowIn class="grid gap-6">
        <Field label="Endpoint URL" error={shown.baseUrl} description="Claude calls <URL>/v1/messages, Codex <URL>/v1/responses.">
          <Input name="baseUrl" type="url" inputmode="url" bind:value={draft.baseUrl} placeholder="http://127.0.0.1:8317" autocomplete="off" spellcheck="false" class="font-mono" />
        </Field>
        <Field label="API key" error={shown.apiKey} description="Stored encrypted. Only the worker gets it; it is never shown again.">
          <SecretValue set={draft.apiKeySet} bind:action={draft.keyAction} bind:value={draft.apiKey} name="apiKey" allowClear placeholder="Key" />
        </Field>
      </GrowIn>
    {/if}

    <Fieldset legend="Environment variables" description="Set for this profile's Claude Code and Codex processes. Secret values are stored encrypted and never shown again.">
      <EnvVarEditor bind:rows={draft.env} kind={draft.kind} problems={shown.env} />
    </Fieldset>

    {#if !draft.builtIn}
      <Checkbox
        name="enabled"
        label="Use this profile"
        description="When off, new threads cannot pick it and its threads stop with a clear reason until you turn it back on."
        bind:checked={draft.enabled}
      />
    {/if}

    {#if failure}<Alert tone="error">{failure}</Alert>{/if}

    <DialogActions>
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy}>{profile ? "Save" : "Create profile"}</Button>
    </DialogActions>
  </form>
</Dialog>
