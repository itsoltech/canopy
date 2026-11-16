import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { RunAgentToolSchema, type AgentPreviewInput, type AgentPreviewTarget, type AgentTool } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";
import { emptyPreview, NativePreviewSession, type PreviewSnapshot } from "./preview-session";

export function useAgentPreview({
  threadId,
  tool,
  target,
  enabled,
}: {
  threadId: string;
  tool: AgentTool;
  target?: AgentPreviewTarget;
  enabled: boolean;
}) {
  const { client, ready, online, epoch } = useSession();
  const active = useAppActive();
  const [attempt, setAttempt] = useState(0);
  const platform = target?.platform ?? "";
  const app = target?.app ?? "";
  const windowId = target?.windowId ?? "";
  const deviceId = target?.deviceId ?? "";

  const scope = useMemo(
    () => create(RunAgentToolSchema, { tool, platform, app, windowId, deviceId }),
    [tool, platform, app, windowId, deviceId],
  );

  const connection = useMemo(
    () =>
      enabled && active && ready && online && client && threadId
        ? { client, threadId, scope, epoch, attempt }
        : undefined,
    [client, threadId, scope, enabled, active, ready, online, epoch, attempt],
  );

  const [current, setCurrent] = useState<{
    connection: NonNullable<typeof connection>;
    session: NativePreviewSession;
    snapshot: PreviewSnapshot;
  }>();

  useEffect(() => {
    if (!connection) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setCurrent(undefined);
      });

      return () => {
        cancelled = true;
      };
    }

    const session = new NativePreviewSession(
      connection.client.api,
      connection.threadId,
      connection.scope,
      (snapshot) => {
        setCurrent({ connection, session, snapshot });
      },
    );

    void session.start();

    return () => session.stop();
  }, [connection]);

  const shown = current?.connection === connection ? current : undefined;
  const input = useCallback((value: AgentPreviewInput) => shown?.session.input(value), [shown?.session]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    ...(connection ? (shown?.snapshot ?? emptyPreview("connecting")) : emptyPreview()),
    input,
    retry,
  };
}
