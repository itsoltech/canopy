<script lang="ts">
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import { onMount } from "svelte";
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

  let { class: className }: { class?: ClassValue } = $props();
  let status = $state<DesktopUpdateStatus>();
  let error = $state("");
  let pending = $state(false);

  // Select previews its value locally. Restore it after a cancelled native confirmation.
  let choice = $state("");

  const busy = $derived(
    pending || status?.changingChannel || status?.phase === "checking" || status?.phase === "downloading",
  );

  const options = [
    { value: "stable", label: "Stable", description: "Releases that passed beta." },
    { value: "beta", label: "Beta", description: "New features earlier, plus stable releases." },
    { value: "nightly", label: "Nightly", description: "A new build every day. Newest changes, more risk." },
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

{#if status}
  {@const current = status}
  <SettingsGroup title="App updates" description="This device" class={className}>
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
    <SettingsRow title="Installed version">
      {#snippet control()}<span class="text-base/6 tabular-nums sm:text-sm/6">{current.version}</span><Badge
          >{label(current.buildChannel)}</Badge
        >{/snippet}
    </SettingsRow>
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
          Last checked {checkedTime(current.lastCheckedAt)} · Next check {current.checkIntervalMinutes === 0
            ? "manual only"
            : current.nextCheckAt
              ? checkedTime(current.nextCheckAt)
              : current.phase === "downloaded"
                ? "after restart"
                : "unavailable in this installation"}
        </p>
        {#if current.checkIntervalMinutes === 0}<p class="mt-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
            Automatic downloads are off. Use Check for updates to check manually.
          </p>{/if}
      </PreferenceRow>
    {/if}
    <PreferenceRow
      title="Update channel"
      description="Canopy asks before switching to a channel with an older version."
      changed={current.channel !== current.buildChannel}
      onreset={() => change(current.buildChannel)}
    >
      {#snippet control()}<div class="w-40">
          <Select aria-label="Update channel" {options} bind:value={choice} onchange={change} disabled={busy} />
        </div>{/snippet}
    </PreferenceRow>
    <div class="grid gap-4 px-4 py-4">
      <div class="grid gap-2" role="status" aria-live="polite">
        <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          {status.message}{status.updateVersion ? ` · ${status.updateVersion}` : ""}
        </p>
        {#if status.phase === "downloading"}
          <div class="flex items-center gap-3">
            <ProgressBar class="min-w-0 flex-1" label="Update download" value={status.progress ?? 0} />
            <span class="text-base/6 text-zinc-500 tabular-nums sm:text-sm/6 dark:text-zinc-400"
              >{Math.round(status.progress ?? 0)}%</span
            >
          </div>
        {/if}
      </div>
      {#if status.phase === "downloaded"}
        <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Restarting stops the agents running on this computer.
        </p>
      {/if}
      <div class="flex flex-wrap gap-3">
        {#if status.phase === "downloaded"}
          <Button variant="primary" disabled={busy} onclick={() => run(() => window.canopyDesktop!.restartToUpdate())}
            >Restart to update</Button
          >
        {:else}
          <Button
            disabled={busy || status.phase === "disabled"}
            loading={status.phase === "checking"}
            onclick={() => run(async () => receive(await window.canopyDesktop!.checkForUpdates()))}
            >Check for updates</Button
          >
        {/if}
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
{#if error}<Alert tone="error" class="mt-4">{error}</Alert>{/if}
