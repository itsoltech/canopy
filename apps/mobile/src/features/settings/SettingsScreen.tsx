import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { settingsSections } from "@canopy/ui/settings";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { PanelRow } from "../threads/ThreadPanel";
import { ThreadDefaultsSettings, ThreadTitleSettings } from "./ThreadSettings";
import { TurnActivitySettings } from "./TurnActivitySettings";
import { ConnectorList, useConnectors } from "../connectors/Connectors";
import { SettingsLayout } from "./SettingsLayout";
import { GeneralSettings } from "./GeneralSettings";
import { KeybindingSettings } from "./KeybindingSettings";
import { DiffSettings } from "./DiffSettings";
import { useDevicePreferences } from "./device-preferences";

function useSettingsState() {
  const { session, client, forget } = useSession();
  const { projects, workers } = useOverview();
  const settings = useAppearance();
  const params = useLocalSearchParams<{ section?: string }>();
  const [section, setSection] = useState(params.section ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<{ title: string; value: string }[]>([]);
  const [draftInstructions, setInstructions] = useState<string>();
  const instructions = draftInstructions ?? settings.user?.textGeneration?.threadTitleInstructions ?? "";
  useEffect(() => {
    let active = true;

    if (!client) return;

    const request =
      section === "schedules"
        ? client.api.listSchedules({}).then((r) =>
            r.schedules.map((s) => ({
              title: s.name,
              value: `${s.status} · ${s.cron || "One time"}`,
            })),
          )
        : section === "providers"
          ? client.api.listProviderInstances({}).then((r) =>
              r.instances.map((p) => ({
                title: p.label || p.id,
                value: `${p.workers.filter((w) => w.enabled).length} workers`,
              })),
            )
          : null;

    if (request)
      void request
        .then((r) => {
          if (active) setRows(r);
        })
        .catch(() => {
          if (active) setError("Could not load this section. Try again.");
        });

    return () => {
      active = false;
    };
  }, [section, client]);

  const current = settingsSections.find((s) => s.href.endsWith(`/${section}`)) ?? settingsSections[0]!;

  async function removeLocal() {
    try {
      await forget();
      router.replace("/pair");
    } catch {
      setError("Could not remove the pairing from secure storage. Try again.");
    }
  }

  async function unpair() {
    setBusy(true);
    setError("");

    try {
      await client!.api.unpairMobileDevice({}, { timeoutMs: 10_000 });
      await removeLocal();
    } catch {
      setError("Could not revoke access on the gateway. Reconnect and retry, or revoke this phone in web Settings.");
    } finally {
      setBusy(false);
    }
  }

  return {
    session,
    projects,
    workers,
    settings,
    section,
    setSection,
    busy,
    error,
    setError,
    rows,
    setRows,
    instructions,
    setInstructions,
    current,
    removeLocal,
    unpair,
  };
}

export default function SettingsScreen() {
  const state = useSettingsState();
  const device = useDevicePreferences();

  if (!state.session) return <Redirect href="/pair" />;

  return (
    <SettingsLayout section={state.section} onSelect={state.setSection}>
      {device.error ? <Notice error>{device.error}</Notice> : null}
      {state.error || state.settings.error ? <Notice error>{state.error || state.settings.error}</Notice> : null}
      {!state.settings.user && !state.settings.error ? <Notice>Loading settings…</Notice> : null}
      <SettingsContent state={state} />
    </SettingsLayout>
  );
}

function SettingsContent({ state }: { state: ReturnType<typeof useSettingsState> }) {
  const c = useColors();

  const { section, settings, projects, workers, rows, current, error, instructions, setInstructions } = state;

  return (
    <>
      {section === "general" && <GeneralSettings />}
      {section === "keybindings" && <KeybindingSettings />}
      {section === "diffs" && <DiffSettings />}
      {section === "appearance" && <AppearanceSettings />}
      {section === "threads" && <ThreadsSection settings={settings} projects={projects} workers={workers} />}
      {section === "text-generation" && (
        <ThreadTitleSettings settings={settings} instructions={instructions} onChange={setInstructions} />
      )}
      {section === "projects" && (
        <View>
          {projects
            .filter((p) => p.kind !== "scratch")
            .map((p) => (
              <PanelRow
                key={p.id}
                title={p.name}
                value={p.workspaces.map((w) => w.rootPath).join("\n") || "No workspaces"}
                icon="folder"
              />
            ))}
          <Text style={[styles.meta, { color: c.muted, paddingVertical: 16 }]}>
            Manage projects in Canopy on the web.
          </Text>
        </View>
      )}
      {section === "workers" && (
        <View>
          {workers.map((w) => (
            <PanelRow
              key={w.id}
              title={w.name}
              value={`${w.online ? "Online" : "Offline"} · ${w.hostname} · ${w.os}`}
              icon="server"
            />
          ))}
          <Text style={[styles.meta, { color: c.muted, paddingVertical: 16 }]}>
            Manage workers in Canopy on the web.
          </Text>
        </View>
      )}
      {section === "connectors" && <ConnectorsSection />}
      {["schedules", "providers"].includes(section) && (
        <View style={{ gap: 16 }}>
          {rows.length ? (
            rows.map((r, i) => <PanelRow key={i} title={r.title} value={r.value} icon={current.icon} />)
          ) : (
            <Text style={[styles.body, { color: c.muted }]}>{error ? "" : `No ${current.label.toLowerCase()}.`}</Text>
          )}
          <Text style={[styles.meta, { color: c.muted }]}>
            Manage {current.label.toLowerCase()} in Canopy on the web.
          </Text>
        </View>
      )}
      {["network", "computers"].includes(section) && (
        <Text style={[styles.meta, { color: c.muted }]}>
          Manage {current.label.toLowerCase()} in Canopy on the web.
        </Text>
      )}
      {section === "mobile" && <CurrentDeviceSettings state={state} />}
    </>
  );
}

function ThreadsSection(props: Parameters<typeof ThreadDefaultsSettings>[0]) {
  return (
    <View style={{ gap: 32 }}>
      <ThreadDefaultsSettings {...props} />
      <TurnActivitySettings />
    </View>
  );
}

function ConnectorsSection() {
  const c = useColors();
  const { list, error } = useConnectors();

  return (
    <View style={{ gap: 16 }}>
      {list?.accounts.length ? (
        <ConnectorList list={list} />
      ) : (
        <Text style={[styles.body, { color: c.muted }]}>{error || (list ? "No connectors." : "")}</Text>
      )}
      <Text style={[styles.meta, { color: c.muted }]}>Manage connectors in Canopy on the web.</Text>
    </View>
  );
}

function CurrentDeviceSettings({ state }: { state: ReturnType<typeof useSettingsState> }) {
  const c = useColors();
  const { session, busy, error, unpair, removeLocal } = state;

  return (
    <View style={{ gap: 20 }}>
      <PanelRow title="Gateway" value={session!.gatewayUrl} icon="link" />
      <PanelRow title="Device name" value={session!.deviceName} icon="computer-desktop" />
      <Text style={[styles.meta, { color: c.muted }]}>To change gateway or device name, unpair and pair again.</Text>
      <Button
        title="Unpair this phone"
        danger
        busy={busy}
        onPress={() =>
          Alert.alert("Unpair this phone?", "This revokes access on the gateway and removes the saved key.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Unpair",
              style: "destructive",
              onPress: () => void unpair(),
            },
          ])
        }
      />
      {error ? (
        <Button
          title="Forget pairing locally"
          secondary
          onPress={() =>
            Alert.alert(
              "Forget this pairing?",
              "This removes the local key only. Revoke this phone in web Settings to end its gateway access.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Forget",
                  style: "destructive",
                  onPress: () => void removeLocal(),
                },
              ],
            )
          }
        />
      ) : null}
    </View>
  );
}
