<script lang="ts">
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";
  import type { ClassValue } from "svelte/elements";
  import type { DesktopUpdatesState } from "./desktop-updates.svelte.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { updateCheckChoices } from "@canopy/domain/update-checks";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";
  import { formatLocalDateTime } from "#lib/shared/format.ts";

  let { app, class: className }: { app: DesktopUpdatesState; class?: ClassValue } = $props();
  const status = $derived(app.status);
  let error = $state("");
  let pending = $state(false);

  // Select previews its value locally. Restore the saved choice if the switch fails.
  let choice = $state("");

  const busy = $derived(
    pending ||
      app.pending ||
      app.restarting ||
      status?.changingChannel ||
      status?.phase === "checking" ||
      status?.phase === "downloading",
  );

  const options = [
    { value: "stable", label: "Stable", description: "Releases that passed beta." },
    { value: "beta", label: "Beta", description: "New features earlier, plus stable releases." },
    { value: "nightly", label: "Nightly", description: "Latest development builds." },
  ] as const satisfies readonly SelectOption[];

  $effect(() => {
    choice = status?.channel ?? "";
  });

  async function run(operation: () => Promise<void>) {
    if (pending) return;
    pending = true;
    error = "";

    try {
      await operation();
    } catch {
      error = "Could not save update preferences. Try again.";
    } finally {
      pending = false;

      if (status) choice = status.channel;
    }
  }

  function change(value: string) {
    const channel = options.find((option) => option.value === value)?.value;
    const bridge = window.canopyDesktop;

    if (channel && bridge)
      void run(async () => {
        app.status = await bridge.setUpdateChannel(channel);
      });
  }

  async function changeInterval(value: string) {
    const setCheckInterval = window.canopyDesktop?.setUpdateCheckInterval;

    if (!setCheckInterval) return;
    await run(async () => {
      app.status = await setCheckInterval(Number(value));
    });
  }

  function restoreDefaults() {
    const bridge = window.canopyDesktop;

    if (!bridge) return;
    void run(async () => {
      if (bridge.setUpdateCheckInterval) app.status = await bridge.setUpdateCheckInterval(360);

      if (status && status.channel !== status.buildChannel)
        app.status = await bridge.setUpdateChannel(status.buildChannel);
    });
  }

  const checkedTime = (value: number | undefined) => (value ? formatLocalDateTime(new Date(value)) : "never");
</script>

{#if status}
  {@const current = status}
  <SettingsGroup title="This app" description="This device" class={className}>
    {#snippet actions()}<Button size="sm" disabled={busy} onclick={restoreDefaults}>Restore defaults</Button>{/snippet}
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
{#if error}<Alert tone="error" class="mt-4">{error}</Alert>{/if}
