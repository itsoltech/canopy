import { useRef } from "react";
import Reanimated from "react-native-reanimated";
import { ScrollView, Text, View } from "react-native";
import { IconButton, Button } from "../../ui/Button";
import { Overlay } from "../../ui/Overlay";
import { SheetCloseButton, SheetDragArea } from "../../ui/SheetDragArea";
import { SheetContent } from "../../ui/components";
import { CompactControls } from "../../ui/density";
import { styles, useColors } from "../../ui/theme";
import { useMotion } from "../../ui/motion";
import { StatusDot } from "../../ui/Badge";
import { AppUpdateStatus } from "../settings/AppUpdateStatus";
import { openSettingsSection } from "../settings/navigation";
import { useUpdates } from "./state";
import { bulkUpdatesAvailable, updatesAvailable, updatesRunning, type UpdateRequest } from "./model";
import { UpdateRows } from "./UpdateRows";
import { CliUpdates } from "./CliUpdates";
import { UpdateFeedback } from "./UpdateSummary";
import { sheetHeadline, type SheetHeadline } from "./headline";
import { usePhoneUpdates } from "./phone";
import { useWhatsNew } from "./whats-new";

/**
 * The third sidebar action, like the web update center. Its 44 dp slot stays reserved in every state. ⟳ stays Check
 * now's: the trigger shows the download tray, an amber dot while updating and a sky dot when something waits.
 */
export function UpdateCenterButton() {
  const { snapshot, setOpen, run } = useUpdates();
  const phone = usePhoneUpdates();

  const available = Boolean(
    (snapshot && updatesAvailable(snapshot)) || phone.status.isUpdateAvailable || phone.status.isUpdatePending,
  );

  const running = Boolean((snapshot && updatesRunning(snapshot)) || phone.busy);
  const failed = !running && !!run && ["failed", "blocked"].includes(run.state);

  return (
    <View>
      <IconButton
        icon={failed ? "exclamation-circle" : "arrow-down-tray"}
        label={
          running
            ? "Show update progress"
            : failed
              ? "Show failed updates"
              : available
                ? "Show available updates"
                : "Show updates"
        }
        onPress={() => setOpen(true)}
      />
      {(available || running) && !failed && (
        <View pointerEvents="none" style={{ position: "absolute", top: 7, right: 7 }}>
          <StatusDot tone={running ? "amber" : "sky"} active={running} />
        </View>
      )}
    </View>
  );
}

export function UpdateCenter() {
  const { snapshot, open, setOpen, pending, manage, optimistic, run, active } = useUpdates();
  const phone = usePhoneUpdates();
  const destination = useRef<"settings" | "notes" | undefined>(undefined);
  const notes = useWhatsNew();
  const starting = !!optimistic && !!pending && pending !== "check";
  const checking = pending === "check" || !!snapshot?.checking || phone.busy;
  const stopped = snapshot?.run && ["failed", "blocked"].includes(snapshot.run.state) ? snapshot.run : undefined;

  const headline = sheetHeadline({
    snapshot,
    run,
    starting,
    checking,
    phoneUpdate: phone.status.isUpdateAvailable || phone.status.isUpdatePending,
  });

  const primary: Primary | undefined = starting
    ? { title: "Starting…", busy: true }
    : run?.state === "running"
      ? { title: "Updating…", busy: true }
      : stopped
        ? { title: "Retry failed", request: { action: "retry_failed", desktopRequestId: stopped.id } }
        : snapshot && bulkUpdatesAvailable(snapshot)
          ? { title: "Update all", request: { action: "update_all" } }
          : undefined;

  return (
    <Overlay
      visible={open}
      onClose={() => setOpen(false)}
      label="Updates"
      onDismiss={() => {
        const next = destination.current;
        destination.current = undefined;

        if (next === "settings") openSettingsSection("app-updates");

        if (next === "notes") notes.show();
      }}
    >
      <SheetContent.Provider value={true}>
        <CompactControls.Provider value={true}>
          <SheetHeader
            headline={headline}
            checking={checking}
            pending={!!pending}
            check={() => {
              void phone.check();
              void manage({ action: "check" });
            }}
          />
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <UpdateFeedback />
            {snapshot && (
              <>
                <UpdateRows
                  snapshot={snapshot}
                  pending={active}
                  manage={(request, target) => void manage(request, target)}
                />
                <CliUpdates snapshot={snapshot} disabled={active} />
              </>
            )}
            <AppUpdateStatus compact />
          </ScrollView>
          <SheetFooter
            notes={notes.notice}
            primary={primary}
            pending={!!pending}
            go={(next) => {
              destination.current = next;
              setOpen(false);
            }}
            run={(request) => void manage(request)}
          />
        </CompactControls.Provider>
      </SheetContent.Provider>
    </Overlay>
  );
}

type Primary = { title: string; busy?: boolean; request?: UpdateRequest };

/** Title, the one summary line and Check now; the divider under it is the run's bar. */
function SheetHeader({
  headline,
  checking,
  pending,
  check,
}: {
  headline: SheetHeadline;
  checking: boolean;
  pending: boolean;
  check: () => void;
}) {
  const c = useColors();
  const m = useMotion();

  return (
    <>
      <SheetDragArea style={[styles.row, { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 4 }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.strong }]}>
            Updates
          </Text>
          <Reanimated.View key={headline.text} entering={m.swap.entering}>
            <Text
              numberOfLines={1}
              accessibilityLiveRegion="polite"
              style={[
                styles.overlayMeta,
                {
                  color: headline.tone === "rose" ? c.danger : headline.tone === "ink" ? c.text : c.muted,
                  fontVariant: ["tabular-nums"],
                },
              ]}
            >
              {headline.text}
            </Text>
          </Reanimated.View>
        </View>
        {/* Check never conflicts with a run, so it stays available; it only waits for itself. */}
        <IconButton
          icon="arrow-path"
          label="Check now"
          size="sm"
          busy={checking}
          disabled={checking || pending}
          onPress={check}
        />
        <SheetCloseButton label="Close updates" />
      </SheetDragArea>
      {/* The divider is the run's bar: no extra line, no space reserved for it. */}
      <View style={{ height: 1, backgroundColor: c.line }}>
        {headline.progress !== undefined && (
          <View
            style={{
              position: "absolute",
              left: 0,
              top: -0.5,
              height: 2,
              width: `${headline.progress}%`,
              backgroundColor: c.accent,
            }}
          />
        )}
      </View>
    </>
  );
}

/** Settings, What's new only when unseen, and one labelled primary action on the right. */
function SheetFooter({
  notes,
  primary,
  pending,
  go,
  run,
}: {
  notes: boolean;
  primary: Primary | undefined;
  pending: boolean;
  go: (next: "settings" | "notes") => void;
  run: (request: UpdateRequest) => void;
}) {
  const c = useColors();

  return (
    <View
      style={[
        styles.row,
        { borderTopWidth: 1, borderColor: c.line, paddingHorizontal: 16, paddingVertical: 8, gap: 4 },
      ]}
    >
      <Button title="Settings" variant="ghost" size="sm" onPress={() => go("settings")} />
      {notes && <Button title="What's new" variant="ghost" size="sm" onPress={() => go("notes")} />}
      {/* The primary action sits on the right, away from the links, so it appears without moving them. */}
      <View style={{ flex: 1 }} />
      {primary && (
        <Button
          title={primary.title}
          variant="primary"
          size="sm"
          busy={primary.busy}
          disabled={pending || !!primary.busy}
          onPress={() => primary.request && run(primary.request)}
        />
      )}
    </View>
  );
}
