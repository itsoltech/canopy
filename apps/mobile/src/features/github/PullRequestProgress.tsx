import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { checkComplete, checksProgress, jobStepsProgress } from "@canopy/domain/github-pr";
import { useSession } from "../../state/session";
import { useColors, useTypography } from "../../ui/theme";
import { useForegroundInterval } from "../../ui/interval";

export function PullRequestProgress({
  snapshot,
  checks,
  runs,
  checksComplete,
}: {
  snapshot: github.PullRequestSnapshot;
  checks: readonly github.PullRequestCheck[];
  runs: readonly string[];
  checksComplete: boolean;
}) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const id = snapshot.summary?.ref?.id ?? "";
  const headSha = snapshot.summary?.headSha ?? "";
  const runKey = runs.join(",");
  const [jobs, setJobs] = useState<github.PullRequestJob[]>([]);
  const [partial, setPartial] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      if (!client || !id || !runs.length) {
        setJobs([]);

        return;
      }

      setPartial(false);

      const responses = await Promise.allSettled(
        runs.map(async (runId) => {
          const result: github.PullRequestJob[] = [];
          let cursor = "";

          for (let page = 0; page < 100; page++) {
            const response = await client.api.listPullRequestCheckJobs({
              pullRequestId: id,
              resourceId: runId,
              headSha,
              cursor,
              refresh,
            });

            result.push(...response.jobs);
            cursor = response.page?.nextCursor ?? "";

            if (!cursor) return { jobs: result, complete: true };
          }

          return { jobs: result, complete: false };
        }),
      );

      const nextJobs = responses.flatMap((response) => (response.status === "fulfilled" ? response.value.jobs : []));
      setJobs(nextJobs);
      setPartial(
        responses.some(
          (response) => response.status === "rejected" || (response.status === "fulfilled" && !response.value.complete),
        ),
      );
    },
    [client, headSha, id, runKey],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const checksTotal = checksComplete
    ? checks.length
    : Math.max(checks.length, Number(snapshot.summary?.checksCount ?? 0));

  const checkProgress = checksProgress(checks, checksTotal);
  const stepProgress = partial ? undefined : jobStepsProgress(jobs);
  const checkPercent = checkProgress ? Math.round((checkProgress.done / checkProgress.total) * 100) : undefined;
  const stepPercent = stepProgress ? Math.round((stepProgress.done / stepProgress.total) * 100) : undefined;

  const running = useMemo(
    () => checks.some((check) => !checkComplete(check.state)) || jobs.some((job) => !checkComplete(job.state)),
    [checks, jobs],
  );

  useForegroundInterval(() => void load(true), 15_000, running);

  if (!checkProgress && !stepProgress) return null;

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {checkProgress && (
        <Text style={[type.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
          Checks {checkProgress.done}/{checkProgress.total} · {checkPercent}%
        </Text>
      )}
      {stepProgress && (
        <Text style={[type.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
          Steps {stepProgress.done}/{stepProgress.total} · {stepPercent}%
        </Text>
      )}
    </View>
  );
}
