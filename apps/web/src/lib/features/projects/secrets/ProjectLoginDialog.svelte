<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { parseLoginWebsites } from "@canopy/domain/project-logins";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { registerUnsentWork } from "#lib/features/workers/unsent-work.ts";
  import { deleteProjectSecret, LOGIN_SAVE_RETRY, putProjectLogin } from "./api.ts";
  import OneTimeCodePreview from "./OneTimeCodePreview.svelte";
  import SecretValueInput from "./SecretValueInput.svelte";
  import { secretNameError, secretValueError } from "./validation.ts";

  type Action =
    | { mode: "add"; names: readonly string[] }
    | { mode: "edit"; secret: ui.ProjectSecret }
    | { mode: "delete"; name: string };

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
  let websites = $state("");
  let username = $state("");
  let showUsername = $state(true);
  let notes = $state("");
  let use = $state("automatic");
  let outsideBrowser = $state(false);

  // The password and setup key live only in these controls and the HTTPS request; cleared on submit and close.
  let password = $state("");
  let setup = $state("");

  /** keep: leave the saved setup key; replace: send `setup`; remove: send an empty key. */
  let codeChange = $state<"keep" | "replace" | "remove">("replace");
  let errors = $state<{ name?: string; websites?: string; password?: string }>({});
  let failure = $state<string>();

  const editing = $derived(action.mode === "edit" ? action.secret : undefined);
  const savedCode = $derived(Boolean(editing?.login?.oneTimeCode));

  $effect(() => registerUnsentWork(() => !!password.length || !!setup.length || busy));

  $effect(() => {
    if (open) return;
    password = "";
    setup = "";
  });

  onDestroy(() => {
    password = "";
    setup = "";
  });

  export function show(next: Action) {
    action = next;
    const login = next.mode === "edit" ? next.secret.login : undefined;
    name = next.mode === "add" ? "" : next.mode === "edit" ? next.secret.name : next.name;
    websites = login?.websites.join("\n") ?? "";
    username = login?.username ?? "";
    showUsername = login?.showUsername ?? true;
    notes = login?.notes ?? "";
    use = login?.askEachTime ? "ask" : "automatic";
    outsideBrowser = login?.outsideBrowser ?? false;
    codeChange = login?.oneTimeCode ? "keep" : "replace";
    password = "";
    setup = "";
    errors = {};
    failure = undefined;
    open = true;
  }

  function validate(): boolean {
    const lines = websites.split("\n").filter((line) => line.trim());

    errors = {
      ...(action.mode === "add" && { name: secretNameError(name, action.names) }),
      websites: parseLoginWebsites(lines)
        ? undefined
        : "Add 1–20 websites, one per line, such as https://app.example.com.",
      ...((action.mode === "add" || password) && { password: secretValueError(password) }),
    };

    return !errors.name && !errors.websites && !errors.password;
  }

  async function remove(target: string) {
    await deleteProjectSecret(projectId, target);
    open = false;
    await tick();
    ondeleted(target);
  }

  async function save(target: string) {
    const sending = { password, setup };
    password = "";
    setup = "";

    const secret = await putProjectLogin(projectId, target, {
      websites: websites.split("\n").filter((line) => line.trim()),
      username: username.trim(),
      showUsername,
      notes,
      askEachTime: use === "ask",
      outsideBrowser,
      ...(sending.password && { password: sending.password }),
      ...(codeChange === "remove" && { oneTimeCodeSetup: "" }),
      ...(codeChange === "replace" && sending.setup.trim() && { oneTimeCodeSetup: sending.setup.trim() }),
    });

    open = false;
    onsaved(secret);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();

    if (busy || (action.mode !== "delete" && !validate())) return;
    const pending = action;
    busy = true;
    failure = undefined;

    try {
      if (pending.mode === "delete") await remove(pending.name);
      else await save(pending.mode === "add" ? name : pending.secret.name);
    } catch (cause) {
      failure =
        pending.mode === "delete"
          ? "Could not delete the login. Check your connection, then retry."
          : cause instanceof Error
            ? cause.message
            : LOGIN_SAVE_RETRY;
    } finally {
      busy = false;
    }
  }

  const title = $derived(
    action.mode === "add" ? "Add login" : action.mode === "edit" ? `Edit ${action.secret.name}` : "Delete login?",
  );
</script>

