import { useState } from "react";
import { Linking, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { uniqueEntries } from "@canopy/domain/release/note-range";
import { Button, IconButton, Sheet } from "../../ui/components";
import { useMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";
import { CANOPY_VERSION } from "../../version";
import { SettingsDisclosure } from "../settings/SettingsDisclosure";
import { SettingsGroup, SettingsRow } from "../settings/SettingsGroup";
import { WhatsNewEntries } from "./WhatsNewEntries";
import { useWhatsNew } from "./whats-new";

export function WhatsNewSettings() {
  const notes = useWhatsNew();

  return (
    <SettingsGroup title="What's new">
      <SettingsRow
        title={`Canopy ${CANOPY_VERSION}`}
        description={
          notes.previous ? `Updated from ${notes.previous}.` : "Read changes in this version and recent releases."
        }
      >
        <Button title="See what's new" size="sm" variant="ghost" onPress={notes.show} />
      </SettingsRow>
    </SettingsGroup>
  );
}

export function WhatsNewNotice() {
  const notes = useWhatsNew();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { toast: motion } = useMotion();

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: insets.left + 16,
        right: insets.right + 16,
        bottom: insets.bottom + 12,
        alignItems: "flex-end",
      }}
    >
      {notes.notice && (
        <Animated.View
          entering={motion.entering}
          exiting={motion.exiting}
          style={[
            styles.row,
            {
              width: "100%",
              maxWidth: 380,
              alignItems: "flex-start",
              borderRadius: 12,
              borderWidth: 1,
              borderColor: c.line,
              backgroundColor: c.surface,
              padding: 12,
            },
          ]}
        >
          <View style={{ flex: 1, gap: 8 }}>
            <Text accessibilityLiveRegion="polite" style={[styles.label, { color: c.text }]}>
              Updated to {CANOPY_VERSION}
            </Text>
            <Button title="See what's new" size="sm" onPress={notes.show} />
          </View>
          <IconButton icon="x-mark" label="Dismiss update notice" size="sm" onPress={notes.dismiss} />
        </Animated.View>
      )}
    </View>
  );
}

export function WhatsNewSheet() {
  const notes = useWhatsNew();
  const c = useColors();
  const [linkError, setLinkError] = useState("");

  return (
    <Sheet
      title="What's new"
      visible={notes.open}
      onClose={notes.close}
      footer={
        <>
          {linkError && <Text style={[styles.meta, { color: c.muted }]}>{linkError}</Text>}
          <Button
            title="View all releases on GitHub"
            size="sm"
            variant="ghost"
            onPress={() => {
              void Linking.openURL("https://github.com/itsoltech/canopy/releases").catch(() =>
                setLinkError("Could not open GitHub. Retry the link."),
              );
            }}
          />
        </>
      }
    >
      <Text style={[styles.meta, { color: c.muted }]}>
        {notes.recent || !notes.previous ? `Canopy ${CANOPY_VERSION}` : `From ${notes.previous} to ${CANOPY_VERSION}`}
      </Text>
      {notes.previous && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button
            title="Since update"
            size="sm"
            variant={notes.recent ? "ghost" : "secondary"}
            onPress={() => notes.setRecent(false)}
          />
          <Button
            title="Recent releases"
            size="sm"
            variant={notes.recent ? "secondary" : "ghost"}
            onPress={() => notes.setRecent(true)}
          />
        </View>
      )}
      {notes.pending ? (
        <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted }]}>
          Loading release notes…
        </Text>
      ) : notes.error ? (
        <View style={{ gap: 8 }}>
          <Text style={[styles.meta, { color: c.muted }]}>{notes.error}</Text>
          <Button title="Retry" size="sm" onPress={() => void notes.load()} />
        </View>
      ) : (
        <WhatsNewContent />
      )}
    </Sheet>
  );
}

function WhatsNewContent() {
  const notes = useWhatsNew();
  const c = useColors();

  if (!notes.index) return null;

  const missing = notes.recent
    ? !notes.index.releases.some((release) => release.version === CANOPY_VERSION)
    : notes.range?.incomplete;

  return (
    <>
      {missing && (
        <View style={{ gap: 8 }}>
          <Text style={[styles.meta, { color: c.muted }]}>
            Some release notes are not available yet. Retry or view releases on GitHub.
          </Text>
          <Button title="Retry" size="sm" onPress={() => void notes.load()} />
        </View>
      )}
      {notes.recent
        ? notes.releases.map((release, i) => (
            <SettingsDisclosure
              key={release.version}
              title={`${release.version} · ${new Date(release.date).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
              initiallyOpen={i === 0}
            >
              <WhatsNewEntries entries={uniqueEntries([release])} />
            </SettingsDisclosure>
          ))
        : notes.range && <WhatsNewEntries entries={notes.range.entries} />}
    </>
  );
}
