import { useCallback, useEffect, useState, useRef } from "react";
import { AppState, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { checkLook } from "@canopy/domain/github-pr";
import { useSession } from "../../state/session";
import { useColors, useTypography } from "../../ui/theme";
import { Button } from "../../ui/components";
import { StatusIcon as Icon } from "./StatusIcon";
import { usePages } from "./usePages";
import { PageControls } from "./PageControls";
import { PullRequestLog } from "./PullRequestLog";
import { toneColor } from "./presentation";
import type { github } from "@canopy/contracts";
import { CiActions } from "./CiActions";
import { CitationActions } from "./CitationActions";
import { prCitation, prCheckFailed } from "@canopy/domain";
import { ListSkeleton } from "../../ui/Skeleton";

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

  const latest = useRef(pages);
  useEffect(() => {
    latest.current = pages;
  }, [pages]);
  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(() => {
        const current = latest.current;

        if (
          AppState.currentState === "active" &&
          current.current?.jobs.some((job) => ["queued", "in_progress", "pending", "waiting"].includes(job.state))
        )
          void current.read();
      }, 15_000);

      return () => clearInterval(timer);
    }, []),
  );

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

        return (
          <View key={job.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name={look.icon} label={look.label} color={toneColor(c, look.tone)} />
            <Text numberOfLines={2} style={[type.small, { flex: 1, color: c.text }]}>
              {job.name}
            </Text>
            {prCheckFailed(job.state) && (
              <CitationActions
                quote={prCitation(snapshot, "job", job.id, `${job.name}: ${job.state}`, { url: job.url })}
              />
            )}
            <CiActions
              snapshot={snapshot}
              runId={runId}
              state={pages.current?.run?.state ?? job.state}
              jobId={job.id}
              name={job.name}
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
        >
          <CiActions
            snapshot={snapshot}
            runId={runId}
            state={pages.current?.run?.state ?? "unknown"}
            jobId={jobId}
            name={pages.current?.jobs.find((job) => job.id === jobId)?.name ?? ""}
            beforeChoose={(choose) => {
              pendingLogAction.current = choose;
              setLogVisible(false);
            }}
          />
        </PullRequestLog>
      )}
    </View>
  );
}
