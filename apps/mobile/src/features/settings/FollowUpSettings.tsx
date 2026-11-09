import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";

export function FollowUpSettings({ settings }: { settings: ReturnType<typeof useAppearance> }) {
  const [open, setOpen] = useState(false);

  const delivery =
    settings.user?.composer?.runningDelivery === ui.MessageDelivery.QUEUE
      ? ui.MessageDelivery.QUEUE
      : ui.MessageDelivery.STEER;

  return (
    <>
      <SettingsGroup title="Messages" description="Account">
        <SettingsRow
          title="When the agent is working, send messages as"
          description="Steer joins the current turn, while Queue waits for the next turn."
          control={
            <SelectField
              label="When the agent is working, send messages as"
              hideLabel
              value={delivery === ui.MessageDelivery.QUEUE ? "Queue" : "Steer"}
              onPress={() => setOpen(true)}
              disabled={!settings.user || settings.saving}
            />
          }
        />
      </SettingsGroup>
      <PickerSheet
        title="Send messages as"
        visible={open}
        onClose={() => setOpen(false)}
        value={delivery}
        onSelect={(runningDelivery) =>
          void settings.update({ composer: create(ui.ComposerSettingsSchema, { runningDelivery }) })
        }
        sections={[
          {
            options: [
              { value: ui.MessageDelivery.STEER, label: "Steer", description: "Joins the current turn." },
              { value: ui.MessageDelivery.QUEUE, label: "Queue", description: "Waits for the next turn." },
            ],
          },
        ]}
      />
    </>
  );
}
