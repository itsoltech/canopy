import { useRef, useState } from "react";
import { Alert } from "react-native";
import { Provider, type ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useLayout } from "../../state/layout";
import { IconButton } from "../../ui/Button";
import { useTimelineDirectory } from "./directory";

/** Same CreateThread fork request and eligibility as the web. The gateway derives settings and enforces access. */
export function ForkAction({ turn }: { turn: ui.Turn }) {
  const { client } = useSession();
  const directory = useTimelineDirectory();
  const layout = useLayout();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const thread = directory.thread(directory.currentId);

  const available =
    !directory.readOnly &&
    thread?.runtime === "worker" &&
    thread.provider !== Provider.GROK &&
    thread.status !== "creating" &&
    !!turn.startedAt &&
    ["completed", "failed", "interrupted"].includes(turn.status);

  async function fork() {
    if (!client || pending.current) return;
    pending.current = true;
    setBusy(true);

    try {
      const result = await client.api.createThread({ forkThreadId: directory.currentId, forkAtTurnId: turn.id });

      if (!result.thread) throw new Error("Missing fork");
      await layout.openThread(result.thread.id);
    } catch {
      Alert.alert("Could not fork the thread", "Check the home computer's connection, then try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return available ? (
    <IconButton icon="git-fork" label="Fork from here" size="sm" busy={busy} onPress={() => void fork()} />
  ) : null;
}
