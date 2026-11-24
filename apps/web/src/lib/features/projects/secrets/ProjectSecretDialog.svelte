<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { registerUnsentWork } from "#lib/features/workers/unsent-work.ts";
  import { deleteProjectSecret, putProjectSecret, SAVE_RETRY } from "./api.ts";
  import SecretValueInput from "./SecretValueInput.svelte";
  import { secretNameError, secretValueError } from "./validation.ts";

  type Action = { mode: "add"; names: readonly string[] } | { mode: "replace" | "delete"; name: string };

  let {
    projectId,
    onsaved,
    ondeleted,
  }: {
    projectId: string;
    onsaved: (secret: ui.ProjectSecret) => void;
    ondeleted: (name: string) => void;
  } = $props();

  const formId = $props.id();
  let action = $state.raw<Action>({ mode: "add", names: [] });
  let open = $state(false);
  let busy = $state(false);
  let name = $state("");

  // The value lives only in this control and the HTTPS request; it is cleared on submit and on close.
  let value = $state("");
  let nameError = $state<string>();
  let valueError = $state<string>();
  let failure = $state<string>();

  $effect(() => registerUnsentWork(() => !!value.length || busy));

  $effect(() => {
    if (!open) value = "";
  });

  onDestroy(() => {
    value = "";
  });

  export function show(next: Action) {
    action = next;
    name = next.mode === "add" ? "" : next.name;
    value = "";
    nameError = undefined;
    valueError = undefined;
    failure = undefined;
    open = true;
  }

  function validate(): boolean {
    nameError = action.mode === "add" ? secretNameError(name, action.names) : undefined;
    valueError = action.mode === "delete" ? undefined : secretValueError(value);

    return !nameError && !valueError;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();

    if (busy || !validate()) return;
    const pending = action;
    const target = pending.mode === "add" ? name : pending.name;
    busy = true;
    failure = undefined;

    try {
      if (pending.mode === "delete") {
        await deleteProjectSecret(projectId, target);
        open = false;
        // After the dialog has closed, so the parent can move focus off the removed row.
        await tick();
        ondeleted(target);
      } else {
        const sending = value;
        value = "";
        const secret = await putProjectSecret(projectId, target, sending);
        open = false;
        onsaved(secret);
      }
    } catch (cause) {
      failure =
        pending.mode === "delete"
          ? "Could not delete the secret. Check your connection, then retry."
          : cause instanceof Error
            ? cause.message
            : SAVE_RETRY;
    } finally {
      busy = false;
    }
  }

  const title = $derived(
    action.mode === "add" ? "Add secret" : action.mode === "replace" ? "Replace secret value" : "Delete secret?",
  );
</script>

<Dialog bind:open dismissible={!busy} {title}>
  <form id={formId} class="grid gap-4" onsubmit={submit} autocomplete="off" novalidate>
    {#if action.mode === "delete"}
      <p class="text-base/6 wrap-anywhere sm:text-sm/6">
        This deletes “<span class="font-mono">{action.name}</span>” from this project. Canopy revokes it in threads that
        use it. Agents can no longer ask for it.
      </p>
    {:else}
      <fieldset class="grid min-w-0 gap-4" disabled={busy}>
        {#if action.mode === "add"}
          <Field label="Name" description="Agents ask for the secret by this exact name." error={nameError}>
            <Input
              name="project-secret-name"
              maxlength={128}
              required
              bind:value={name}
              oninput={() => (nameError = undefined)}
              placeholder="API_TOKEN"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              class="font-mono"
              data-autofocus
            />
          </Field>
        {:else}
          <p class="text-base/6 wrap-anywhere sm:text-sm/6">
            Canopy revokes the old value of “<span class="font-mono">{action.name}</span>” in threads that use it.
            Agents ask again to get the new value.
          </p>
        {/if}
        <Field
          label={action.mode === "add" ? "Value" : "New value"}
          description="Canopy never shows the value again."
          error={valueError}
        >
          <SecretValueInput
            bind:value
            disabled={busy}
            autofocus={action.mode === "replace"}
            oninput={() => (valueError = undefined)}
          />
        </Field>
      </fieldset>
    {/if}
    {#if failure && action.mode !== "delete" && failure !== SAVE_RETRY}
      <!-- A gateway answer (name, project) names the problem; the value was cleared when it was sent. -->
      <Alert tone="error" title={failure}>Enter the value again, then retry.</Alert>
    {:else if failure}<Alert tone="error">{failure}</Alert>{/if}
  </form>
  {#snippet footer()}
    <DialogActions>
      <Button data-autofocus={action.mode === "delete" ? "" : undefined} disabled={busy} onclick={() => (open = false)}
        >Cancel</Button
      >
      <Button
        form={formId}
        type="submit"
        variant={action.mode === "delete" ? "danger" : "primary"}
        icon={action.mode === "delete" ? "trash" : "lock-closed"}
        loading={busy}
      >
        {action.mode === "delete" ? "Delete secret" : action.mode === "replace" ? "Replace value" : "Add secret"}
      </Button>
    </DialogActions>
  {/snippet}
</Dialog>
