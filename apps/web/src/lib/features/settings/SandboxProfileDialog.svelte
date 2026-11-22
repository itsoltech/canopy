<script lang="ts">
  import { tick } from "svelte";
  import { create, equals } from "@bufbuild/protobuf";
  import { SandboxProfileSchema, type SandboxProfile } from "@canopy/contracts";
  import { normalizeSandboxProfile } from "@canopy/domain/sandbox-profiles";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { useSettings } from "./settings-state.svelte.ts";

  type Action = { mode: "add" } | { mode: "edit" | "delete"; profile: SandboxProfile };

  const duplicateNameError = "A sandbox profile already uses this name. Choose another name.";
  let { ondelete }: { ondelete: () => void } = $props();
  const settings = useSettings();
  const formId = $props.id();
  let action = $state.raw<Action>({ mode: "add" });
  let open = $state(false);
  let busy = $state(false);
  let id = "";
  let name = $state("");
  let domains = $state("");
  let validationError = $state<string>();
  let failed = $state(false);

  const original = $derived(action.mode === "add" ? undefined : action.profile);
  const current = $derived(settings.sandboxProfiles.find((item) => item.id === original?.id));
  const stale = $derived(original && (!current || !equals(SandboxProfileSchema, current, original)));

  export function show(next: Action) {
    action = next;
    const profile = next.mode === "add" ? undefined : next.profile;
    id = profile?.id ?? crypto.randomUUID();
    name = profile?.name ?? "";
    domains = profile?.allowedDomains.join("\n") ?? "";
    validationError = undefined;
    failed = false;
    open = true;
  }

  function hasDuplicateName(profile: SandboxProfile): boolean {
    const name = profile.name.toLowerCase();

    return settings.sandboxProfiles.some((item) => item.id !== profile.id && item.name.toLowerCase() === name);
  }

  function readDraft(): SandboxProfile | undefined {
    const allowedDomains = domains
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    try {
      const profile = normalizeSandboxProfile(create(SandboxProfileSchema, { id, name, allowedDomains }));

      if (hasDuplicateName(profile)) {
        validationError = duplicateNameError;

        return undefined;
      }

      return profile;
    } catch (cause) {
      validationError = cause instanceof Error ? cause.message : "Check the profile name and allowed domains.";

      return undefined;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();

    if (busy || stale) return;
    validationError = undefined;
    failed = false;
    const pendingAction = action;
    const draft = pendingAction.mode === "delete" ? undefined : readDraft();

    if (pendingAction.mode !== "delete" && !draft) return;

    busy = true;

    try {
      const saved = draft
        ? await settings.saveSandboxProfile(draft, original)
        : pendingAction.mode === "delete" && (await settings.deleteSandboxProfile(pendingAction.profile));

      if (!saved) {
        if (draft && hasDuplicateName(draft)) validationError = duplicateNameError;
        else failed = true;

        return;
      }

      open = false;

      if (pendingAction.mode === "delete") {
        await tick();
        ondelete();
      }
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  dismissible={!busy}
  title={action.mode === "add"
    ? "Add sandbox profile"
    : action.mode === "edit"
      ? "Edit sandbox profile"
      : "Delete sandbox profile?"}
>
  <form id={formId} class="grid gap-4" onsubmit={submit} novalidate>
    {#if action.mode === "delete"}
      <p class="text-base/6 wrap-anywhere sm:text-sm/6">
        This permanently deletes “{action.profile.name}” from your sandbox profiles.
      </p>
    {:else}
      <fieldset class="grid min-w-0 gap-4" disabled={busy} oninput={() => (validationError = undefined)}>
        <Field label="Name">
          <Input name="profile-name" maxlength={64} required bind:value={name} data-autofocus />
        </Field>
        <Field
          label="Allowed domains"
          description="Enter one exact domain per line and list each subdomain separately. Leave blank to block all outbound shell connections."
        >
          <Textarea
            name="allowed-domains"
            rows={4}
            placeholder="api.example.com"
            spellcheck={false}
            autocapitalize="none"
            bind:value={domains}
          />
        </Field>
      </fieldset>
    {/if}
    {#if stale && !busy}
      {#if current}
        <Alert tone="warning" title="This profile changed"
          >Close this dialog and reopen the profile to see the latest version.</Alert
        >
      {:else}
        <Alert tone="warning" title="This profile no longer exists"
          >Close this dialog to return to the profile list.</Alert
        >
      {/if}
    {:else if validationError}
      <Alert tone="error">{validationError}</Alert>
    {:else if failed}
      <Alert
        tone="error"
        title={action.mode === "delete" ? "Could not delete the profile" : "Could not save the profile"}
      >
        Check your connection and try again.
      </Alert>
    {/if}
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
        icon={action.mode === "delete" ? "trash" : "check"}
        disabled={stale}
        loading={busy}
      >
        {action.mode === "delete" ? "Delete profile" : action.mode === "edit" ? "Save changes" : "Add profile"}
      </Button>
    </DialogActions>
  {/snippet}
</Dialog>
