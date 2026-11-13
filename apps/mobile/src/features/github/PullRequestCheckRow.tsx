import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { checkLook } from "@canopy/domain/github-pr";
import { safeHref } from "@canopy/domain/markdown";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/components";
import { Markdown } from "../../ui/markdown/Markdown";
import { useColors, useTypography } from "../../ui/theme";
import { PullRequestJobs } from "./PullRequestJobs";
import { CheckStateIcon } from "./CheckStateIcon";
import { toast } from "../../ui/Toast";
import { CiActions } from "./CiActions";
import { prCitation, prCheckFailed } from "@canopy/domain";

export function PullRequestCheckRow({
  snapshot,
  check,
}: {
  snapshot: github.PullRequestSnapshot;
  check: github.PullRequestCheck;
}) {
  const c = useColors();
  const type = useTypography();
  const look = checkLook(check.state);
  const [open, setOpen] = useState(false);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${check.name}, ${check.provider}, ${look.label}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          onLongPress={() => toast(look.label)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
            minHeight: 48,
            backgroundColor: pressed ? c.pressed : undefined,
          })}
        >
          <CheckStateIcon look={look} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={2} style={[type.small, { color: c.text }]}>
              {check.name}
            </Text>
            <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
              {check.provider}
            </Text>
          </View>
          <Icon name={open ? "chevron-down" : "chevron-right"} />
        </Pressable>
        <CiActions
          snapshot={snapshot}
          runId={check.runId}
          state={check.state}
          name={check.name}
          quote={
            prCheckFailed(check.state)
              ? prCitation(
                  snapshot,
                  "check",
                  check.nodeId || check.url || check.name,
                  `${check.name}: ${check.state}${check.output ? `\n\n${check.output}` : ""}`,
                  { author: check.provider, url: check.url },
                )
              : undefined
          }
        />
      </View>
      {open && (
        <>
          {check.runId ? (
            <PullRequestJobs snapshot={snapshot} runId={check.runId} />
          ) : (
            !!check.output && <Markdown text={check.output} />
          )}
          {!!safeHref(check.url) && (
            <Button
              title="Open check on provider"
              variant="ghost"
              onPress={() => void Linking.openURL(safeHref(check.url)!)}
            />
          )}
        </>
      )}
    </View>
  );
}
