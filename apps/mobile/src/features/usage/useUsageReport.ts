import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";
import { requestUsageReport, type UsageReportResult } from "./request";

type SettledUsageReport = UsageReportResult | { status: "error" };

type UsageReport =
  | { status: "loading"; data?: ui.GetUsageStatsResponse }
  | (SettledUsageReport & { reload: () => void });

export function useUsageReport(request: MessageInitShape<typeof ui.GetUsageStatsRequestSchema>): UsageReport {
  const { client, epoch } = useSession();
  const active = useAppActive();
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  const scope = useMemo(() => ({ client, request, active, epoch }), [client, request, active, epoch]);
  const read = useMemo(() => ({ scope, revision }), [scope, revision]);

  const [settled, setSettled] = useState<{ read: typeof read; result: SettledUsageReport }>();

  useEffect(() => {
    const { client, active, request } = read.scope;

    if (!client || !active) return;
    const controller = new AbortController();

    void requestUsageReport(client.api, request, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setSettled({ read, result });
      },
      () => {
        if (!controller.signal.aborted) setSettled({ read, result: { status: "error" } });
      },
    );

    return () => controller.abort();
  }, [read]);

  if (settled?.read === read) return { ...settled.result, reload };

  // Keep the previous readings mounted during a manual refresh of the same report.
  const previous = settled?.read.scope === scope && settled.result.status === "ready" ? settled.result.data : undefined;

  return { status: "loading", data: previous };
}
