<script lang="ts">
  import { onMount } from "svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import PreferenceRow from "./PreferenceRow.svelte";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
  import { devicePreferences as device } from "./device-preferences.svelte.ts";
  import { enableNotificationSound } from "#lib/features/notifications/notification-sound.ts";

  type Key = "threadNotifications" | "botNotifications";

  let permission = $state("");
  let granted = $state(false);
  let supported = $state(false);
  let desktop = $state(false);
  let error = $state<{ key: Key; text: string }>();
  let notice = $state<{ key: Key; text: string }>();

  const blocked = "Blocked by your browser. Allow notifications in site settings, then retry.";

  const options = [
    { value: "off", label: "Off" },
    { value: "notifications", label: "Notifications" },
    { value: "sound", label: "Notifications with sound" },
  ];

  const rows: readonly { key: Key; title: string; description: string }[] = [
    {
      key: "threadNotifications",
      title: "Thread notifications",
      description: "Send system alerts when threads finish, fail, stop or need you.",
    },
    {
      key: "botNotifications",
      title: "Bot notifications",
      description: "Send system alerts when bots message you or need your approval or answer.",
    },
  ];

  /** The browser permission is shared: its warning and button stay under the first row that is on. */
  const permissionRow = $derived(rows.find((row) => device.values[row.key] !== "off")?.key);

  function refresh() {
    desktop = Boolean(window.canopyDesktop?.showNotification);
    supported = desktop || (window.isSecureContext && "Notification" in window);
    granted = desktop || (supported && Notification.permission === "granted");
    permission = desktop
      ? ""
      : !supported
        ? "Notifications need a supported browser. Open Canopy over HTTPS or localhost."
        : Notification.permission === "denied"
          ? blocked
          : "";
  }

  onMount(() => {
    refresh();
    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  });

  async function change(key: Key, value: string) {
    error = undefined;
    notice = undefined;

    if (value === "off") {
      device.set(key, value);

      return;
    }

    try {
      if (value === "sound") await enableNotificationSound();
      const result = desktop ? "granted" : supported ? await Notification.requestPermission() : "denied";
      refresh();

      if (result !== "granted") {
        // Keep the choice off, and say why: a dismissed prompt leaves no browser state to show.
        if (!permission)
          notice = {
            key,
            text:
              result === "denied"
                ? blocked
                : "Notifications stay off until you allow them. Choose again, then select Allow.",
          };

        return;
      }

      device.set(key, value);
    } catch {
      error = { key, text: "Notifications could not be enabled. Check your browser or system notification settings." };
    }
  }
</script>

<SettingsGroup title="Notifications" description="This device · Only while a Canopy window is open.">
  {#each rows as row (row.key)}
    {@const value = device.values[row.key]}
    {@const warning = (permissionRow === row.key && permission) || (notice?.key === row.key && notice.text)}
    <PreferenceRow
      title={row.title}
      description={row.description}
      changed={value !== "off"}
      onreset={() => device.set(row.key, "off")}
    >
      <div class="mt-2 grid gap-2 empty:hidden">
        {#if warning}<Alert tone="warning">{warning}</Alert>{/if}
        {#if error?.key === row.key}<Alert tone="error">{error.text}</Alert>{/if}
        {#if !desktop && value === "sound"}
          <p class="text-sm/5 text-zinc-500">After reloading, click or press a key to enable sound.</p>
        {/if}
        {#if !desktop && supported && !granted && permissionRow === row.key}
          <div>
            <Button size="sm" onclick={() => change(row.key, value)}>Enable notifications</Button>
          </div>
        {/if}
      </div>
      {#snippet control()}<div class="w-56 max-w-full">
          <Select
            aria-label={row.title}
            {options}
            {value}
            onchange={(next) => change(row.key, next)}
            disabled={!supported}
          />
        </div>{/snippet}
    </PreferenceRow>
  {/each}
  <DeviceChoiceRow
    preference="inAppNotifications"
    title="In-app notifications"
    description="Show alerts from other threads and bot chats while Canopy has focus."
    options={[
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ]}
  />
</SettingsGroup>
