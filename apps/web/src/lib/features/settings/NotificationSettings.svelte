<script lang="ts">
  import { onMount } from "svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import PreferenceRow from "./PreferenceRow.svelte";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
  import { devicePreferences as device } from "./device-preferences.svelte.ts";
  import { enableNotificationSound } from "./notification-sound.ts";

  let permission = $state("");
  let granted = $state(false);
  let supported = $state(false);
  let desktop = $state(false);
  let error = $state("");
  let notice = $state("");

  const options = [
    { value: "off", label: "Off" },
    { value: "notifications", label: "Notifications" },
    { value: "sound", label: "Notifications with sound" },
  ];

  function refresh() {
    desktop = Boolean(window.canopyDesktop?.showThreadNotification);
    supported = desktop || (window.isSecureContext && "Notification" in window);
    granted = desktop || (supported && Notification.permission === "granted");
    permission = desktop
      ? ""
      : !supported
        ? "Notifications need a supported browser. Open Canopy over HTTPS or localhost."
        : Notification.permission === "denied"
          ? "Blocked by your browser. Allow notifications in site settings, then retry."
          : "";
  }

  onMount(() => {
    refresh();
    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  });

  async function change(value: string) {
    error = "";
    notice = "";

    if (value === "off") {
      device.set("threadNotifications", value);

      return;
    }

    try {
      if (value === "sound" && !desktop) await enableNotificationSound();
      const result = desktop ? "granted" : supported ? await Notification.requestPermission() : "denied";
      refresh();

      if (result !== "granted") {
        // Keep the choice off, and say why: a dismissed prompt leaves no browser state to show.
        if (result === "default")
          notice = "Notifications stay off until you allow them. Choose again, then select Allow.";

        return;
      }

      device.set("threadNotifications", value);
    } catch {
      error = "Notifications could not be enabled. Check your browser or system notification settings.";
    }
  }
</script>

<SettingsGroup title="Notifications" description="This device · Only while a Canopy window is open.">
  <PreferenceRow
    title="Thread notifications"
    description="Send system alerts when threads finish, fail or need you."
    changed={device.values.threadNotifications !== "off"}
    onreset={() => device.set("threadNotifications", "off")}
  >
    <div class="mt-2 grid gap-2">
      {#if permission || notice}<Alert tone="warning">{permission || notice}</Alert>{/if}
      {#if error}<Alert tone="error">{error}</Alert>{/if}
      {#if !desktop && device.values.threadNotifications === "sound"}
        <p class="text-sm/5 text-zinc-500">After reloading, click or press a key to enable sound.</p>
      {/if}
      {#if !desktop && supported && !granted && device.values.threadNotifications !== "off"}
        <div>
          <Button size="sm" onclick={() => change(device.values.threadNotifications)}>Enable notifications</Button>
        </div>
      {/if}
    </div>
    {#snippet control()}<div class="w-56 max-w-full">
        <Select
          aria-label="Thread notifications"
          {options}
          value={device.values.threadNotifications}
          onchange={change}
          disabled={!supported}
        />
      </div>{/snippet}
  </PreferenceRow>
  <DeviceChoiceRow
    preference="inAppNotifications"
    title="In-app notifications"
    description="Show alerts from other threads while Canopy has focus."
    options={[
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ]}
  />
</SettingsGroup>
