import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { UpdateInfoType, type UpdateInfo } from "expo-updates";
import { isString } from "@canopy/domain/json";
import { fetchReleaseNotes, type NoteEntry } from "@canopy/domain/release/notes";
import { releaseChannel } from "@canopy/domain/release/version";
import { Button } from "../../ui/components";
import { WhatsNewEntries } from "./WhatsNewEntries";
import { styles, useColors } from "../../ui/theme";
import { SettingsDisclosure } from "../settings/SettingsDisclosure";

/** The OTA manifest carries the JS release version, independent of the installed native binary. */
export function phoneReleaseVersion(update?: UpdateInfo) {
  if (update?.type !== UpdateInfoType.NEW || !("extra" in update.manifest)) return undefined;
  const value = update.manifest.extra?.expoClient?.extra?.canopyVersion;

  return isString(value) && releaseChannel(value) !== "development" ? value : undefined;
}

export function PhoneReleaseNotes({ version, channel }: { version?: string; channel: string }) {
  return (
    <SettingsDisclosure title={`Read release notes · ${channel}`}>
      <ReleaseBody key={version ?? "unknown"} version={version} />
    </SettingsDisclosure>
  );
}

/** Structured Pages notes for this exact OTA; never substitute a newer channel release. */
function ReleaseBody({ version }: { version?: string }) {
  const c = useColors();
  const [entries, setEntries] = useState<readonly NoteEntry[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const published = version && releaseChannel(version) !== "development";
  useEffect(() => {
    if (!published) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => controller.abort(), 20_000);
    void fetchReleaseNotes()
      .then((index) => {
        const release = index.releases.find((item) => item.version === version);

        if (!release) throw new Error("Release not published");

        if (!cancelled && !controller.signal.aborted) {
          setEntries(release.entries);
          setError("");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load release notes. Retry, or view releases on GitHub.");
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [version, published, attempt]);

  return (
    <View style={{ gap: 8 }}>
      {published && <Text style={[styles.label, { color: c.text }]}>{version}</Text>}
      {entries ? (
        <WhatsNewEntries entries={entries} />
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>
          {error || (!published ? "Release notes are unavailable for this update." : "Loading release notes…")}
        </Text>
      )}
      {error && (
        <Button
          title="Retry release notes"
          size="sm"
          onPress={() => {
            setError("");
            setAttempt((n) => n + 1);
          }}
        />
      )}
      <Button
        title="View releases on GitHub"
        size="sm"
        variant="ghost"
        onPress={() => {
          void Linking.openURL(
            published
              ? `https://github.com/itsoltech/canopy/releases/tag/v${encodeURIComponent(version)}`
              : "https://github.com/itsoltech/canopy/releases",
          ).catch(() => setError("Could not open GitHub. Check your connection and retry."));
        }}
      />
    </View>
  );
}
