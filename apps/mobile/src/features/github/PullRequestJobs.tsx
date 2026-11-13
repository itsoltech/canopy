import { useCallback, useState, useRef } from "react";
import { Text, View } from "react-native";
import { checkLook } from "@canopy/domain/github-pr";
import { useSession } from "../../state/session";
import { useColors, useTypography } from "../../ui/theme";
import { Button } from "../../ui/components";
import { CheckStateIcon } from "./CheckStateIcon";
import { usePages } from "./usePages";
import { PageControls } from "./PageControls";
import { PullRequestLog } from "./PullRequestLog";
import type { github } from "@canopy/contracts";
import { CiActions } from "./CiActions";
import { prCitation, prCheckFailed } from "@canopy/domain";
import { ListSkeleton } from "../../ui/Skeleton";
import { useForegroundInterval } from "../../ui/interval";

export function PullRequestJobs({ snapshot, runId }: { snapshot: github.PullRequestSnapshot; runId: string }) {
  const id = snapshot.summary?.ref?.id ?? "";
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const [jobId, setJob] = useState("");
  const [logVisible, setLogVisible] = useState(true);
  const pendingLogAction = useRef<(() => void) | undefined>(undefined);

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestCheckJobs({ pullRequestId: id, resourceId: runId, cursor, refresh }),
      [client, id, runId],
    ),
    id,
    "",
    true,
    `jobs:${snapshot.accountId}:${snapshot.accessRevision}:${snapshot.summary?.headSha}:${runId}`,
  );

  const pending = !!pages.current?.jobs.some((job) =>
    ["queued", "in_progress", "pending", "waiting"].includes(job.state),
  );

  useForegroundInterval(() => void pages.read(), 15_000, pending);

  return (
    <View style={{ gap: 8, padding: 8 }}>
      {!pages.current && !pages.error && <ListSkeleton rows={3} inset={false} />}
      {pages.current?.run && (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[type.small, { flex: 1, color: c.text }]}>
            {pages.current.run.name} · attempt {pages.current.run.attempt}
          </Text>
          <CiActions snapshot={snapshot} runId={runId} state={pages.current.run.state} />
        </View>
      )}
      {pages.current?.jobs.map((job) => {
        const look = checkLook(job.state);

        const quote = prCheckFailed(job.state)
          ? prCitation(snapshot, "job", job.id, `${job.name}: ${job.state}`, { url: job.url })
          : undefined;

        return (
          <View key={job.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <CheckStateIcon look={look} showStatus />
            <Text numberOfLines={2} style={[type.small, { flex: 1, color: c.text }]}>
              {job.name}
            </Text>
            <CiActions
              snapshot={snapshot}
              runId={runId}
              state={pages.current?.run?.state ?? job.state}
              jobId={job.id}
              name={job.name}
              url={job.url}
              quote={quote}
            />
            <Button
              title="View logs"
              variant="ghost"
              onPress={() => {
                setLogVisible(true);
                setJob(job.id);
              }}
            />
          </View>
        );
      })}
      <PageControls
        page={pages.current?.page}
        busy={pages.busy}
        error={pages.error}
        previous={pages.previous}
        next={() => void pages.read(true)}
        retry={() => void pages.read(false, true)}
      />
      {!!jobId && (
        <PullRequestLog
          id={id}
          snapshot={snapshot}
          jobUrl={pages.current?.jobs.find((job) => job.id === jobId)?.url ?? ""}
          jobId={jobId}
          visible={logVisible}
          onClose={() => setJob("")}
          onDismiss={() => {
            // UIKit must dismiss the log's window before the shared CI dialog is presented.
            const choose = pendingLogAction.current;
            pendingLogAction.current = undefined;
            setJob("");
            choose?.();
          }}
          renderActions={(quote) => (
            <CiActions
              snapshot={snapshot}
              runId={runId}
              state={pages.current?.run?.state ?? "unknown"}
              jobId={jobId}
              name={pages.current?.jobs.find((job) => job.id === jobId)?.name ?? ""}
              quote={quote}
              url={pages.current?.jobs.find((job) => job.id === jobId)?.url ?? ""}
              beforeChoose={(choose) => {
                pendingLogAction.current = choose;
                setLogVisible(false);
              }}
            />
          )}
        />
      )}
    </View>
  );
}
