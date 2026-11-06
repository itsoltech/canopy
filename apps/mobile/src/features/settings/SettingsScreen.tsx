import { useEffect, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { settingsSections } from "@canopy/ui/settings";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button, IconButton, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { PanelRow } from "../threads/ThreadPanel";
import { ThreadDefaultsSettings, ThreadTitleSettings } from "./ThreadSettings";
import { TurnActivitySettings } from "./TurnActivitySettings";

function useSettingsState() {
  const { session, client, forget } = useSession();
  const { projects, workers } = useOverview();
  const settings = useAppearance();
  const params = useLocalSearchParams<{ section?: string }>();
  const [section, setSection] = useState(params.section ?? "appearance");
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
          : section === "connectors"
            ? client.api.listConnectors({}).then((r) =>
                r.accounts.map((p) => ({
                  title: p.name || p.id,
                  value: p.status,
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

  if (!state.session) return <Redirect href="/pair" />;

  return (
    <SettingsLayout state={state}>
      <SettingsContent state={state} />
    </SettingsLayout>
  );
}

function SettingsLayout({ state, children }: { state: ReturnType<typeof useSettingsState>; children: ReactNode }) {
  const c = useColors();
  const { section, setRows, setError, setSection, current, settings, error } = state;

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.background }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: c.line }}
        contentContainerStyle={{ gap: 4, padding: 12 }}
      >
        {settingsSections.map((s) => {
          const key = s.href.split("/").pop()!;

          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: section === key }}
              onPress={() => {
                setRows([]);
                setError("");
                setSection(key);
              }}
              style={[
                styles.row,
                {
                  minHeight: 44,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderRadius: 8,
                  backgroundColor: section === key ? c.inset : "transparent",
                },
              ]}
            >
              <Icon name={s.icon} color={section === key ? c.text : c.muted} />
              <Text style={[styles.meta, { color: section === key ? c.text : c.muted }]}>{s.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View
        style={[
          styles.row,
          {
            minHeight: 48,
            paddingLeft: 20,
            paddingRight: 4,
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          },
        ]}
      >
        <Text style={[styles.meta, { color: c.muted }]}>Settings</Text>
        <Text style={[styles.meta, { color: c.faint }]}>/</Text>
        <Text style={[styles.meta, { color: c.text, flex: 1 }]}>{current.label}</Text>
        <IconButton
          icon="x-mark"
          label="Close Settings"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
      </View>
      <ScrollView
        key={section}
        contentContainerStyle={[styles.page, { padding: 20, paddingTop: 28, gap: 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        {settings.error || error ? <Notice error>{error || settings.error}</Notice> : null}
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

function SettingsContent({ state }: { state: ReturnType<typeof useSettingsState> }) {
  const c = useColors();

  const {
    section,
    settings,
    projects,
    workers,
    rows,
    current,
    error,
    session,
    busy,
    unpair,
    removeLocal,
    instructions,
    setInstructions,
  } = state;

  return (
    <>
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
      {["schedules", "providers", "connectors"].includes(section) && (
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
      {section === "mobile" && (
        <View style={{ gap: 20 }}>
          <PanelRow title="Gateway" value={session!.gatewayUrl} icon="link" />
          <PanelRow title="Device name" value={session!.deviceName} icon="computer-desktop" />
          <Text style={[styles.meta, { color: c.muted }]}>
            To change gateway or device name, unpair and pair again.
          </Text>
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
      )}
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
