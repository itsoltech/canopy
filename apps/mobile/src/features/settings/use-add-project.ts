import { useEffect, useRef, useState } from "react";
import { ConnectError } from "@connectrpc/connect";
import type { CloneProgress, ui } from "@canopy/contracts";
import { CLONE_RPC_TIMEOUT_MS } from "@canopy/domain/clone-progress";
import { useSession } from "../../state/session";

/** Shared project/workspace clone lifecycle; no filesystem work or credentials on the phone. */
export function useAddProject(onSaved: () => void, onBusy: (busy: boolean) => void) {
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<CloneProgress>();
  const [attempted, setAttempted] = useState(false);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), [client]);

  async function add(request: ui.AddProjectRequest, capable: boolean) {
    if (!client || abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    onBusy(true);
    setError("");
    setProgress(undefined);
    setAttempted(request.source.case === "clone");

    try {
      if (request.source.case === "clone" && capable) {
        let result: ui.AddProjectResponse | undefined;

        for await (const event of client.api.cloneProject(request, {
          signal: controller.signal,
          timeoutMs: CLONE_RPC_TIMEOUT_MS,
        })) {
          if (event.progress) setProgress(event.progress);

          if (event.result) result = event.result;
        }

        if (!result) throw new Error("Cloning was interrupted. Check the connection and retry.");
      } else await client.api.addProject(request, { signal: controller.signal, timeoutMs: CLONE_RPC_TIMEOUT_MS });
      onSaved();
    } catch (cause) {
      setError(
        controller.signal.aborted
          ? "Cloning cancelled. Retry when ready."
          : cause instanceof ConnectError
            ? cause.rawMessage
            : "Could not add the project. Check the connection and retry.",
      );
    } finally {
      abort.current = undefined;
      setBusy(false);
      onBusy(false);
    }
  }

  function reset() {
    setError("");
    setProgress(undefined);
    setAttempted(false);
  }

  return { busy, error, progress, attempted, add, reset, cancel: () => abort.current?.abort() };
}
