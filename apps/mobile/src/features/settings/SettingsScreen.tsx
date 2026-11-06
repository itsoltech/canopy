import { useState } from "react";
import { Text, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { PanelRow } from "../threads/ThreadPanel";
import { ThreadDefaultsSettings, ThreadTitleSettings } from "./ThreadSettings";
import { TurnActivitySettings } from "./TurnActivitySettings";
import { SettingsLayout } from "./SettingsLayout";
import { GeneralSettings } from "./GeneralSettings";
import { KeybindingSettings } from "./KeybindingSettings";
import { DiffSettings } from "./DiffSettings";
import { NetworkSettings } from "./NetworkSettings";
import { DeviceSettings } from "./DeviceSettings";
import { WorkerSettings } from "./WorkerSettings";
import { useDevicePreferences } from "./device-preferences";

export default function SettingsScreen() {
  const { session } = useSession();
  const settings = useAppearance();
  const { projects, workers } = useOverview();
  const device = useDevicePreferences();
  const params = useLocalSearchParams<{ section?: string }>();
  const [section, setSection] = useState(params.section ?? "");
  const [draftInstructions, setInstructions] = useState<string>();
  const instructions = draftInstructions ?? settings.user?.textGeneration?.threadTitleInstructions ?? "";

  if (!session) return <Redirect href="/pair" />;

  return (
    <SettingsLayout section={section} onSelect={setSection}>
      {device.error ? <Notice error>{device.error}</Notice> : null}
      {settings.error ? <Notice error>{settings.error}</Notice> : null}
      {!settings.user && !settings.error ? <Notice>Loading settings…</Notice> : null}
      {section === "general" && <GeneralSettings />}
      {section === "keybindings" && <KeybindingSettings />}
      {section === "diffs" && <DiffSettings />}
      {section === "appearance" && <AppearanceSettings />}
      {section === "threads" && (
        <>
          <ThreadDefaultsSettings settings={settings} projects={projects} workers={workers} />
          <TurnActivitySettings />
        </>
      )}
      {section === "text-generation" && (
        <ThreadTitleSettings settings={settings} instructions={instructions} onChange={setInstructions} />
      )}
      {section === "network" && <NetworkSettings />}
      {section === "mobile" && <DeviceSettings />}
      {section === "workers" && <WorkerSettings />}
      {[
        "projects",
        "schedules",
        "providers",
        "connectors",
        "proxies",
        "agent-environment",
        "worktrees",
        "computers",
      ].includes(section) && <RemainingSettings section={section} />}
    </SettingsLayout>
  );
}

function RemainingSettings({ section }: { section: string }) {
  const { projects, workers } = useOverview();
  const c = useColors();

  return (
    <View>
      {section === "projects" &&
        projects
          .filter((p) => p.kind !== "scratch")
          .map((p) => (
            <PanelRow
              key={p.id}
              title={p.name}
              value={p.workspaces.map((w) => w.rootPath).join("\n") || "No workspaces"}
              icon="folder"
            />
          ))}
      {section === "workers" &&
        workers.map((w) => (
          <PanelRow
            key={w.id}
            title={w.name}
            value={`${w.online ? "Online" : "Offline"} · ${w.hostname} · ${w.os}`}
            icon="server"
          />
        ))}
      <Text style={[styles.meta, { color: c.muted, paddingVertical: 16 }]}>
        Manage {section.replaceAll("-", " ")} in Canopy on the web.
      </Text>
    </View>
  );
}
