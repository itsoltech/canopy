import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { accents } from "@canopy/ui";
import { useSession } from "./session";
import { useStream } from "./stream";

function useAppearanceState() {
  const { client, session } = useSession();
  const system = useColorScheme();
  const [user, setUser] = useState<ui.UserSettings>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;

    if (client)
      void client.api
        .getSettings({})
        .then((r) => {
          if (active) {
            setUser(r.user);
            setError("");
          }
        })
        .catch(() => {
          if (active) setError("Could not load settings.");
        });

    return () => {
      active = false;
    };
  }, [client]);
  useStream(
    client ? (signal) => client.api.watchOverview({ includeSnapshot: true }, { signal }) : null,
    (update: ui.OverviewUpdate) => {
      if (update.change.case === "userSettings") setUser(update.change.value);

      if (update.change.case === "mobileSnapshot")
        void client?.api
          .getSettings({})
          .then((r) => {
            setUser(r.user);
            setError("");
          })
          .catch(() => setError("Could not load settings."));
    },
    `appearance:${session?.deviceId}`,
  );
  const appearance = user?.appearance;

  const dark =
    appearance?.colorScheme === ui.ColorScheme.DARK ||
    ((!appearance?.colorScheme || appearance.colorScheme === ui.ColorScheme.SYSTEM) && system === "dark");

  return {
    user,
    appearance,
    dark,
    accent: accents[Math.max(0, (appearance?.accent ?? 1) - 1)]?.name ?? "default",
    error,
    saving,
    async update(patch: Partial<ui.UpdateUserSettingsRequest>) {
      if (!client || !user || saving) return;
      setSaving(true);
      setError("");

      try {
        const result = await client.api.updateUserSettings({
          ...patch,
          expectedVersion: user.version,
        });

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
  return <Context.Provider value={useAppearanceState()}>{children}</Context.Provider>;
}

export function useAppearance() {
  const state = useContext(Context);

  if (!state) throw new Error("Missing AppearanceProvider");

  return state;
}
