import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { font, useColors, useTypography } from "../../ui/theme";
import { confirmAction } from "./resource";
import { SettingsActions, SettingsGroup } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";

type Suggestion = ui.MemoryHabitSuggestion;

const evidenceLabel = (count: number) => `${count.toLocaleString()} ${count === 1 ? "example" : "examples"}`;

export function MemoryHabitRow({ suggestion, onPress }: { suggestion: Suggestion; onPress: () => void }) {
  const c = useColors();
  const type = useTypography();

  const metadata = [
    suggestion.suspended ? "Suspended" : "",
    evidenceLabel(suggestion.evidenceCount),
    suggestion.projectName,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={suggestion.rule}
      accessibilityValue={{ text: metadata }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        minHeight: 44,
        gap: 8,
        backgroundColor: pressed ? c.pressed : "transparent",
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text numberOfLines={3} style={[type.chrome, { color: c.text, fontFamily: font.medium }]}>
          {suggestion.rule}
        </Text>
        <Text numberOfLines={2} style={[type.meta, { color: c.muted }]}>
          {metadata}
        </Text>
      </View>
      <Icon name="chevron-right" color={c.faint} />
    </Pressable>
  );
}

export function MemoryHabitReview({
  visible,
  suggestion,
  onResolve,
  onReload,
  onClose,
}: {
  visible: boolean;
  suggestion: Suggestion;
  onResolve: (approve: boolean, rule: string) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const [rule, setRule] = useState(suggestion.rule);
  const [busy, setBusy] = useState<"approve" | "reject">();
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const resolving = useRef(false);

  async function resolve(approve: boolean) {
    if (resolving.current || stale || (approve && !rule.trim())) return;
    resolving.current = true;
    setBusy(approve ? "approve" : "reject");
    setError("");

    try {
      await onResolve(approve, rule.trim());
      onClose();
    } catch (cause) {
      const { code } = ConnectError.from(cause);

      if (code === Code.Aborted || code === Code.FailedPrecondition || code === Code.NotFound) {
        setStale(true);
        setError("This suggestion changed. Close it and refresh habits to review the latest suggestions.");
        await onReload();
      } else if (code === Code.InvalidArgument && approve) {
        setError("Could not approve this rule. Use up to 240 characters and try again.");
      } else if (approve && suggestion.suspended) {
        setError("Could not resume this habit. Check the connection and retry.");
      } else {
        setError(`Could not ${approve ? "approve" : "reject"} this suggestion. Check the connection and retry.`);
      }
    } finally {
      resolving.current = false;
      setBusy(undefined);
    }
  }

  const blocked = stale || Boolean(busy);

  return (
    <Sheet
      title="Review suggestion"
      visible={visible}
      onClose={onClose}
      footer={
        <SettingsActions>
          <Button
            title="Reject"
            busy={busy === "reject"}
            disabled={blocked}
            onPress={() =>
              confirmAction(
                "Reject suggestion",
                "Canopy removes this suggestion and skips the same examples in future checks.",
                () => void resolve(false),
              )
            }
          />
          <Button
            title={suggestion.suspended ? "Resume habit" : "Approve"}
            variant="primary"
            busy={busy === "approve"}
            disabled={blocked || !rule.trim()}
            onPress={() => void resolve(true)}
          />
        </SettingsActions>
      }
    >
      <SettingsGroup>
        <SettingsValue title="Project" value={suggestion.projectName} />
        {suggestion.suspended && <SettingsValue title="Status" value="Suspended" />}
      </SettingsGroup>
      <Field
        label="Rule"
        value={rule}
        editable={!blocked}
        multiline
        returnKeyType="default"
        submitBehavior="newline"
        textAlignVertical="top"
        style={{ minHeight: 112 }}
        onChangeText={(value) => {
          setRule(value);
          setError("");
        }}
      />
      {error ? <Notice error>{error}</Notice> : null}
      <HabitEvidence suggestion={suggestion} disabled={Boolean(busy)} />
    </Sheet>
  );
}

function HabitEvidence({ suggestion, disabled }: { suggestion: Suggestion; disabled: boolean }) {
  const c = useColors();
  const type = useTypography();

  const threads = [
    ...new Map(suggestion.evidence.filter((item) => item.threadId).map((item) => [item.threadId, item])).values(),
  ];

  return (
    <SettingsGroup title={evidenceLabel(suggestion.evidenceCount)}>
      {threads.length ? (
        threads.map((thread) => (
          <Pressable
            key={thread.threadId}
            accessibilityRole="link"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => router.push(`/thread/${thread.threadId}`)}
            style={({ pressed }) => ({
              minHeight: 44,
              alignItems: "center",
              flexDirection: "row",
              gap: 8,
              backgroundColor: pressed ? c.pressed : "transparent",
            })}
          >
            <Text numberOfLines={2} style={[type.chrome, { color: c.accent, flex: 1 }]}>
              {thread.title || "Untitled thread"}
            </Text>
            <Icon name="chevron-right" color={c.faint} />
          </Pressable>
        ))
      ) : (
        <Text style={[type.chrome, { color: c.muted }]}>No source threads available</Text>
      )}
    </SettingsGroup>
  );
}
