import { Linking, Pressable, Text, View } from "react-native";
import { useState } from "react";
import type { NoteEntry } from "@canopy/domain/release/notes";
import { noteGroups } from "@canopy/domain/release/note-range";
import { Badge } from "../../ui/Badge";
import { styles, useColors } from "../../ui/theme";
import { Button } from "../../ui/Button";

export function WhatsNewEntries({ entries }: { entries: readonly NoteEntry[] }) {
  const c = useColors();

  return (
    <View style={{ gap: 20 }}>
      {noteGroups.map((group) => {
        const items = entries.filter((entry) => entry.type === group.type);

        return items.length ? (
          <View key={group.type} style={{ gap: 8 }}>
            <Text accessibilityRole="header" style={[styles.label, { color: c.text }]}>
              {group.title}
            </Text>
            {items.map((entry, i) => (
              <NoteRow key={entry.pr ?? i} entry={entry} />
            ))}
          </View>
        ) : null;
      })}
      {!entries.length && <Text style={[styles.meta, { color: c.muted }]}>No changes listed for this version.</Text>}
    </View>
  );
}

function NoteRow({ entry }: { entry: NoteEntry }) {
  const c = useColors();
  const [error, setError] = useState(false);

  const open = () => {
    if (entry.url) void Linking.openURL(entry.url).catch(() => setError(true));
  };

  const summary = <Text style={[styles.body, { color: c.text }]}>{entry.summary}</Text>;

  return (
    <View style={{ gap: 4 }}>
      {entry.url ? (
        <Pressable accessibilityRole="link" onPress={open} style={{ minHeight: 44, justifyContent: "center" }}>
          {summary}
        </Pressable>
      ) : (
        summary
      )}
      {(entry.scope || entry.pr) && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {entry.scope ? (
            <View style={{ maxWidth: "85%", flexShrink: 1 }}>
              <Badge>{entry.scope}</Badge>
            </View>
          ) : null}
          {entry.pr ? <Text style={[styles.caption, { color: c.muted }]}>#{entry.pr}</Text> : null}
        </View>
      )}
      {error && (
        <View style={{ gap: 4 }}>
          <Text style={[styles.meta, { color: c.muted }]}>Could not open this change. Retry the link.</Text>
          <Button title="Retry link" size="sm" variant="ghost" onPress={open} />
        </View>
      )}
    </View>
  );
}
