import { useCallback, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { Text, View } from "react-native";
import { github } from "@canopy/contracts";
import { checksSummary, sortedChecks } from "@canopy/domain/github-pr";
import { useSession } from "../../state/session";
import { useColors, useTypography } from "../../ui/theme";
import { Button } from "../../ui/components";
import { usePages } from "./usePages";
import { PageControls } from "./PageControls";
import { PullRequestCheckRow } from "./PullRequestCheckRow";

export function PullRequestChecks({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const id = snapshot.summary?.ref?.id ?? "";
  const headSha = snapshot.summary?.headSha ?? "";
  const [expanded, setExpanded] = useState(false);

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestChecks({ pullRequestId: id, headSha, cursor, refresh }),
      [client, id, headSha],
    ),
    id,
  );

  const checks = sortedChecks(pages.current?.checks ?? snapshot.checks);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={[type.small, { color: c.text }]}>
          {checksSummary(
            create(github.PullRequestSnapshotSchema, {
              ...snapshot,
              checks: pages.pages.length ? pages.pages.flatMap((p) => p.checks) : snapshot.checks,
            }),
          )}
        </Text>
        <Text style={[type.meta, { color: c.muted }]}>{headSha.slice(0, 7)}</Text>
      </View>
      {(expanded ? checks : checks.slice(0, 5)).map((check, i) => (
        <PullRequestCheckRow key={`${check.nodeId}:${check.name}:${i}`} id={id} check={check} />
      ))}
      {checks.length > 5 && (
        <Button
          title={expanded ? "Show fewer checks" : `Show ${checks.length - 5} more checks`}
          variant="ghost"
          onPress={() => setExpanded(!expanded)}
        />
      )}
      <PageControls
        page={pages.current?.page}
        busy={pages.busy}
        error={pages.error}
        previous={pages.previous}
        next={() => void pages.read(true)}
        retry={() => void pages.read(false, true)}
      />
    </View>
  );
}
