import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button } from "../../ui/Button";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { styles, useColors } from "../../ui/theme";
import { ItemView } from "../timeline/ItemView";
import { TimelineDirectoryProvider, useTimelineDirectory } from "../timeline/directory";
import { readCitationSource, type CitationSource } from "./read-source";

/** A focused page read also finds sources older than the timeline's loaded window. */
export function QuoteSource({ quote, onClose }: { quote: ui.Quote; onClose: () => void }) {
  const { client } = useSession();
  const directory = useTimelineDirectory();
  const c = useColors();
  const [source, setSource] = useState<CitationSource>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const sourceId = quote.sourceThreadId || directory.currentId;
  const entry = source?.entry;

  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    setError("");
    void readCitationSource(client, sourceId, quote.sourceItemId, abort.signal)
      .then((source) => {
        if (abort.signal.aborted) return;
        setSource(source);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("Could not find the source. Retry to load it again.");
      });

    return () => abort.abort();
  }, [client, sourceId, quote.sourceItemId, retry]);

  return (
    <FullScreenViewer title="Quote source" onClose={onClose}>
      {entry?.item ? (
        <TimelineDirectoryProvider
          value={{ ...directory, currentId: sourceId, sourceId: entry.fromThreadId || sourceId, readOnly: true }}
        >
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            <ItemView node={{ item: entry.item, children: [] }} turnEnded />
          </ScrollView>
        </TimelineDirectoryProvider>
      ) : source?.text !== undefined ? (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Text selectable style={[styles.body, { color: c.text }]}>
            {source.text}
          </Text>
        </ScrollView>
      ) : error ? (
        <View style={{ padding: 20, gap: 12 }}>
          <Text accessibilityRole="alert" style={[styles.body, { color: c.muted }]}>
            {error}
          </Text>
          <Button title="Retry" onPress={() => setRetry((n) => n + 1)} />
        </View>
      ) : (
        <ActivityIndicator accessibilityLabel="Loading quote source" style={{ padding: 24 }} color={c.muted} />
      )}
    </FullScreenViewer>
  );
}
