import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { formatBytes } from "@canopy/domain/format";
import { useSession } from "../../state/session";
import { Button } from "../../ui/Button";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { styles, useColors } from "../../ui/theme";
import { TextViewer } from "../viewers/TextViewer";
import { exportFile } from "./export-file";
import { ImageViewer } from "./ImageViewer";

const FILE_BYTES = 20 * 1024 ** 2;

export function AttachmentViewer({ file, onClose }: { file: ui.Attachment; onClose: () => void }) {
  return file.kind === "image" ? (
    <ImageViewer source={{ kind: "attachment", file }} name={file.name} onClose={onClose} />
  ) : (
    <FileViewer file={file} onClose={onClose} />
  );
}

function FileViewer({ file, onClose }: { file: ui.Attachment; onClose: () => void }) {
  const { client } = useSession();
  const c = useColors();
  const [data, setData] = useState<Uint8Array>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string>();
  const tooLarge = file.sizeBytes > BigInt(FILE_BYTES);
  const { id, mimeType } = file;

  useEffect(() => {
    if (!client || tooLarge) return;
    const controller = new AbortController();
    setError("");
    void client.api
      .getAttachment({ attachmentId: id }, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;

        if (response.data.length > FILE_BYTES) throw new Error("File too large");
        setData(response.data);

        if (/^(text\/|application\/(json|xml|javascript))/.test(mimeType) && response.data.length <= 8 * 1024 ** 2) {
          try {
            setText(new TextDecoder("utf-8", { fatal: true }).decode(response.data));
          } catch {
            /* Binary files remain exportable. */
          }
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load the file. Check the connection, then retry.");
      });

    return () => controller.abort();
  }, [client, id, mimeType, tooLarge, retry]);

  async function save() {
    if (!data || busy) return;
    setBusy(true);

    try {
      await exportFile(file.name, data, mimeType);
    } catch {
      setError("Could not export the file. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const action = (
    <Button
      title={Platform.OS === "android" ? "Save file" : "Share file"}
      busy={busy}
      disabled={!data}
      onPress={() => void save()}
      size="sm"
    />
  );

  if (text !== undefined && !error)
    return <TextViewer text={text} threadId="" label={file.name} onClose={onClose} extraActions={action} />;

  return (
    <FullScreenViewer title={file.name} onClose={onClose} actions={action}>
      <View style={{ padding: 20, gap: 12 }}>
        <Text style={[styles.body, { color: c.text }]}>
          {formatBytes(file.sizeBytes)} · {mimeType}
        </Text>
        {tooLarge ? (
          <Text accessibilityRole="alert" style={[styles.body, { color: c.muted }]}>
            This file exceeds the 20 MB limit. Attach a smaller file to view it.
          </Text>
        ) : error ? (
          <>
            <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
              {error}
            </Text>
            <Button title="Retry" onPress={() => setRetry((n) => n + 1)} />
          </>
        ) : !data ? (
          <ActivityIndicator accessibilityLabel="Loading file" color={c.muted} />
        ) : (
          <Text style={[styles.body, { color: c.muted }]}>Save or share this file to open it in another app.</Text>
        )}
      </View>
    </FullScreenViewer>
  );
}