<Dialog bind:open dismissible={!busy} {title}>
  <form id={formId} class="grid gap-4" onsubmit={submit} autocomplete="off" novalidate>
    {#if action.mode === "delete"}
      <p class="text-base/6 wrap-anywhere sm:text-sm/6">
        This deletes “<span class="font-mono">{action.name}</span>” from this project. Canopy revokes it in threads that
        use it. Pages where an agent already signed in stay signed in.
      </p>
    {:else}
      <fieldset class="grid min-w-0 gap-4" disabled={busy}>
        {#if action.mode === "add"}
          <Field label="Name" description="Agents use the login by this exact name." error={errors.name}>
            <Input
              name="project-login-name"
              maxlength={128}
              required
              bind:value={name}
              oninput={() => (errors = { ...errors, name: undefined })}
              placeholder="STAGING_ADMIN"
              autocapitalize="off"
              spellcheck={false}
              class="font-mono"
              data-autofocus
            />
          </Field>
        {/if}
        <Field
          label="Websites"
          description="Enter one website per line, using https://*.example.com to include subdomains."
          error={errors.websites}
        >
          <Textarea
            name="project-login-websites"
            rows={2}
            bind:value={websites}
            oninput={() => (errors = { ...errors, websites: undefined })}
            placeholder="https://staging.example.com"
            autocapitalize="off"
            spellcheck={false}
            class="font-mono"
          />
        </Field>
        <Field label="Username" optional>
          <Input
            name="project-login-username"
            bind:value={username}
            placeholder="test@example.com"
            autocapitalize="off"
            spellcheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
          />
        </Field>
        <SettingsRow
          flush
          title="Show username to agents"
          description="When off, agents see “hidden” instead of the username."
        >
          {#snippet control()}<Switch
              name="project-login-show-username"
              label="Show username to agents"
              bind:checked={showUsername}
            />{/snippet}
        </SettingsRow>
        <Field
          label={editing ? "New password" : "Password"}
          description={editing ? "Leave empty to keep the saved password." : "Agents never see the password."}
          optional={Boolean(editing)}
          error={errors.password}
        >
          <SecretValueInput bind:value={password} oninput={() => (errors = { ...errors, password: undefined })} />
        </Field>
        {#if savedCode && codeChange === "keep"}
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-base/6 sm:text-sm/6">One-time code is set.</p>
            <div class="flex gap-2">
              <Button size="sm" onclick={() => (codeChange = "replace")}>Replace setup key</Button>
              <Button size="sm" variant="ghost" onclick={() => (codeChange = "remove")}>Remove</Button>
            </div>
          </div>
        {:else if codeChange === "remove"}
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-base/6 sm:text-sm/6">Saving removes the one-time code.</p>
            <Button size="sm" variant="ghost" onclick={() => (codeChange = "keep")}>Keep code</Button>
          </div>
        {:else}
          <Field
            label="One-time code setup key"
            description="Paste the setup key or otpauth:// link from the app’s two-step sign-in setup."
            optional
          >
            <div class="grid gap-1">
              <SecretValueInput bind:value={setup} />
              <OneTimeCodePreview {setup} />
            </div>
          </Field>
        {/if}
        <Field label="Notes for agents" description="For example, the account’s role or when its data resets." optional>
          <Textarea name="project-login-notes" rows={2} maxlength={2000} bind:value={notes} />
        </Field>
        <Field
          label="Agent use"
          description={use === "ask"
            ? "Canopy asks you in the thread before each turn uses the login."
            : "Agents in this project’s threads use the login when they need it."}
        >
          <SegmentedChoice
            label="Agent use"
            bind:value={use}
            options={[
              { value: "automatic", label: "Automatic" },
              { value: "ask", label: "Ask each time" },
            ]}
          />
        </Field>
        <SettingsRow
          flush
          title="Allow outside the browser"
          description="Agents can also get the login as a private file, for scripts and API tests."
        >
          {#snippet control()}<Switch
              name="project-login-outside-browser"
              label="Allow outside the browser"
              bind:checked={outsideBrowser}
            />{/snippet}
        </SettingsRow>
      </fieldset>
    {/if}
    {#if failure}<Alert tone="error" title={failure}
        >{action.mode === "delete" ? "" : "Enter the password and setup key again, if you changed them."}</Alert
      >{/if}
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
        {action.mode === "delete" ? "Delete login" : action.mode === "edit" ? "Save login" : "Add login"}
      </Button>
    </DialogActions>
  {/snippet}
</Dialog>
