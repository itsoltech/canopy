import { useCallback, useState, useRef } from "react";
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

export function PullRequestJobs({ id, runId }: { id: string; runId: string }) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const [jobId, setJob] = useState("");

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestCheckJobs({ pullRequestId: id, resourceId: runId, cursor, refresh }),
      [client, id, runId],
    ),
    id,
  );

  const latest = useRef(pages);
  latest.current = pages;
  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(() => {
        const current = latest.current;

        if (
          AppState.currentState === "active" &&
          current.current?.jobs.some((job) => ["queued", "in_progress", "pending", "waiting"].includes(job.state))
        )
          void current.read(false, true);
      }, 15_000);

      return () => clearInterval(timer);
    }, []),
  );

  return (
    <View style={{ gap: 8, padding: 8 }}>
      {pages.current?.jobs.map((job) => {
        const look = checkLook(job.state);

        return (
          <View key={job.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name={look.icon} label={look.label} color={toneColor(c, look.tone)} />
            <Text numberOfLines={2} style={[type.small, { flex: 1, color: c.text }]}>
              {job.name}
            </Text>
            <Button title="View logs" variant="ghost" onPress={() => setJob(job.id)} />
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
      {!!jobId && <PullRequestLog id={id} jobId={jobId} onClose={() => setJob("")} />}
    </View>
  );
}
