import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import * as Updates from "expo-updates";
import { isString, parseObject, str } from "@canopy/domain/json";
import { releaseChannel } from "@canopy/domain/release/version";
import { Button } from "../../ui/components";
import { Markdown } from "../../ui/markdown";
import { styles, useColors } from "../../ui/theme";
import { SettingsDisclosure } from "../settings/SettingsDisclosure";

/** The OTA manifest carries the JS release version, independent of the installed native binary. */
export function phoneReleaseVersion(update?: Updates.UpdateInfo) {
  if (update?.type !== Updates.UpdateInfoType.NEW || !("extra" in update.manifest)) return undefined;
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

/** Same public GitHub release bodies as the desktop changelog; never substitute a newer channel release. */
function ReleaseBody({ version }: { version?: string }) {
  const c = useColors();
  const [body, setBody] = useState<string>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const published = version && releaseChannel(version) !== "development";
  useEffect(() => {
    if (!published) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => controller.abort(), 20_000);
    void fetch(`https://api.github.com/repos/itsoltech/canopy/releases/tags/v${encodeURIComponent(version)}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Release unavailable");
        const release = parseObject(await response.text());

        if (str(release.tag_name) !== `v${version}` || release.draft === true) throw new Error("Release mismatch");

        if (!controller.signal.aborted) {
          setBody(str(release.body));
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
      {body ? (
        <Markdown text={body} />
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>
          {error ||
            (!published
              ? "Release notes are unavailable for this update."
              : body === undefined
                ? "Loading release notes…"
                : "No release notes were published for this version.")}
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
