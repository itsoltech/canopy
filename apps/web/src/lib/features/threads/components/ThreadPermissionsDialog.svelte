<script lang="ts">
  import { equals } from "@bufbuild/protobuf";
  import { SandboxProfileSchema, type ui } from "@canopy/contracts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Radio from "#lib/shared/ui/Radio.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import { updateThread } from "../api.ts";
  import {
    fullAutoAvailable,
    isFullAccess,
    isPermissionModeAvailable,
    permissionDescription,
    permissionKey,
    permissionLook,
    permissionModes,
    savedFullAutoDescription,
    type PermissionModeKey,
  } from "../labels.ts";
  import {
    defaultSandboxProfile,
    linkedSandboxSelection,
    nativeWindowsSandboxMode,
    sandboxProfileGroups,
    sandboxProfileOption,
    sandboxProfileProblem,
    sandboxProfilesSettingsHref,
  } from "../sandbox-profiles.ts";
  import PermissionModeTitle from "./PermissionModeTitle.svelte";

  /**
   * The thread's default permission mode (UpdateThread): what turns run with when the composer sends no
   * mode of its own. Takes effect from the next turn; approvals a running turn waits for are unchanged.
   * The new default arrives through the thread's stream. Picking Full access turns Save into its confirmation.
   */
  let {
    open = $bindable(false),
    thread,
    worker,
  }: { open?: boolean; thread: ui.Thread; worker: ui.Worker | undefined } = $props();

  const settings = useSettings();
  const current = $derived(permissionKey(thread.permissionMode));
  const fullAuto = $derived(fullAutoAvailable(thread.provider, worker?.os));
  const modes = $derived(permissionModes.filter((option) => isPermissionModeAvailable(option.value, fullAuto)));
  const savedProfile = $derived(thread.sandboxProfile?.profile);
  const target = $derived({ worker, provider: thread.provider, profileId: thread.providerProfileId });
  const savedProblem = $derived(savedProfile && sandboxProfileProblem(target, savedProfile));
  const catalogProfile = $derived(settings.sandboxProfiles.find((profile) => profile.id === savedProfile?.id));

  const savedChoice = $derived(
    !savedProfile
      ? ""
      : catalogProfile && equals(SandboxProfileSchema, savedProfile, catalogProfile)
        ? savedProfile.id
        : "saved",
  );

  const options = $derived([
    defaultSandboxProfile,
    ...(savedProfile && savedChoice === "saved"
      ? [
          {
            ...sandboxProfileOption(savedProfile, savedProblem),
            value: savedChoice,
            label: `${savedProfile.name} (saved)`,
          },
        ]
      : []),
    ...settings.sandboxProfiles.map((profile) =>
      sandboxProfileOption(
        profile,
        (thread.nodeId || worker?.nodeId) && profile.id !== savedChoice
          ? linkedSandboxSelection
          : sandboxProfileProblem(target, profile),
      ),
    ),
  ]);

  const groups = $derived(sandboxProfileGroups(options));

  const pickerOptions = $derived([
    ...groups.available.map((option) => ({
      ...option,
      description: undefined,
      suffix: option.value ? option.description : undefined,
      tooltip: option.description,
    })),
    ...groups.unavailable.flatMap(([reason, profiles]) =>
      profiles.map((option) => ({ ...option, description: undefined, group: reason, tooltip: reason })),
    ),
  ]);

  // Edits start from the thread's default each time the dialog opens.
  let picked = $state<PermissionModeKey>();
  let pickedProfile = $state<string>();

  $effect.pre(() => {
    if (open) {
      picked = undefined;
      pickedProfile = undefined;
      error = undefined;
    }
  });

  const mode = $derived(picked && isPermissionModeAvailable(picked, fullAuto) ? picked : current);
  const selectedMode = $derived(modes.find((option) => option.value === mode));
  const profileChoice = $derived(pickedProfile ?? savedChoice);
  const changesProfile = $derived(mode === "FULL_AUTO" ? profileChoice !== savedChoice : Boolean(savedProfile));
  const changesMode = $derived(mode !== current || !thread.permissionModeSelected);

  const profileUnavailable = $derived(
    mode === "FULL_AUTO" &&
      changesProfile &&
      !options.some((option) => option.value === profileChoice && !option.disabled),
  );

  const profileBusy = $derived(
    ["creating", "running", "waiting_input"].includes(thread.status) ||
      thread.turnStarting ||
      thread.backgroundTasks > 0,
  );

  const blocked = $derived(profileUnavailable || (changesProfile && profileBusy));

  const confirmFullAccess = $derived(isFullAccess(mode) && changesMode);
  let busy = $state(false);
  let error = $state<string>();
  const id = $props.id();

  async function save(event: SubmitEvent) {
    event.preventDefault();

    if (busy || blocked) return;

    if (!changesMode && !changesProfile) return void (open = false);
    busy = true;
    error = undefined;

    try {
      await updateThread(thread.id, {
        ...(changesMode && { permissionMode: mode }),
        ...(changesProfile && { sandboxProfileId: mode === "FULL_AUTO" ? profileChoice : "" }),
      });
      open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title="Permissions" dismissible={!busy} description="Choose permissions for new turns.">
  <form class="grid gap-4" onsubmit={save}>
    {#if fullAuto === false && !savedProfile}
      <p class="text-base/6 text-muted sm:text-sm/5">
        {current === "FULL_AUTO" ? savedFullAutoDescription : nativeWindowsSandboxMode}
      </p>
    {/if}
    <fieldset class="grid gap-1" aria-label="Permission mode" disabled={busy}>
      {#each modes as option (option.value)}
        {@const tone = permissionLook(option.value).tone}
        <label
          class={[
            "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 ring-1 ring-transparent hover:bg-zinc-950/2.5 has-checked:ring-zinc-950/10 sm:min-h-9 dark:hover:bg-white/2.5 dark:has-checked:ring-white/10 pointer-coarse:min-h-11",
            tone === "amber" &&
              "has-checked:bg-amber-50 has-checked:ring-amber-600/25 dark:has-checked:bg-amber-400/5 dark:has-checked:ring-amber-400/20",
            tone === "rose" &&
              "has-checked:bg-rose-50 has-checked:ring-rose-600/20 dark:has-checked:bg-rose-400/5 dark:has-checked:ring-rose-400/20",
          ]}
        >
          <span class="flex h-lh items-center text-base/6 sm:text-sm/6">
            <Radio
              name="{id}-mode"
              value={option.value}
              checked={option.value === mode}
              onchange={() => (picked = option.value)}
              aria-labelledby="{id}-{option.value}-label"
              aria-describedby="{id}-{option.value}"
            />
          </span>
          <span id="{id}-{option.value}-label" class="min-w-0 text-base/6 sm:text-sm/6">
            <PermissionModeTitle
              mode={option.value}
              {fullAuto}
              note={option.value === current ? "Current" : undefined}
              class="font-medium text-zinc-950 dark:text-white"
            />
          </span>
          <span id="{id}-{option.value}" class="sr-only">{permissionDescription(option, fullAuto)}</span>
        </label>
      {/each}
    </fieldset>
    {#if selectedMode && !confirmFullAccess}
      <p class="min-h-5 text-sm/5 text-pretty text-muted">{permissionDescription(selectedMode, fullAuto)}</p>
    {/if}
    {#if mode === "FULL_AUTO" && (thread.runtime === "worker" || savedProfile)}
      <Field label="Sandbox profile">
        <Select
          value={profileChoice}
          options={pickerOptions}
          aria-label="Sandbox profile"
          disabled={busy || profileBusy}
          onchange={(id) => (pickedProfile = id)}
        />
      </Field>
      <a
        href={sandboxProfilesSettingsHref}
        class="justify-self-start text-sm/5 text-brand-700 underline underline-offset-2 dark:text-brand-300"
        >Manage sandbox profiles</a
      >
      {#if profileBusy}
        <p class="text-sm/5 text-muted">Wait for this thread to finish its work before changing profiles.</p>
      {/if}
    {:else if changesProfile}
      <p class="text-sm/5 text-muted">
        {profileBusy
          ? "Wait for this thread to finish its work before removing its sandbox profile."
          : "Changing modes removes the saved sandbox profile."}
      </p>
    {/if}
    {#if savedProblem && savedProfile && mode === "FULL_AUTO" && !changesProfile}
      <Alert tone="warning" title="Saved sandbox profile unavailable">
        {savedProblem}
        {#if !profileBusy}
          Choose another profile.{/if}
      </Alert>
    {:else if profileUnavailable}
      <Alert tone="warning" title="Selected sandbox profile unavailable">Choose another profile.</Alert>
    {/if}
    {#if confirmFullAccess}
      <Alert tone="danger"
        >Every turn without a mode of its own edits files and runs commands without asking. No sandbox keeps it in the
        workspace.</Alert
      >
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      {#if confirmFullAccess}
        <Button type="submit" variant="danger" disabled={blocked} loading={busy}>Turn on full access</Button>
      {:else}
        <Button type="submit" variant="primary" disabled={blocked} loading={busy}>Save</Button>
      {/if}
    </DialogActions>
  </form>
</Dialog>
