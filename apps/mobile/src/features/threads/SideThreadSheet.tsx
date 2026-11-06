import { useState } from "react";
import { Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { ConnectError } from "@connectrpc/connect";
import { PermissionMode, type ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useLayout } from "../../state/layout";
import { Button, Field } from "../../ui/components";
import { Overlay } from "../../ui/Overlay";
import { Checkbox } from "../../ui/Checkbox";
import { styles, useColors } from "../../ui/theme";

const hint = "The side thread starts from the main thread's last completed turn.";

/**
 * A side thread of this thread, as on the web: same project, worker, folder, agent and model; it can start from the
 * main thread's history. Full access is never taken over: the side thread gets full auto instead.
 */
export function SideThreadSheet({
  main,
  visible,
  onClose,
}: {
  main: ui.Thread | undefined;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Overlay visible={visible} onClose={onClose} label="New side thread">
      {main && visible ? <SideThreadForm main={main} onClose={onClose} /> : null}
    </Overlay>
  );
}

function SideThreadForm({ main, onClose }: { main: ui.Thread; onClose: () => void }) {
  const c = useColors();
  const { client } = useSession();
  const layout = useLayout();
  const [text, setText] = useState("");
  const [fork, setFork] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => Crypto.randomUUID());
  const closed = main.status === "archived" || Boolean(main.deletedAt);

  async function start() {
    if (!client || !text.trim() || busy) return;
    setBusy(true);
    setError("");

    try {
      const message = text.trimStart().startsWith("!") ? text.trimEnd() : text.trim();

      const result = await client.api.createThread(
        {
          projectId: main.projectId,
          workspaceId: main.workspaceId,
          provider: main.provider,
          providerProfileId: main.providerProfileId,
          model: main.model,
          effort: main.effort,
          permissionMode:
            main.permissionMode === PermissionMode.FULL_ACCESS ? PermissionMode.FULL_AUTO : main.permissionMode,
          initialMessage: message,
          parentThreadId: main.id,
          fork,
          clientRequestId: requestId,
        },
        { timeoutMs: 100_000 },
      );

      onClose();

      if (result.thread) layout.open({ pathname: "/thread/[id]", params: { id: result.thread.id } });
    } catch (cause) {
      setError(ConnectError.from(cause).rawMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
        New side thread
      </Text>
      <Field
        label="Task for the side thread"
        multiline
        autoFocus
        value={text}
        onChangeText={setText}
        placeholder="Ask anything…"
        style={{ minHeight: 96, maxHeight: 160, textAlignVertical: "top" }}
      />
      <Checkbox label="Use main thread history" description={hint} checked={fork} onChange={setFork} />
      {closed || error ? (
        <Text accessibilityRole="alert" style={[styles.meta, { color: closed ? c.muted : c.danger }]}>
          {closed ? "Reopen the main thread to start a side thread." : error}
        </Text>
      ) : null}
      <View style={[styles.row, { justifyContent: "flex-end" }]}>
        <Button title="Cancel" onPress={onClose} />
        <Button
          variant="primary"
          title="Start side thread"
          busy={busy}
          disabled={closed || !text.trim()}
          onPress={() => void start()}
        />
      </View>
    </View>
  );
}
