import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { Item, ui } from "@canopy/contracts";
import { loadThreadItem } from "@canopy/domain/thread-content";
import { useSession } from "../../state/session";
import { formatBytes } from "@canopy/domain/format";
import { styles, useColors } from "../../ui/theme";

export function LazyItemContent({
  reference,
  threadId,
  onLoad,
  auto = false,
  subject = "output",
}: {
  reference: ui.ThreadSyncContent;
  threadId: string;
  onLoad: (item: Item) => void;
  auto?: boolean;
  subject?: "output" | "message" | "thought" | "summary";
}) {
  const { client } = useSession();
  const c = useColors();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!client || (!auto && attempt === 0)) return;
    const abort = new AbortController();
    const api = client.api;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const item = await loadThreadItem(
          reference,
          (offset, length) =>
            api.getThreadSyncContent(
              {
                threadId,
                sha256: reference.sha256,
                offset,
                length,
              },
              { signal: abort.signal },
            ),
          abort.signal,
          threadId,
        );

        if (!abort.signal.aborted) onLoad(item);
      } catch {
        if (!abort.signal.aborted) setError(`Could not load the full ${subject}.`);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }

    void load();

    return () => abort.abort();
  }, [client, reference, threadId, onLoad, auto, attempt, subject]);

  const busy = loading || (auto && !error);
  const action = error ? "Retry" : `Show full ${subject} · ${formatBytes(reference.sizeBytes)}`;

  return (
    <View style={{ gap: 4, alignItems: "flex-start", minHeight: 20 }}>
      {busy ? (
        <View style={[styles.row, { gap: 6 }]}>
          <ActivityIndicator size="small" color={c.muted} />
          <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
            Loading {subject}…
          </Text>
        </View>
      ) : (
        <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
          {error ? (
            <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>{error}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action}
            hitSlop={12}
            onPress={() => setAttempt((n) => n + 1)}
          >
            <Text style={[styles.workMeta, { color: c.soft }]}>{action}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
