import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import type { BlobRef } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button } from "../../ui/Button";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { styles, useColors, useTypography } from "../../ui/theme";
import { CopyAction } from "./copy-action";
import { QuoteAction } from "../quotes/QuoteAction";
import { DiffContent } from "../../ui/DiffContent";
import { QUOTE_LIMITS } from "@canopy/domain";

const TEXT_BYTES = 8 * 1024 ** 2;
export const INLINE_PREVIEW = 12_000;

/** Bound each native Text and the mounted window, including for a single enormous output line. */
function chunksOf(text: string) {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const maximum = Math.min(offset + 4096, text.length);
    const newline = text.lastIndexOf("\n", maximum - 1);
    let end = newline >= offset ? newline + 1 : maximum;
    const last = text.charCodeAt(end - 1);

    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(offset, end));
    offset = end;
  }

  return chunks;
}

function TextChunk({ text, diff }: { text: string; diff: boolean }) {
  const c = useColors();
  const type = useTypography();

  return diff ? (
    <DiffContent diff={text} />
  ) : (
    <Text selectable style={[type.mono, { color: c.text }]}>
      {text}
    </Text>
  );
}

export function TextViewer({
  text = "",
  blob,
  threadId,
  label,
  diff = false,
  onClose,
  extraActions,
}: {
  text?: string;
  blob?: BlobRef | undefined;
  threadId: string;
  label: string;
  diff?: boolean;
  onClose: () => void;
  extraActions?: ReactNode;
}) {
  const { client } = useSession();
  const c = useColors();
  const [loaded, setLoaded] = useState<string>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  const inlineTooLarge = useMemo(
    () =>
      text.length > TEXT_BYTES || (text.length > TEXT_BYTES / 3 && new TextEncoder().encode(text).length > TEXT_BYTES),
    [text],
  );

  const tooLarge = blob ? blob.sizeBytes > BigInt(TEXT_BYTES) : inlineTooLarge;
  const sha256 = blob?.sha256;

  useEffect(() => {
    if (tooLarge) return;
    const controller = new AbortController();
    setError("");

    if (!sha256) setLoaded(text);
    else if (client) {
      setLoaded(undefined);
      void client.api
        .getThreadBlob({ threadId, sha256 }, { signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted) return;

          if (response.data.length > TEXT_BYTES) {
            setError("This content exceeds the 8 MB viewing limit. Ask the agent for a smaller section.");

            return;
          }

          setLoaded(new TextDecoder("utf-8", { fatal: true }).decode(response.data));
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("Could not load this content. Check the connection, then retry.");
        });
    }

    return () => controller.abort();
  }, [client, threadId, sha256, text, tooLarge, retry]);

  const chunks = useMemo(() => chunksOf(loaded ?? ""), [loaded]);

  return (
    <FullScreenViewer
      title={label}
      onClose={onClose}
      actions={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {loaded ? (
            <>
              <CopyAction text={loaded} label={diff ? "Copy diff" : "Copy output"} />
              <QuoteAction text={loaded} kind={diff ? "diff" : "command_output"} />
            </>
          ) : null}
          {extraActions}
        </View>
      }
    >
      {tooLarge || error ? (
        <View style={{ padding: 20, gap: 12 }}>
          <Text accessibilityRole="alert" style={[styles.body, { color: c.muted }]}>
            {tooLarge ? "This content exceeds the 8 MB viewing limit. Ask the agent for a smaller section." : error}
          </Text>
          {!tooLarge && <Button title="Retry" onPress={() => setRetry((n) => n + 1)} />}
        </View>
      ) : loaded === undefined ? (
        <ActivityIndicator accessibilityLabel="Loading content" style={{ padding: 24 }} color={c.muted} />
      ) : (
        <FlatList
          data={chunks}
          keyExtractor={(_chunk, index) => String(index)}
          renderItem={({ item }) => (
            <View>
              <TextChunk text={item} diff={diff} />
              {loaded.length > QUOTE_LIMITS.maxTextChars && (
                <QuoteAction text={item} kind={diff ? "diff" : "command_output"} />
              )}
            </View>
          )}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={5}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={<Text style={[styles.body, { color: c.muted }]}>No content.</Text>}
        />
      )}
    </FullScreenViewer>
  );
}
