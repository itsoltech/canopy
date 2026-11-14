import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import type { github } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { checkLook, unknownPullRequestLook } from "@canopy/domain/github-pr";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { toast } from "../../ui/Toast";
import { useWorkspace } from "../workspace/context";
import { PullRequestStatus } from "./PullRequestStatus";
import { CheckStateIcon } from "./CheckStateIcon";

/** One linked pull request: its last known summary, or why its details are missing, with Retry. */
export function LinkedPullRequestRow({
  link,
  threadId,
  stale,
  onClose,
  onRetry,
}: {
  link: { summary?: github.PullRequestSummary | undefined; currentBranch: boolean; detail?: string };
  threadId: string;
  stale: boolean;
  onClose: () => void;
  onRetry: (id: string) => Promise<void>;
}) {
  const c = useColors(),
    pr = link.summary;

  const workspace = useWorkspace();
  const [retrying, setRetrying] = useState(false);

  if (!pr?.ref) return null;
  const ref = pr.ref;
  const known = pr.state !== "unavailable";
  const detail = link.detail ?? "";
  const unknown = unknownPullRequestLook(detail);
  const checks = checkLook(pr.checksState);
  const status = known ? `${pr.state}, checks ${checks.label}` : unknown.label;

  return (
    <View style={{ minWidth: 0 }}>
      <Pressable
        onLongPress={() => toast(status)}
        accessibilityRole="button"
        accessibilityLabel={`${known ? pr.title : `${ref.repositoryName} #${ref.number}`}, ${status}`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 48,
          borderRadius: 8,
          paddingHorizontal: 4,
          backgroundColor: pressed ? c.pressed : link.currentBranch ? c.well : undefined,
        })}
        onPress={() => {
          onClose();

          if (workspace)
            workspace.openModule({
              module: "pull-requests",
              resource: ref.id,
              label: `#${ref.number} · ${pr.title || ref.repositoryName}`,
            });
          else router.push({ pathname: "/pull-request/[id]", params: { id: ref.id, threadId } });
        }}
      >
        {known ? <PullRequestStatus state={pr.state} iconOnly /> : <CheckStateIcon look={unknown} />}
        <Text numberOfLines={1} style={[styles.chrome, { flex: 1, color: known ? c.text : c.muted }]}>
          {known ? pr.title : unknown.label}
        </Text>
        <Text style={[styles.chromeMeta, { color: c.muted }]}>#{ref.number}</Text>
        {known ? (
          <CheckStateIcon look={checks} label={`Checks: ${checks.label}`} />
        ) : (
          <View style={{ width: 16, height: 16 }} />
        )}
      </Pressable>
      {detail ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
          <Text style={[styles.meta, { flex: 1, color: c.muted }]}>
            {detail}
            {known && pr.verifiedAt ? ` Last verified ${timestampDate(pr.verifiedAt).toLocaleString()}.` : ""}
          </Text>
          <Button
            size="sm"
            title="Retry"
            disabled={retrying}
            onPress={() => {
              setRetrying(true);
              void onRetry(ref.id).finally(() => setRetrying(false));
            }}
          />
        </View>
      ) : (
        stale &&
        pr.verifiedAt && (
          <Text style={[styles.meta, { color: c.muted }]}>
            Last verified {timestampDate(pr.verifiedAt).toLocaleString()}
          </Text>
        )
      )}
    </View>
  );
}
