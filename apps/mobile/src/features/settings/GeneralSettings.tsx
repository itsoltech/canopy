import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Text, View } from "react-native";
import { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow, SettingChoice, SettingToggle } from "./SettingsGroup";
import { DeviceChoiceRow } from "./DeviceChoiceRow";
import { useDevicePreferences } from "./device-preferences";
import { ResetSetting } from "./ResetSetting";
import { AppUpdateStatus } from "./AppUpdateStatus";

export function GeneralSettings() {
  const settings = useAppearance();
  const device = useDevicePreferences();
  const c = useColors();
  const sidebar = settings.user?.sidebar;
  const disabled = !settings.user || settings.saving;

  const saveSidebar = (patch: Partial<ui.SidebarSettings>) =>
    void settings.update({ sidebar: Object.assign(create(ui.SidebarSettingsSchema, sidebar), patch) });

  return (
    <View style={{ gap: 24 }}>
      <Text style={[styles.workMeta, { color: c.muted }]}>
        Account preferences follow your configuration group. “This device” stays here.
      </Text>
      <Button
        title="Restore device defaults"
        icon="arrow-path"
        style={{ alignSelf: "flex-start" }}
        onPress={() => device.reset(["inAppNotifications", "timeFormat"])}
      />
      <SettingsGroup title="Notifications" description="This device · Only while a Canopy window is open.">
        <SettingChoice
          title="Thread notifications"
          description="Send system alerts when threads finish, fail or need you."
          value="off"
          disabled
          options={[
            { value: "off", label: "Off" },
            { value: "notifications", label: "Notifications" },
            { value: "sound", label: "Notifications with sound" },
          ]}
          onChange={() => {}}
        />
        <SettingsRow
          title="System notifications unavailable"
          description="This mobile build does not include system notifications."
        />
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
      <SettingsGroup title="Sidebar" description="Account">
        <SettingToggle
          title="Group by project"
          description="Group sidebar threads under project headings."
          value={sidebar?.groupByProject ?? false}
          disabled={disabled}
          onChange={(groupByProject) => saveSidebar({ groupByProject })}
          accessory={
            <ResetSetting
              label="Reset group by project"
              changed={!!sidebar?.groupByProject}
              disabled={disabled}
              onReset={() => saveSidebar({ groupByProject: false })}
            />
          }
        />
        <SettingChoice
          title="Project order"
          description="Sort project groups by activity, name or creation time."
          value={sidebar?.projectOrder ?? ui.ProjectOrder.ACTIVITY}
          disabled={disabled || !sidebar?.groupByProject}
          options={[
            { value: ui.ProjectOrder.ACTIVITY, label: "Latest activity" },
            { value: ui.ProjectOrder.NAME, label: "Name" },
            { value: ui.ProjectOrder.CREATED, label: "Newest project" },
          ]}
          onChange={(projectOrder) => saveSidebar({ projectOrder })}
          accessory={
            <ResetSetting
              label="Reset project order"
              changed={(sidebar?.projectOrder ?? ui.ProjectOrder.ACTIVITY) !== ui.ProjectOrder.ACTIVITY}
              disabled={disabled}
              onReset={() => saveSidebar({ projectOrder: ui.ProjectOrder.ACTIVITY })}
            />
          }
        />
        <SettingToggle
          title="Working section"
          description="Group running and monitoring threads in a collapsible section."
          value={sidebar?.workingSection ?? false}
          disabled={disabled}
          onChange={(workingSection) => saveSidebar({ workingSection })}
          accessory={
            <ResetSetting
              label="Reset working section"
              changed={!!sidebar?.workingSection}
              disabled={disabled}
              onReset={() => saveSidebar({ workingSection: false })}
            />
          }
        />
      </SettingsGroup>
      <ConfirmationSettings />
      <DisplaySettings />
      <AppUpdateStatus />
    </View>
  );
}

function DisplaySettings() {
  const settings = useAppearance();
  const c = useColors();

  return (
    <SettingsGroup title="Display" description="This device unless marked Account">
      <DeviceChoiceRow
        preference="timeFormat"
        title="Time format"
        description="Set how timestamps show hours."
        options={[
          { value: "system", label: "System" },
          { value: "12h", label: "12-hour" },
          { value: "24h", label: "24-hour" },
        ]}
      />
      <SettingsRow title="Time zone" description="Bots and scheduled tasks use the time zone reported by this device.">
        <Text style={[styles.chrome, { color: c.text }]}>Account · {settings.user?.timezone || "UTC"}</Text>
      </SettingsRow>
    </SettingsGroup>
  );
}

function ConfirmationSettings() {
  const settings = useAppearance();
  const general = settings.user?.general;
  const disabled = !settings.user || settings.saving;

  return (
    <SettingsGroup title="Confirmations" description="Account">
      {(
        [
          {
            key: "confirmUnpin",
            title: "Confirm unpin",
            description: "Ask before removing a thread from Pinned.",
            fallback: false,
          },
          {
            key: "confirmArchive",
            title: "Confirm archive",
            description: "Ask before archiving a thread and its side threads.",
            fallback: false,
          },
          {
            key: "confirmDelete",
            title: "Confirm delete",
            description: "Ask before deleting a thread and its side threads.",
            fallback: true,
          },
        ] as const
      ).map((field) => (
        <SettingToggle
          key={field.key}
          title={field.title}
          description={field.description}
          value={general?.[field.key] ?? field.fallback}
          disabled={disabled}
          accessory={
            <ResetSetting
              label={`Reset ${field.title.toLowerCase()}`}
              changed={(general?.[field.key] ?? field.fallback) !== field.fallback}
              disabled={disabled}
              onReset={() =>
                void settings.update({
                  general: Object.assign(create(ui.GeneralSettingsSchema, general), { [field.key]: field.fallback }),
                })
              }
            />
          }
          onChange={(value) =>
            void settings.update({
              general: Object.assign(create(ui.GeneralSettingsSchema, general), { [field.key]: value }),
            })
          }
        />
      ))}
    </SettingsGroup>
  );
}
