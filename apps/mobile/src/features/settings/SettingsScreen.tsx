import { useEffect, useState } from "react";
import { View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button, Notice } from "../../ui/components";
import { SkeletonScope } from "../../ui/Skeleton";
import { AppearanceSettings } from "./AppearanceSettings";
import { TurnActivitySettings } from "./TurnActivitySettings";
import { ThreadDefaultsSettings } from "./ThreadSettings";
import { ThreadDisplaySettings } from "./ThreadDisplaySettings";
import { TextGenerationSettings } from "./TextGenerationSettings";
import { ProjectSettings } from "./ProjectSettings";
import { ScheduleSettings } from "./ScheduleSettings";
import { WorktreeSettings } from "./WorktreeSettings";
import { SettingsLayout } from "./SettingsLayout";
import { GeneralSettings } from "./GeneralSettings";
import { KeybindingSettings } from "./KeybindingSettings";
import { DiffSettings } from "./DiffSettings";
import { NetworkSettings } from "./NetworkSettings";
import { DeviceSettings } from "./DeviceSettings";
import { WorkerSettings } from "./WorkerSettings";
import { ComputerSettings } from "./ComputerSettings";
import { ProxySettings } from "./ProxySettings";
import { ConnectorSettings } from "./ConnectorSettings";
import { ProviderSettings } from "./ProviderSettings";
import { AgentEnvironmentSettings } from "./AgentEnvironmentSettings";
import { useDevicePreferences } from "./device-preferences";

export default function SettingsScreen() {
  const params = useLocalSearchParams<{ section?: string }>();

  return <SettingsContent key={params.section} initialSection={params.section ?? ""} />;
}

function SettingsContent({ initialSection }: { initialSection: string }) {
  const { session } = useSession();
  const settings = useAppearance();
  const { reload: reloadSettings } = settings;
  const { projects, workers, reload } = useOverview();
  const device = useDevicePreferences();
  const [section, setSection] = useState(initialSection);

  useEffect(() => {
    void reloadSettings();
    void reload().catch(() => undefined);
  }, [section, reloadSettings, reload]);

  if (!session) return <Redirect href="/pair" />;

  return (
    <SettingsLayout section={section} onSelect={setSection}>
      {device.error ? <Notice error>{device.error}</Notice> : null}
      {settings.error ? (
        <View style={{ gap: 8 }}>
          <Notice error>{settings.error}</Notice>
          <Button title="Retry settings" onPress={() => void settings.reload()} />
        </View>
      ) : null}
      <SkeletonScope
        loading={
          !settings.user && !settings.error && ["general", "appearance", "threads", "text-generation"].includes(section)
        }
      >
        {section === "general" && <GeneralSettings />}
        {section === "keybindings" && <KeybindingSettings />}
        {section === "diffs" && <DiffSettings />}
        {section === "appearance" && <AppearanceSettings />}
        {section === "threads" && (
          <>
            <ThreadDisplaySettings />
            <TurnActivitySettings />
            <ThreadDefaultsSettings settings={settings} projects={projects} workers={workers} />
          </>
        )}
        {section === "text-generation" && <TextGenerationSettings />}
        {section === "network" && <NetworkSettings />}
        {section === "mobile" && <DeviceSettings />}
        {section === "workers" && <WorkerSettings />}
        {section === "computers" && <ComputerSettings />}
        {section === "proxies" && <ProxySettings />}
        {section === "connectors" && <ConnectorSettings />}
        {section === "providers" && <ProviderSettings />}
        {section === "agent-environment" && <AgentEnvironmentSettings />}
        {section === "projects" && <ProjectSettings />}
        {section === "schedules" && <ScheduleSettings />}
        {section === "worktrees" && <WorktreeSettings />}
      </SkeletonScope>
    </SettingsLayout>
  );
}
