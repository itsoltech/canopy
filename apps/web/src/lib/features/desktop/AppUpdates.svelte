<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";
  import type { ClassValue } from "svelte/elements";
  import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import UpdateReleaseNotes from "./UpdateReleaseNotes.svelte";
  import { updateCheckChoices } from "@canopy/domain/update-checks";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";
  import { formatLocalDateTime } from "#lib/shared/format.ts";

  let {
    class: className,
    layout,
  }: {
    class?: ClassValue;
    layout?: Snippet<[Snippet, Snippet, boolean]>;
  } = $props();

  let status = $state<DesktopUpdateStatus>();
  let error = $state("");
  let pending = $state(false);
  let restarting = $state(false);

  // Select previews its value locally. Restore the saved choice if the switch fails.
  let choice = $state("");

  const busy = $derived(
    pending || restarting || status?.changingChannel || status?.phase === "checking" || status?.phase === "downloading",
  );

  const options = [
    { value: "stable", label: "Stable", description: "Releases that passed beta." },
    { value: "beta", label: "Beta", description: "New features earlier, plus stable releases." },
    { value: "nightly", label: "Nightly", description: "Latest development builds." },
  ] as const satisfies readonly SelectOption[];

  const label = (channel: string) => options.find((option) => option.value === channel)?.label ?? channel;

  function receive(value: DesktopUpdateStatus) {
    status = value;
    choice = value.channel;
  }

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge?.updates) return;
    const off = bridge.onUpdates(receive);
    void bridge
      .updates()
      .then(receive)
      .catch(() => {
        error = "Could not load app update settings. Restart Canopy to try again.";
      });

    return off;
  });

  async function run<T>(operation: () => Promise<T>) {
    if (pending) return;
    pending = true;
    error = "";

    try {
      await operation();
    } catch {
      error = "Could not finish this update action. Try again.";
    } finally {
      pending = false;

      if (status) choice = status.channel;
    }
  }

  function change(value: string) {
    const channel = options.find((option) => option.value === value)?.value;

    if (channel)
      void run(async () => {
        receive(await window.canopyDesktop!.setUpdateChannel(channel));
      });
  }

  async function changeInterval(value: string) {
    const bridge = window.canopyDesktop;

    if (!bridge?.setUpdateCheckInterval) return;
    await run(async () => receive(await bridge.setUpdateCheckInterval!(Number(value))));
  }

  const checkedTime = (value: number | undefined) => (value ? formatLocalDateTime(new Date(value)) : "never");
</script>

{#snippet releases()}
  {#if status}
    {@const current = status}
    <SettingsGroup title="This app" class={className}>
      <SettingsRow title="Installed version">
        {#snippet control()}<span class="text-base/6 tabular-nums sm:text-sm/6">{current.version}</span><Badge
            >{label(current.buildChannel)}</Badge
          >{/snippet}
      </SettingsRow>
      <div class="grid gap-4 px-4 py-4">
        {#if status.message !== status.error}
          <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">
            {status.message}{status.updateVersion ? ` · ${status.updateVersion}` : ""}
          </p>
        {/if}
        {#if status.phase === "downloading"}
          <p
            class="text-base/6 text-zinc-500 tabular-nums sm:text-sm/6 dark:text-zinc-400"
            role="progressbar"
            aria-label="Update download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(status.progress ?? 0)}
          >
            {Math.round(status.progress ?? 0)}%
          </p>
        {/if}
        {#if status.error}
          <Alert
            tone="error"
            title={status.updateVersion && status.message === status.error ? `Update ${status.updateVersion}` : ""}
          >
            {status.error}
          </Alert>
        {/if}
        {#if status.stagedVersion || status.phase === "downloaded"}
          <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            {status.phase === "checking" || status.phase === "downloading"
              ? "Restart waits for this download, then stops agents running on this computer."
              : "Restarting stops the agents running on this computer."}
          </p>
        {/if}
        <div class="flex flex-wrap gap-3">
          {#if status.stagedVersion || status.phase === "downloaded"}
            <Button
              variant="primary"
              disabled={restarting || status.changingChannel}
              loading={restarting}
              onclick={async () => {
                restarting = true;
                try {
                  await window.canopyDesktop!.restartToUpdate();
                } catch {
                  error = "Could not finish this update action. Try again.";
                } finally {
                  restarting = false;
                }
              }}>Restart to update</Button
            >
          {/if}
          <Button
            disabled={busy || restarting || status.phase === "disabled"}
            loading={status.phase === "checking"}
            onclick={() => run(async () => receive(await window.canopyDesktop!.checkForUpdates()))}
            >Check for updates</Button
          >
        </div>
        {#if current.publishing && current.publishing !== current.message}<p
            class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
          >
            {current.publishing}
          </p>{/if}
        {#if current.updateVersion && ["downloading", "downloaded", "error"].includes(current.phase)}
          <UpdateReleaseNotes releases={current.releases ?? []} channel={current.channel} />
        {/if}
      </div>
    </SettingsGroup>
  {/if}
{/snippet}

{#snippet preferences()}
  {#if status}
    {@const current = status}
    <SettingsGroup title="Update preferences" description="This device" class={className}>
      {#snippet actions()}<Button
          size="sm"
          disabled={busy}
          onclick={() =>
            run(async () => {
              if (window.canopyDesktop?.setUpdateCheckInterval)
                receive(await window.canopyDesktop.setUpdateCheckInterval(360));
              if (status && status.channel !== status.buildChannel)
                receive(await window.canopyDesktop!.setUpdateChannel(status.buildChannel));
            })}>Restore defaults</Button
        >{/snippet}
      {#if current.checkIntervalMinutes !== undefined}
        <PreferenceRow
          title="Update check frequency"
          description="Check for releases while Canopy is open."
          changed={current.checkIntervalMinutes !== 360}
          onreset={() => changeInterval("360")}
        >
          {#snippet control()}<div class="w-56 max-w-full">
              <Select
                aria-label="Update check frequency"
                value={String(current.checkIntervalMinutes)}
                options={updateCheckChoices}
                onchange={changeInterval}
                disabled={pending}
              />
            </div>{/snippet}
          <p class="mt-1 text-sm/5 text-zinc-500 tabular-nums dark:text-zinc-400" role="status">
            Last checked {checkedTime(current.lastCheckedAt)}{#if current.checkIntervalMinutes !== 0}{" · Next check "}
              {current.nextCheckAt ? checkedTime(current.nextCheckAt) : "unavailable in this installation"}{/if}
          </p>
          {#if current.checkIntervalMinutes === 0}<p class="mt-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
              Automatic downloads are off.
            </p>{/if}
        </PreferenceRow>
      {/if}
      <PreferenceRow
        title="Update channel"
        changed={current.channel !== current.buildChannel}
        onreset={() => change(current.buildChannel)}
      >
        {#snippet control()}<div class="w-40">
            <Select aria-label="Update channel" {options} bind:value={choice} onchange={change} disabled={busy} />
          </div>{/snippet}
      </PreferenceRow>
    </SettingsGroup>
  {/if}
{/snippet}

{#if layout}
  {@render layout(releases, preferences, Boolean(status))}
{:else}
  {@render releases()}
  {@render preferences()}
{/if}
{#if error}<Alert tone="error" class="mt-4">{error}</Alert>{/if}
