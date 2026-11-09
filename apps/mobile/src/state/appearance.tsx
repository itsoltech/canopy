import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { accents } from "@canopy/ui";
import { useSession } from "./session";
import { useOverviewEvents } from "./overview-bus";
import { useDevicePreferences } from "../features/settings/device-preferences";

/** Settings versions only grow: an older read or event never replaces a newer value. */
function newer(current: ui.UserSettings | undefined, next: ui.UserSettings | undefined) {
  return current && next && next.version < current.version ? current : next;
}

function useAppearanceState() {
  const { client } = useSession();
  const system = useColorScheme();
  const [user, setUser] = useState<ui.UserSettings>();
  const [projects, setProjects] = useState<ui.ProjectSettings[]>([]);
  const [limits, setLimits] = useState<ui.AttachmentLimits>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const requests = useRef(0);

  const loaded = useCallback((r: ui.GetSettingsResponse) => {
    requests.current++;
    setUser((current) => newer(current, r.user));
    setProjects(r.projects);
    setLimits(r.attachmentLimits);
    setError("");
  }, []);

  const reload = useCallback(async () => {
    if (!client) return;
    const version = requests.current;

    try {
      const response = await client.api.getSettings({});

      if (requests.current === version) loaded(response);
    } catch {
      if (requests.current === version) setError("Could not load settings. Check the connection and retry.");
    }
  }, [client, loaded]);

  useEffect(() => {
    let active = true;
    const version = requests.current;

    if (client)
      void client.api
        .getSettings({})
        .then((r) => {
          if (active && requests.current === version) loaded(r);
        })
        .catch(() => {
          if (active && requests.current === version)
            setError("Could not load settings. Check the connection and retry.");
        });

    return () => {
      active = false;
    };
  }, [client, loaded]);
  useOverviewEvents((update: ui.OverviewUpdate) => {
    const change = update.change;

    if (change.case === "userSettings") {
      requests.current++;
      setUser((current) => newer(current, change.value));
    }

    if (change.case === "projectSettings")
      setProjects((rows) => [...rows.filter((r) => r.projectId !== change.value.projectId), change.value]);

    if (change.case !== "mobileSnapshot") return;

    // The snapshot carries settings read after the subscription began: nothing changed in between is missed.
    // An older gateway sends none, so read them once after its snapshot.
    if (change.value.settings) loaded(change.value.settings);
    else void reload();
  });
  const appearance = user?.appearance;
  const device = useDevicePreferences();

  useEffect(() => {
    if (!user || !device.viewLoaded) return;
    device.initializeView({
      archivedThreadsExpanded: user.sidebar?.archivedExpanded ?? false,
      sidebarCollapsed: user.appearance?.sidebarCollapsed ?? false,
      threadPanelCollapsed: user.appearance?.threadPanelCollapsed ?? false,
      sidebarWidth: user.appearance?.sidebarWidth ?? 0,
    });
  }, [user, device]);

  const dark =
    appearance?.colorScheme === ui.ColorScheme.DARK ||
    ((!appearance?.colorScheme || appearance.colorScheme === ui.ColorScheme.SYSTEM) && system === "dark");

  return {
    user,
    limits,
    /** A project's thread defaults (Settings → Projects), if it has its own. */
    projectDefaults: (projectId: string) => projects.find((p) => p.projectId === projectId)?.threadDefaults,
    appearance,
    dark,
    accent: accents[Math.max(0, (appearance?.accent ?? 1) - 1)]?.name ?? "default",
    error,
    saving,
    reload,
    async update(patch: Partial<ui.UpdateUserSettingsRequest>) {
      if (!client || !user || saving) return;
      requests.current++;
      setSaving(true);
      setError("");

      try {
        const result = await client.api.updateUserSettings({
          ...patch,
          expectedVersion: user.version,
        });

        requests.current++;
        setUser(result.settings);
      } catch {
        setError("Could not save settings. Settings were refreshed; please try again.");
        void client.api
          .getSettings({})
          .then((r) => setUser(r.user))
          .catch(() => undefined);
      } finally {
        setSaving(false);
      }
    },
    updateAppearance(patch: Partial<ui.AppearanceSettings>) {
      return this.update({
        appearance: Object.assign(create(ui.AppearanceSettingsSchema, appearance), patch),
      });
    },
  };
}

const Context = createContext<ReturnType<typeof useAppearanceState> | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();

  return <AppearanceSession key={session?.deviceId}>{children}</AppearanceSession>;
}

function AppearanceSession({ children }: { children: ReactNode }) {
  return <Context.Provider value={useAppearanceState()}>{children}</Context.Provider>;
}

export function useAppearance() {
  const state = useContext(Context);

  if (!state) throw new Error("Missing AppearanceProvider");

  return state;
}
