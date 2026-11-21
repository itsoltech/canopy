import { useRef, useState } from "react";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { snoozeDeadline, snoozePresets } from "@canopy/domain/thread-snooze";
import { Notice } from "../../ui/components";
import { PickerSheet } from "../../ui/Picker";
import { toast } from "../../ui/Toast";
import { useDateTime } from "../settings/display";
import { ScheduleDateSheet } from "../settings/ScheduleDate";

type SnoozeChoice = (typeof snoozePresets)[number]["value"] | "custom";

export function ThreadSnoozeSheet({
  thread,
  visible,
  disabled,
  busy,
  onClose,
  onSnooze,
}: {
  thread: ui.Thread;
  visible: boolean;
  disabled: boolean;
  busy: boolean;
  onClose: () => void;
  onSnooze: (until?: Date) => Promise<boolean>;
}) {
  const pending = useRef<SnoozeChoice | undefined>(undefined);
  const [custom, setCustom] = useState(false);
  const [dateSession, setDateSession] = useState(0);
  const [error, setError] = useState(false);
  const format = useDateTime();
  const failure = "Could not snooze the thread. Check the connection and retry.";
  const deadline = thread.snoozedUntil ? timestampDate(thread.snoozedUntil) : undefined;

  const note = thread.snoozed
    ? thread.snoozedUntil
      ? `Wakes ${format(thread.snoozedUntil.seconds)}.`
      : "Snoozed until you wake it."
    : undefined;

  return (
    <>
      <PickerSheet<SnoozeChoice>
        title={thread.snoozed ? "Change snooze" : "Snooze thread"}
        visible={visible}
        onClose={onClose}
        note={note}
        sections={[
          {
            options: [
              ...snoozePresets.map((preset) => ({ ...preset, disabled: busy || disabled })),
              { value: "custom", label: "Choose date and time…", disabled: busy || disabled },
            ],
          },
        ]}
        onSelect={(choice) => {
          pending.current = choice;
        }}
        onDismiss={() => {
          const choice = pending.current;
          pending.current = undefined;

          if (choice === "custom") {
            setError(false);
            setDateSession((before) => before + 1);
            setCustom(true);
          } else if (choice !== undefined) {
            void onSnooze(snoozeDeadline(choice)).then((saved) => {
              if (!saved) toast(failure);
            });
          }
        }}
      />
      {dateSession > 0 && (
        <ScheduleDateSheet
          key={dateSession}
          title="Wake at"
          visible={custom}
          initial={deadline}
          showZone
          actionLabel={thread.snoozed ? "Change snooze" : "Snooze thread"}
          busy={busy}
          disabled={disabled}
          onClose={() => setCustom(false)}
          onChoose={(date) => {
            setError(false);
            void onSnooze(date).then((saved) => {
              if (saved) setCustom(false);
              else setError(true);
            });
          }}
        >
          {error && <Notice error>{failure}</Notice>}
        </ScheduleDateSheet>
      )}
    </>
  );
}
