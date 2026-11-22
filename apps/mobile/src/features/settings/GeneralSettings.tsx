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
import { ModuleSettings } from "./ModuleSettings";
import { AppUpdateStatus } from "./AppUpdateStatus";
import { UsagePingSettings } from "./UsagePingSettings";
import { MobilePushSettings } from "./MobilePushSettings";
import { useMobilePush } from "../notifications/PushProvider";

export function GeneralSettings() {
  const settings = useAppearance();
  const device = useDevicePreferences();
  const push = useMobilePush();
  const c = useColors();
  const sidebar = settings.sidebar;
  const disabled = !device.viewLoaded;
  const groupBy = !sidebar?.groupByProject ? "none" : device.view.groupByWorktree ? "project-worktree" : "project";

  const saveSidebar = settings.updateSidebar;

  function setGrouping(value: string) {
    device.setView({ groupByProject: value !== "none", groupByWorktree: value === "project-worktree" });
  }

  return (
    <View style={{ gap: 24 }}>
      <Text style={[styles.workMeta, { color: c.muted }]}>
        Account preferences follow your configuration group. “This device” stays here.
      </Text>
      <Button
        title="Restore device defaults"
        icon="arrow-path"
        style={{ alignSelf: "flex-start" }}
        onPress={() => {
          device.reset(["inAppNotifications", "timeFormat"]);

          if (push.state?.requested) void push.registration?.setEnabled(false);
        }}
      />
      <ModuleSettings />
      <UsagePingSettings />
      <SettingsGroup title="Notifications" description="This device">
        <MobilePushSettings />
        <DeviceChoiceRow
          preference="inAppNotifications"
          title="In-app notifications"
          description="Show alerts from other threads and chats while Canopy is open."
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </SettingsGroup>
      {settings.threadsEnabled && (
        <SettingsGroup title="Sidebar" description="This device">
          <SettingChoice
            title="Group by"
            description="Choose how threads are grouped in the sidebar."
            value={groupBy}
            options={[
              { value: "none", label: "None" },
              { value: "project", label: "Project" },
              { value: "project-worktree", label: "Project & worktree" },
            ]}
            disabled={disabled}
            onChange={setGrouping}
            accessory={
              <ResetSetting
                label="Reset group by"
                changed={groupBy !== "none"}
                disabled={disabled}
                onReset={() => setGrouping("none")}
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
      )}
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
      <SettingsRow title="Time zone" description="Use this device’s time zone for scheduled work.">
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
            description: "Ask before removing a conversation from Pinned.",
            fallback: false,
          },
          {
            key: "confirmArchive",
            title: "Confirm archive",
            description: settings.threadsEnabled
              ? "Ask before archiving a conversation, including any side threads."
              : "Ask before archiving a bot.",
            fallback: false,
          },
          {
            key: "confirmDelete",
            title: "Confirm delete",
            description: "Ask before deleting a thread and its side threads.",
            fallback: true,
          },
        ] as const
      ).map((field) =>
        field.key === "confirmDelete" && !settings.threadsEnabled ? null : (
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
        ),
      )}
    </SettingsGroup>
  );
}
