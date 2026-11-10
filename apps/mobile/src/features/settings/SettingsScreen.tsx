import { View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useSession } from "../../state/session";
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
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { KeybindingSettings } from "./KeybindingSettings";
import { DiffSettings } from "./DiffSettings";
import { NetworkSettings } from "./NetworkSettings";
import { DeviceSettings } from "./DeviceSettings";
import { WorkerSettings } from "./WorkerSettings";
import { ComputerSettings } from "./ComputerSettings";
import { ThreadSyncDiagnostics } from "./ThreadSyncDiagnostics";
import { ProxySettings } from "./ProxySettings";
import { ConnectorSettings } from "./ConnectorSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ProviderSettings } from "./ProviderSettings";
import { AgentEnvironmentSettings } from "./AgentEnvironmentSettings";
import { ImportSettings } from "./ImportSettings";
import { useDevicePreferences } from "./device-preferences";
import { useLayout } from "../../state/layout";
import { AppUpdateStatus } from "./AppUpdateStatus";
import { WhatsNewSettings } from "../updates/WhatsNew";

export default function SettingsScreen() {
  const { section: selectedSection = "" } = useLocalSearchParams<{ section?: string }>();
  const { session } = useSession();
  const settings = useAppearance();
  const device = useDevicePreferences();
  const { wide } = useLayout();
  const section = selectedSection || (wide ? "general" : "");

  function selectSection(next: string) {
    if (!next) router.back();
    else if (selectedSection) router.replace({ pathname: "/settings/[section]", params: { section: next } });
    else router.push({ pathname: "/settings/[section]", params: { section: next } });
  }

  if (!session) return <Redirect href="/pair" />;

  return (
    <SettingsLayout section={section} onSelect={selectSection}>
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
        {section === "app-updates" && (
          <>
            <AppUpdateStatus />
            <WhatsNewSettings />
          </>
        )}
        {section === "diagnostics" && <DiagnosticsSettings />}
        {section === "keybindings" && <KeybindingSettings />}
        {section === "diffs" && <DiffSettings />}
        {section === "appearance" && <AppearanceSettings />}
        {section === "threads" && (
          <>
            <ThreadDisplaySettings />
            <TurnActivitySettings />
            <ThreadDefaultsSettings settings={settings} />
          </>
        )}
        {section === "text-generation" && <TextGenerationSettings />}
        {section === "network" && <NetworkSettings />}
        {section === "mobile" && <DeviceSettings />}
        {section === "workers" && <WorkerSettings />}
        {section === "computers" && <ComputerSettings />}
        {section === "diagnostics" && <ThreadSyncDiagnostics />}
        {section === "proxies" && <ProxySettings />}
        {section === "connectors" && <ConnectorSettings />}
        {section === "github" && <GitHubSettings />}
        {section === "providers" && <ProviderSettings />}
        {section === "agent-environment" && <AgentEnvironmentSettings />}
        {section === "import" && <ImportSettings />}
        {section === "projects" && <ProjectSettings />}
        {section === "schedules" && <ScheduleSettings />}
        {section === "worktrees" && <WorktreeSettings />}
      </SkeletonScope>
    </SettingsLayout>
  );
}
