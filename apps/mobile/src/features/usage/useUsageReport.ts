import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";
import { requestUsageReport, type UsageReportResult } from "./request";

type SettledUsageReport = UsageReportResult | { status: "error" };

type UsageReport = { status: "loading" } | (SettledUsageReport & { reload: () => void });

export function useUsageReport(request: MessageInitShape<typeof ui.GetUsageStatsRequestSchema>): UsageReport {
  const { client, epoch } = useSession();
  const active = useAppActive();
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  const read = useMemo(
    () => ({ client, request, active, epoch, revision }),
    [client, request, active, epoch, revision],
  );

  const [settled, setSettled] = useState<{ read: typeof read; result: SettledUsageReport }>();

  useEffect(() => {
    if (!read.client || !read.active) return;
    const controller = new AbortController();

    void requestUsageReport(read.client.api, read.request, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setSettled({ read, result });
      },
      () => {
        if (!controller.signal.aborted) setSettled({ read, result: { status: "error" } });
      },
    );

    return () => controller.abort();
  }, [read]);

  return settled?.read === read ? { ...settled.result, reload } : { status: "loading" };
}
