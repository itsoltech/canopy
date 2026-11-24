<script lang="ts">
  import { onMount } from "svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { useSettings } from "./settings-state.svelte.ts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
  import { devicePreferences as device } from "./device-preferences.svelte.ts";
  import { enableNotificationSound } from "#lib/features/notifications/notification-sound.ts";

  type Key = "threadNotifications" | "botNotifications";

  let permission = $state<NotificationPermission | "unavailable" | "unsupported">();
  let desktop = $state(false);
  let macOS = $state(false);
  let pending = $state<{ key: Key; value: string }>();
  let attempted = $state<Key>();
  let permissionRead = 0;

  const options = [
    { value: "off", label: "Off" },
    { value: "notifications", label: "Notifications" },
    { value: "sound", label: "Notifications with sound" },
  ];

  const settings = useSettings();

  const choices = [
    {
      key: "threadNotifications",
      module: "threads",
      title: "Thread notifications",
      description: "Send system alerts when threads finish, fail, stop or need you.",
    },
    {
      key: "botNotifications",
      module: "bots",
      title: "Bot notifications",
      description: "Send system alerts when bots message you or need your approval or answer.",
    },
  ] as const;

  const rows = $derived(choices.filter((choice) => settings.moduleEnabled(choice.module)));

  const permissionRow = $derived(rows.find((row) => device.values[row.key] !== "off")?.key);

  const warningRow = $derived(
    attempted ?? permissionRow ?? (macOS && permission === "denied" ? rows[0]?.key : undefined),
  );

  const canRetry = $derived(
    permission === "default" || permission === "unavailable" || (permission === "denied" && !desktop),
  );

  const warning = $derived.by(() => {
    if (permission === "unsupported") return "Open Canopy over HTTPS or localhost to use browser notifications.";

    if (permission === "denied")
      return macOS
        ? "macOS blocks system notifications. In System Settings → Notifications, select Canopy and turn on Allow notifications."
        : "Your browser blocks these alerts. Allow notifications for Canopy in site settings.";

    if (permission === "default" && attempted && !permissionRow)
      return "Choose a notification option again, then select Allow.";

    if (permission === "unavailable" && attempted)
      return "Canopy couldn’t enable notifications. Choose a notification option to try again.";

    return "";
  });

  async function refresh() {
    if (pending) return;
    const read = ++permissionRead;
    const native = window.canopyDesktop?.notificationPermission;

    const status = native
      ? await native.status().catch(() => "unavailable" as const)
      : desktop
        ? "granted"
        : window.isSecureContext && "Notification" in window
          ? Notification.permission
          : "unsupported";

    if (read === permissionRead) permission = status;
  }

  onMount(() => {
    desktop = Boolean(window.canopyDesktop?.showNotification);
    macOS = Boolean(window.canopyDesktop?.notificationPermission);
    void refresh();
    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  });

  async function change(key: Key, value: string) {
    if (pending) return;
    attempted = undefined;

    if (value === "off") {
      device.set(key, value);

      return;
    }

    pending = { key, value };
    permissionRead++;

    try {
      if (value === "sound") void enableNotificationSound().catch(() => undefined);
      const native = window.canopyDesktop?.notificationPermission;
      permission = await (native ? native.request() : desktop ? "granted" : Notification.requestPermission());

      if (permission === "granted") device.set(key, value);
      else attempted = key;
    } catch {
      permission = "unavailable";
      attempted = key;
    } finally {
      pending = undefined;
    }
  }
</script>

<SettingsGroup title="Notifications" description="This device · Only while a Canopy window is open.">
  {#each rows as row (row.key)}
    {@const value = device.values[row.key]}
    <PreferenceRow
      title={row.title}
      description={row.description}
      changed={value !== "off"}
      onreset={() => change(row.key, "off")}
    >
      <div class="mt-2 grid gap-2 empty:hidden">
        {#if warningRow === row.key && warning}
          <Alert tone={permission === "unavailable" ? "error" : "warning"}>{warning}</Alert>
        {/if}
        {#if !desktop && value === "sound"}
          <p class="text-sm/5 text-zinc-500">After reloading, click or press a key to enable sound.</p>
        {/if}
        {#if permissionRow === row.key && canRetry}
          <div>
            <Button size="sm" disabled={Boolean(pending)} onclick={() => change(row.key, value)}
              >Enable notifications</Button
            >
          </div>
        {/if}
      </div>
      {#snippet control()}<div class="w-56 max-w-full">
          <Select
            aria-label={row.title}
            {options}
            value={pending?.key === row.key ? pending.value : value}
            onchange={(next) => change(row.key, next)}
            disabled={permission === "unsupported" || Boolean(pending)}
          />
        </div>{/snippet}
    </PreferenceRow>
  {/each}
  <DeviceChoiceRow
    preference="inAppNotifications"
    title="In-app notifications"
    description="Show alerts while Canopy has focus."
    options={[
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ]}
  />
</SettingsGroup>
