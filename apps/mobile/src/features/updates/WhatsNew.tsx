import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { uniqueEntries } from "@canopy/domain/release/note-range";
import { Button, IconButton, Sheet } from "../../ui/components";
import { useMotion } from "../../ui/motion";
import { styles, useColors, useTypography } from "../../ui/theme";
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
  const type = useTypography();
  const insets = useSafeAreaInsets();
  const { toast: motion } = useMotion();

  if (!notes.notice) return null;

  return (
    <Animated.View
      entering={motion.entering}
      exiting={motion.exiting}
      pointerEvents="box-none"
      style={{
        alignSelf: "flex-end",
        alignItems: "flex-end",
        maxWidth: "100%",
        paddingLeft: insets.left + 16,
        paddingRight: insets.right + 16,
        marginBottom: insets.bottom + 12,
        marginTop: 4,
      }}
    >
      <View
        style={[
          styles.row,
          {
            maxWidth: "100%",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.line,
            backgroundColor: c.surface,
            paddingLeft: 12,
            paddingRight: 8,
          },
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, flexWrap: "wrap", columnGap: 6 }}>
          <Text
            accessibilityLiveRegion="polite"
            style={[type.small, { color: c.text, flexShrink: 1, paddingVertical: 4 }]}
          >
            Updated to {CANOPY_VERSION}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={notes.show}
            style={({ pressed }) => ({
              minHeight: 48,
              minWidth: 48,
              maxWidth: "100%",
              justifyContent: "center",
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: pressed ? c.pressed : "transparent",
            })}
          >
            <Text style={[type.small, { color: c.soft, textAlign: "center", textDecorationLine: "underline" }]}>
              View changes
            </Text>
          </Pressable>
        </View>
        <IconButton
          icon="x-mark"
          label="Dismiss update notice"
          size="sm"
          style={{ alignSelf: "flex-start", marginTop: 8 }}
          onPress={notes.dismiss}
        />
      </View>
    </Animated.View>
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
              viewKey={`release:${release.version}`}
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
