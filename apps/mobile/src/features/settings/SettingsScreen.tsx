import { useState } from "react";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Notice } from "../../ui/components";
import { AppearanceSettings } from "./AppearanceSettings";
import { TurnActivitySettings } from "./TurnActivitySettings";
import { ThreadDefaultsSettings } from "./ThreadSettings";
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
  const { projects, workers } = useOverview();
  const device = useDevicePreferences();
  const [section, setSection] = useState(initialSection);

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
    </SettingsLayout>
  );
}
