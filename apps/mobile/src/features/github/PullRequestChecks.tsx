import { useCallback, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { Text, View } from "react-native";
import { github } from "@canopy/contracts";
import { checksSummary, sortedChecks } from "@canopy/domain/github-pr";
import { useSession } from "../../state/session";
import { useColors, useTypography } from "../../ui/theme";
import { Button } from "../../ui/components";
import { usePages } from "./usePages";
import { PageStatus } from "./PageStatus";
import { PullRequestCheckRow } from "./PullRequestCheckRow";

export function PullRequestChecks({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const id = snapshot.summary?.ref?.id ?? "";
  const headSha = snapshot.summary?.headSha ?? "";
  const [visible, setVisible] = useState(5);

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestChecks({ pullRequestId: id, headSha, cursor, refresh }),
      [client, id, headSha],
    ),
    id,
  );

  const checks = sortedChecks(pages.pages.length ? pages.pages.flatMap((p) => p.checks) : snapshot.checks);

  async function more() {
    if (visible < checks.length) setVisible(checks.length);
    else {
      await pages.read(true);
      setVisible((value) => value + 50);
    }
  }

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
        <Text style={[type.meta, { color: c.muted }]}>on {headSha.slice(0, 7)}</Text>
      </View>
      {checks.slice(0, visible).map((check, i) => (
        <PullRequestCheckRow key={`${check.nodeId}:${check.name}:${i}`} id={id} check={check} />
      ))}
      {(visible < checks.length || !!pages.current?.page?.nextCursor) && (
        <Button
          title={visible < checks.length ? `Show ${checks.length - visible} more checks` : "Show more checks"}
          variant="ghost"
          disabled={pages.busy}
          onPress={() => void more()}
        />
      )}
      <PageStatus
        page={pages.current?.page}
        busy={pages.busy}
        error={pages.error}
        retry={() => void pages.read(false, true)}
      />
    </View>
  );
}
