import { useEffect, useRef, useState } from "react";
import type { ui } from "@canopy/contracts";
import type { ComposerConnection } from "@canopy/domain/composer-connection";
import { useSession } from "../../state/session";

export function useThreadStop(
  id: string,
  snapshot: ui.ThreadSnapshot | undefined,
  connection: ComposerConnection,
  setError: (error: string) => void,
) {
  const { client, session } = useSession();
  const [stopping, setStopping] = useState(false);
  const pending = useRef(false);
  const current = useRef({ client, snapshot });
  current.current = { client, snapshot };
  const controller = useRef(new AbortController());
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;

    return () => request.abort();
  }, [id, session?.deviceId]);

  async function stop() {
    if (pending.current || !client) return;
    const turnId = snapshot?.turns.find((turn) => turn.status === "running" && !turn.inherited)?.id;

    if (!turnId) return;
    const signal = controller.current.signal;
    pending.current = true;
    setStopping(true);
    setError("");

    try {
      await connection.waitUntilLive(signal);

      // A queued Stop belongs to the turn the user saw, never a subsequent turn.
      if (!current.current.snapshot?.turns.some((turn) => turn.id === turnId && turn.status === "running")) return;
      await current.current.client?.api.interruptThread({ threadId: id }, { signal });
    } catch {
      if (!signal.aborted) setError("Could not stop the turn. Try again.");
    } finally {
      pending.current = false;

      if (!signal.aborted) setStopping(false);
    }
  }

  return { stop, stopping };
}
