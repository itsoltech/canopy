import { useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { github } from "@canopy/contracts";
import { PullRequestChecks } from "./PullRequestChecks";
import { Markdown } from "../../ui/markdown/Markdown";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";

export function PullRequestSummary({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const c = useColors();
  const pr = snapshot.summary;
  const ref = pr?.ref;
  const [message, setMessage] = useState("");

  async function copy() {
    try {
      await Clipboard.setStringAsync(`gh pr checkout ${ref?.number}`);
      setMessage("Command copied");
    } catch {
      setMessage("Could not copy the command. Select it and copy it manually.");
    }
  }

  return (
    <View style={{ gap: 20, minWidth: 0 }}>
      <View style={{ gap: 10 }}>
        <Text selectable style={[styles.meta, { color: c.muted }]}>
          {ref?.repositoryName} #{ref?.number}
        </Text>
        <Text selectable accessibilityRole="header" style={[styles.heading, { color: c.text }]}>
          {pr?.title}
        </Text>
        <Text
          accessibilityLabel={`Pull request ${pr?.state}`}
          style={[
            styles.label,
            {
              color: c.text,
              backgroundColor: c.well,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 4,
              alignSelf: "flex-start",
            },
          ]}
        >
          {pr?.state ? pr.state[0]!.toUpperCase() + pr.state.slice(1) : "Unavailable"}
        </Text>
        <Text style={[styles.body, { color: c.text }]}>
          {snapshot.author} · Updated {pr?.updatedAt ? timestampDate(pr.updatedAt).toLocaleString() : "—"}
        </Text>
        <Text selectable style={[styles.body, { color: c.text }]}>
          {snapshot.baseRef} ← {snapshot.headRef}
        </Text>
        <Text style={[styles.meta, { color: c.text }]}>
          {snapshot.files} files · +{snapshot.additions} / −{snapshot.deletions}
        </Text>
        <Text selectable style={[styles.body, { color: c.text }]}>
          gh pr checkout {ref?.number}
        </Text>
        <Button size="sm" title="Copy command" onPress={() => void copy()} />
        <Text style={[styles.meta, { color: c.muted }]}>Run in {ref?.repositoryName}.</Text>
        <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted, minHeight: 20 }]}>
          {message || " "}
        </Text>
        {!!snapshot.detail && (
          <Notice>
            {snapshot.detail}{" "}
            {snapshot.stale
              ? `Last verified ${pr?.verifiedAt ? timestampDate(pr.verifiedAt).toLocaleString() : "—"}.`
              : ""}
          </Notice>
        )}
      </View>
      <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 16 }}>
        <Text accessibilityRole="header" style={[styles.label, { color: c.text }]}>
          Reviewers
        </Text>
        {snapshot.reviewers.length ? (
          snapshot.reviewers.map((r, i) => (
            <Text key={`${r.login}:${i}`} style={[styles.body, { color: c.text }]}>
              {r.login} · {r.state.replaceAll("_", " ")}
            </Text>
          ))
        ) : (
          <Text style={[styles.body, { color: c.muted }]}>No reviewers requested</Text>
        )}
        {!!snapshot.assignees.length && (
          <Text style={[styles.body, { color: c.text }]}>Assigned to {snapshot.assignees.join(", ")}</Text>
        )}
        {!!snapshot.labels.length && (
          <View accessibilityLabel="Labels" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {snapshot.labels.map((label, i) => (
              <Text
                key={`${label}:${i}`}
                style={[
                  styles.meta,
                  {
                    color: c.text,
                    backgroundColor: c.well,
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    maxWidth: "100%",
                  },
                ]}
              >
                {label}
              </Text>
            ))}
          </View>
        )}
      </View>
      <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 16 }}>
        <Text accessibilityRole="header" style={[styles.label, { color: c.text }]}>
          Description
        </Text>
        {snapshot.body ? (
          <Markdown text={snapshot.body} />
        ) : (
          <Text style={[styles.body, { color: c.muted }]}>No description provided</Text>
        )}
      </View>
      <PullRequestChecks snapshot={snapshot} />
    </View>
  );
}
