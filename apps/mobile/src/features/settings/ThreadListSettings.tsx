import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { useDevicePreferences } from "./device-preferences";
import { ResetSetting } from "./ResetSetting";
import { SettingChoice, SettingsGroup, SettingToggle } from "./SettingsGroup";

export function ThreadListSettings() {
  const settings = useAppearance();
  const device = useDevicePreferences();
  const sidebar = settings.sidebar;
  const disabled = !device.viewLoaded;
  const groupBy = !sidebar?.groupByProject ? "none" : device.view.groupByWorktree ? "project-worktree" : "project";

  const saveSidebar = settings.updateSidebar;

  function setGrouping(value: string) {
    device.setView({ groupByProject: value !== "none", groupByWorktree: value === "project-worktree" });
  }

  return (
    <SettingsGroup title="Sidebar" description="This device">
      <SettingChoice
        title="Group by"
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
      <SettingChoice
        title="Working section position"
        value={device.view.workingSectionPosition}
        options={[
          { value: "top", label: "Top" },
          { value: "bottom", label: "Bottom" },
        ]}
        disabled={disabled || !sidebar?.workingSection}
        onChange={(workingSectionPosition) => device.setView({ workingSectionPosition })}
        accessory={
          <ResetSetting
            label="Reset working section position"
            changed={device.view.workingSectionPosition !== "bottom"}
            disabled={disabled}
            onReset={() => device.setView({ workingSectionPosition: "bottom" })}
          />
        }
      />
    </SettingsGroup>
  );
}

export function ConfirmationSettings() {
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
