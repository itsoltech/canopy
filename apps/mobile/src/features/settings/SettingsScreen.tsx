import { useSectionAvailability } from "./section-catalog";
import { settingsScope } from "./navigation";
import { View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useSession } from "../../state/session";
import { useAppearance } from "../../state/appearance";
import { Button, Notice } from "../../ui/components";
import { ListSkeleton, SkeletonScope } from "../../ui/Skeleton";
import { AppearanceSettings } from "./AppearanceSettings";
import { TurnActivitySettings } from "./TurnActivitySettings";
import { ThreadDefaultsSettings } from "./ThreadSettings";
import { ThreadDisplaySettings } from "./ThreadDisplaySettings";
import { TextGenerationSettings } from "./TextGenerationSettings";
import { ProjectSettings } from "./ProjectSettings";
import { ScheduleSettings } from "./ScheduleSettings";
import { WorktreeSettings } from "./WorktreeSettings";
import { SettingsScroll } from "./SettingsScroll";
import { SettingsDensity } from "../../ui/density";
import { AgentToolsSettings } from "./AgentToolsSettings";
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
import { AppUpdatesSettings } from "./AppUpdatesSettings";
import { LicenseList } from "../licenses/LicenseList";
import { MemorySettings } from "./MemorySettings";

export default function SettingsScreen() {
  const params = useLocalSearchParams<{ section?: string }>();
  const section = params.section || "general";
  const href = `/settings/${section}`;

  const position = JSON.stringify([section, settingsScope(params)]);
  const { session } = useSession();
  const settings = useAppearance();
  const device = useDevicePreferences();
  const catalog = useSectionAvailability();

  if (!session) return <Redirect href="/pair" />;

  if (params.section === "general" || !catalog.sections.some((entry) => entry.href === href))
    return <Redirect href="/settings" />;

  if (catalog.waitingFor(href) || !catalog.available.some((entry) => entry.href === href))
    return (
      <SettingsScroll position={position}>
        {catalog.waitingFor(href) ? (
          <ListSkeleton />
        ) : catalog.error ? (
          <>
            <Notice error>Could not check available settings. Check your connection and retry.</Notice>
            <Button title="Retry" onPress={() => void catalog.retry().catch(() => {})} />
          </>
        ) : (
          <Notice>This section is unavailable on your gateway. Choose another section.</Notice>
        )}
      </SettingsScroll>
    );

  if (section === "open-source-licenses") return <LicenseList />;

  const notices = (
    <>
      {device.error ? <Notice error>{device.error}</Notice> : null}
      {settings.error && section !== "appearance" ? (
        <View style={{ gap: 8 }}>
          <Notice error>{settings.error}</Notice>
          <Button title="Retry settings" onPress={() => void settings.reload()} />
        </View>
      ) : null}
    </>
  );

  if (section === "agent-environment")
    return (
      <SettingsDensity.Provider value={true}>
        <AgentEnvironmentSettings position={position} notices={notices} />
      </SettingsDensity.Provider>
    );

  return (
    <SettingsDensity.Provider value={true}>
      <SettingsScroll
        key={position}
        position={position}
        space={16}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, minWidth: 0 }}
        contentContainerStyle={{ maxWidth: 1024, gap: 20 }}
      >
        {notices}
        <SkeletonScope
          loading={!settings.user && !settings.error && ["general", "threads", "text-generation"].includes(section)}
        >
          {section === "general" && <GeneralSettings />}
          {section === "app-updates" && <AppUpdatesSettings />}
          {section === "memory" && <MemorySettings key={session.deviceId} />}
          {section === "agent-tools" && <AgentToolsSettings />}
          {section === "diagnostics" && (
            <>
              <DiagnosticsSettings />
              {settings.threadsEnabled && <ThreadSyncDiagnostics />}
            </>
          )}
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
          {section === "proxies" && <ProxySettings />}
          {section === "connectors" && <ConnectorSettings />}
          {section === "github" && <GitHubSettings />}
          {section === "providers" && <ProviderSettings />}
          {section === "import" && <ImportSettings />}
          {section === "projects" && <ProjectSettings />}
          {section === "schedules" && <ScheduleSettings />}
          {section === "worktrees" && <WorktreeSettings />}
        </SkeletonScope>
      </SettingsScroll>
    </SettingsDensity.Provider>
  );
}
