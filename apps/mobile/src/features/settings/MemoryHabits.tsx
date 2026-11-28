import { useState } from "react";
import { Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { count } from "@canopy/domain/usage-report";
import { useSession } from "../../state/session";
import { Button, IconButton, Notice } from "../../ui/components";
import { SkeletonScope } from "../../ui/Skeleton";
import { useColors, useTypography } from "../../ui/theme";
import { useDateTime } from "./display";
import { MemoryHabitReview, MemoryHabitRow } from "./MemoryHabitReview";
import { MemoryReflectionSheet } from "./MemoryReflectionSheet";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSkeletonRows } from "./SettingsSkeleton";
import { MEMORY_HABITS, type useMemoryHabits } from "./memory-habits";

const defaultSettings = create(ui.MemoryReflectionSettingsSchema, { intervalMinutes: 1440 });

type HabitsSheet = { kind: "settings" } | { kind: "suggestion"; suggestion: ui.MemoryHabitSuggestion };

export function MemoryHabits({
  resource,
  onApproved,
}: {
  resource: ReturnType<typeof useMemoryHabits>;
  onApproved: () => void;
}) {
  const { client, queries } = useSession();
  const focused = useIsFocused();
  const c = useColors();
  const type = useTypography();
  const [sheet, setSheet] = useState<HabitsSheet>();

  const snapshot = resource.data;

  if (snapshot === null || !client) return null;
  const settings = snapshot?.settings ?? defaultSettings;
  const initialLoading = !resource.loaded && !resource.error;
  const reload = () => resource.reload().catch(() => undefined);
  const close = () => setSheet((current) => (current === sheet ? undefined : current));

  async function save(draft: ui.MemoryReflectionSettings) {
    if (!client || !snapshot) return;
    const saved = await client.api.updateMemoryReflection({ settings: draft });
    queries.set<ui.MemoryHabitsSnapshot | null>(MEMORY_HABITS, (current) => ({
      ...(current ?? snapshot),
      settings: saved,
    }));
    void reload();
  }

  async function resolve(suggestion: ui.MemoryHabitSuggestion, approve: boolean, rule: string) {
    if (!client || !snapshot) return;
    await client.api.resolveMemoryHabit({
      habitId: suggestion.id,
      expectedRevision: suggestion.revision,
      expectedNoteRevision: suggestion.noteRevision,
      approve,
      rule: approve ? rule : "",
    });
    queries.set<ui.MemoryHabitsSnapshot | null>(MEMORY_HABITS, (current) => {
      const latest = current ?? snapshot;

      return { ...latest, suggestions: latest.suggestions.filter(({ id }) => id !== suggestion.id) };
    });
    void reload();

    if (approve) onApproved();
  }

  return (
    <>
      <SkeletonScope loading={initialLoading}>
        <SettingsGroup
          title="Habits"
          actions={
            snapshot && !resource.error ? (
              <IconButton
                icon="arrow-path"
                label="Refresh habits"
                busy={resource.loading}
                onPress={() => void reload()}
              />
            ) : undefined
          }
        >
          {snapshot ? (
            <SettingsRow
              title="Learn from repeated requests"
              description="Canopy suggests habits based on messages in selected projects."
              control={<Button title="Configure habits" multiline onPress={() => setSheet({ kind: "settings" })} />}
            />
          ) : initialLoading ? (
            <SettingsSkeletonRows rows={1} controls />
          ) : null}
          {snapshot && <ReflectionStatus settings={settings} usage={snapshot.usage} />}
          {resource.error && (
            <View style={{ gap: 8 }}>
              <Notice error>Could not load habits. Check the connection.</Notice>
              <Button title="Retry" busy={resource.loading} onPress={() => void reload()} />
            </View>
          )}
        </SettingsGroup>
      </SkeletonScope>
      {snapshot && (
        <SettingsGroup title="Suggestions">
          {snapshot.suggestions.length ? (
            snapshot.suggestions.map((item) => (
              <MemoryHabitRow
                key={item.id}
                suggestion={item}
                onPress={() => setSheet({ kind: "suggestion", suggestion: item })}
              />
            ))
          ) : (
            <Text style={[type.chrome, { color: c.muted }]}>No suggestions to review</Text>
          )}
        </SettingsGroup>
      )}
      {snapshot && sheet?.kind === "settings" && (
        <MemoryReflectionSheet
          settings={settings}
          snapshot={snapshot}
          onSave={save}
          onReload={reload}
          onClose={close}
        />
      )}
      {sheet?.kind === "suggestion" && (
        <MemoryHabitReview
          key={sheet.suggestion.id}
          visible={focused}
          suggestion={sheet.suggestion}
          onResolve={(approve, rule) => resolve(sheet.suggestion, approve, rule)}
          onReload={reload}
          onClose={close}
        />
      )}
    </>
  );
}

const checkStates = new Map([
  ["running", "Checking…"],
  ["completed", "Completed"],
  ["succeeded", "Completed"],
  ["empty", "No eligible messages"],
  ["deferred", "Postponed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
  ["unknown", "Result unavailable"],
]);

function ReflectionStatus({
  settings,
  usage,
}: {
  settings: ui.MemoryReflectionSettings;
  usage?: ui.MemoryReflectionUsage;
}) {
  const date = useDateTime();
  const c = useColors();
  const type = useTypography();

  const lastCheck = [settings.lastRunAt && date(settings.lastRunAt.seconds), checkStates.get(settings.lastRunState)]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={{ gap: 4 }} accessibilityLiveRegion="polite">
      <Text style={[type.meta, { color: c.muted }]}>
        {settings.enabled
          ? settings.nextRunAt
            ? `Next check ${date(settings.nextRunAt.seconds)}`
            : "Habit checks on"
          : "Habit checks off"}
      </Text>
      {!!lastCheck && <Text style={[type.meta, { color: c.muted }]}>Last check {lastCheck}</Text>}
      <Text style={[type.meta, { color: c.muted }]}>
        Last 30 days · {usage ? formatUsage(usage) : "Usage unavailable"}
      </Text>
    </View>
  );
}

const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

function formatUsage({ attempts, inputTokens, outputTokens, reportedCostUsd }: ui.MemoryReflectionUsage) {
  const tokens = inputTokens + outputTokens;
  const attemptCount = `${count(BigInt(attempts))} ${attempts === 1 ? "attempt" : "attempts"}`;

  const reportedTokens = tokens
    ? `${count(tokens)} reported ${tokens === 1n ? "token" : "tokens"}`
    : "No reported tokens";

  if (reportedCostUsd === undefined) return `${attemptCount} · ${reportedTokens}`;

  const amount =
    reportedCostUsd > 0 && reportedCostUsd < 0.0001 ? `<${dollars.format(0.0001)}` : dollars.format(reportedCostUsd);

  return `${attemptCount} · ${reportedTokens} · ${amount} reported cost`;
}
