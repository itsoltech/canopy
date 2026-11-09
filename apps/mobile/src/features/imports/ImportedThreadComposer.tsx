import { useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { agentCliName } from "@canopy/domain/import-look";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { openSettingsSection } from "../settings/navigation";

/** History takes no turns; continue in a new thread with the gateway's summary. */
export function ImportedThreadComposer({
  thread,
  disabled,
  children,
}: {
  thread?: ui.Thread;
  disabled: boolean;
  children: ReactNode;
}) {
  return thread?.import?.mode === "history" ? <ImportHistory thread={thread} disabled={disabled} /> : children;
}

function ImportHistory({ thread, disabled }: { thread: ui.Thread; disabled: boolean }) {
  const { client, online } = useSession();
  const c = useColors();
  const starting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function continueHere() {
    if (!client || !online || disabled || starting.current) return;
    starting.current = true;
    setBusy(true);
    setError("");

    try {
      const next = await client.api.continueImportedThread({ threadId: thread.id }, { timeoutMs: 65_000 });

      if (!next.thread) throw new Error("Missing continued thread");
      router.push({ pathname: "/thread/[id]", params: { id: next.thread.id } });
    } catch {
      setError("Could not start a new thread. Check the worker and try again.");
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={{ padding: 12, gap: 12 }}>
      <Text accessibilityRole="header" style={[styles.label, { color: c.text }]}>
        Imported from {agentCliName(thread.import?.agentCli ?? "")} as history
      </Text>
      <Notice>A new thread continues this work with a summary of its history.</Notice>
      <Button
        title="Continue in a new thread"
        variant="primary"
        busy={busy}
        disabled={disabled || !online}
        onPress={() => void continueHere()}
      />
      <Button title="Manage imports" onPress={() => openSettingsSection("import")} />
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}
