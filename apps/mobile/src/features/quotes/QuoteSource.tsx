import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { firstHistoryPage } from "../../state/history-page";
import { Button } from "../../ui/Button";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { styles, useColors } from "../../ui/theme";
import { ItemView } from "../timeline/ItemView";
import { TimelineDirectoryProvider, useTimelineDirectory } from "../timeline/directory";

/** A focused page read also finds sources older than the timeline's loaded window. */
export function QuoteSource({ quote, onClose }: { quote: ui.Quote; onClose: () => void }) {
  const { client } = useSession();
  const directory = useTimelineDirectory();
  const c = useColors();
  const [entry, setEntry] = useState<ui.TimelineItem>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    setError("");
    void firstHistoryPage(async function* (signal) {
      for await (const update of client.api.watchThread(
        { threadId: directory.currentId, targetItemId: quote.sourceItemId, pageSize: 1 },
        { signal, timeoutMs: 20_000 },
      )) {
        if (!update.syncing) yield update;
      }
    }, abort.signal)
      .then((update) => {
        if (abort.signal.aborted) return;

        const found =
          update.change.case === "snapshot"
            ? update.change.value.items.find((item) => item.item?.itemId === quote.sourceItemId)
            : undefined;

        if (!found) throw new Error("Source unavailable");
        setEntry(found);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("Could not find the source in this thread. Retry to load it again.");
      });

    return () => abort.abort();
  }, [client, directory.currentId, quote.sourceItemId, retry]);

  return (
    <FullScreenViewer title="Quote source" onClose={onClose}>
      {entry?.item ? (
        <TimelineDirectoryProvider
          value={{ ...directory, sourceId: entry.fromThreadId || directory.currentId, readOnly: true }}
        >
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            <ItemView node={{ item: entry.item, children: [] }} turnEnded />
          </ScrollView>
        </TimelineDirectoryProvider>
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
