import { useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { IconButton, Button } from "../../ui/Button";
import { Overlay } from "../../ui/Overlay";
import { SheetCloseButton, SheetDragArea } from "../../ui/SheetDragArea";
import { SheetContent } from "../../ui/components";
import { CompactControls } from "../../ui/density";
import { styles, useColors } from "../../ui/theme";
import { StatusDot } from "../../ui/Badge";
import { AppUpdateStatus } from "../settings/AppUpdateStatus";
import { openSettingsSection } from "../settings/navigation";
import { useUpdates } from "./state";
import { bulkUpdatesAvailable, updatesAvailable, updatesRunning } from "./model";
import { UpdateRows } from "./UpdateRows";
import { CliUpdates } from "./CliUpdates";
import { UpdateFeedback, UpdateRun } from "./UpdateSummary";
import { usePhoneUpdates } from "./phone";
import { useWhatsNew } from "./whats-new";

/** The third sidebar action, like the web update center. Its 44 dp slot stays reserved in every state. */
export function UpdateCenterButton() {
  const { snapshot, setOpen } = useUpdates();
  const phone = usePhoneUpdates();

  const available = Boolean(
    (snapshot && updatesAvailable(snapshot)) || phone.status.isUpdateAvailable || phone.status.isUpdatePending,
  );

  const running = Boolean((snapshot && updatesRunning(snapshot)) || phone.busy);

  return (
    <View>
      <IconButton
        icon={running ? "arrow-path" : "arrow-up"}
        label={running ? "Show update progress" : available ? "Show available updates" : "Show updates"}
        onPress={() => setOpen(true)}
      />
      {(available || running) && (
        <View pointerEvents="none" style={{ position: "absolute", top: 7, right: 7 }}>
          <StatusDot tone={running ? "amber" : "sky"} active={running} />
        </View>
      )}
    </View>
  );
}

export function UpdateCenter() {
  const { snapshot, open, setOpen, pending, manage } = useUpdates();
  const phone = usePhoneUpdates();
  const destination = useRef<"settings" | "notes" | undefined>(undefined);
  const notes = useWhatsNew();
  const c = useColors();
  const busy = !!pending || snapshot?.run?.state === "running";

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
          <SheetDragArea style={[styles.row, { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }]}>
            <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.strong, flex: 1 }]}>
              Updates
            </Text>
            {snapshot && (bulkUpdatesAvailable(snapshot) || snapshot.run?.state === "running") && (
              <Button
                title={snapshot.run?.state === "running" ? "Show update progress" : "Update all"}
                size="sm"
                disabled={!!pending}
                onPress={() => void manage({ action: "update_all" })}
              />
            )}
            <IconButton
              icon="arrow-path"
              label="Check now"
              size="sm"
              disabled={busy || phone.busy}
              onPress={() => {
                void phone.check();
                void manage({ action: "check" });
              }}
            />
            <SheetCloseButton label="Close updates" />
          </SheetDragArea>
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <UpdateFeedback />
            {snapshot && (
              <>
                <UpdateRun run={snapshot.run} />
                <UpdateRows snapshot={snapshot} pending={busy} manage={(request) => void manage(request)} />
                <CliUpdates snapshot={snapshot} disabled={busy} />
              </>
            )}
            <AppUpdateStatus compact />
          </ScrollView>
          <View style={{ borderTopWidth: 1, borderColor: c.line, paddingHorizontal: 16, paddingVertical: 8 }}>
            <Button
              title="What's new"
              variant="ghost"
              size="sm"
              onPress={() => {
                destination.current = "notes";
                setOpen(false);
              }}
            />
            <Button
              title="Open update settings"
              variant="ghost"
              size="sm"
              onPress={() => {
                destination.current = "settings";
                setOpen(false);
              }}
            />
          </View>
        </CompactControls.Provider>
      </SheetContent.Provider>
    </Overlay>
  );
}
