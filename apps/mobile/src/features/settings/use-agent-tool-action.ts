import { useEffect, useRef, useState } from "react";
import type { ToolWorker } from "@canopy/domain/agent-tool-settings";
import { useSession } from "../../state/session";
import type { SettingsApi } from "./resource";

type ToolRequest = (api: SettingsApi, workerId: string, signal: AbortSignal) => Promise<boolean>;

/** The overview carries live worker reports. Keep command results, including partial failures, with their card. */
export function useAgentToolAction() {
  const { client } = useSession();
  const active = useRef<AbortController | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => () => active.current?.abort(), [client]);

  async function run(targets: ToolWorker[], request: ToolRequest, failure: string, success = "") {
    if (!client || active.current || !targets.length) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setNotice("");
    const missed: string[] = [];

    try {
      for (let index = 0; index < targets.length && !controller.signal.aborted; index += 4) {
        const group = targets.slice(index, index + 4);

        const results = await Promise.allSettled(
          group.map(({ worker }) => request(client.api, worker.id, controller.signal)),
        );

        results.forEach((result, i) => {
          if (result.status === "rejected" || !result.value) missed.push(group[i].worker.name);
        });
      }

      if (!controller.signal.aborted) {
        setFailed(missed.length > 0);
        setNotice(missed.length ? `${failure} ${missed.join(", ")}` : success);
      }
    } finally {
      active.current = undefined;
      setPending(false);
    }
  }

  return { pending, failed, notice, run };
}
