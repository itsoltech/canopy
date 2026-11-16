import { useState } from "react";
import type { Workspace, WorkspaceTab, WorkspaceEntry } from "@canopy/domain/workspace";
import { fileTab, tabName, tabDirty, tabBusy } from "@canopy/domain/workspace-modules";
import { PickerSheet } from "../../ui/Picker";
import { WorkspaceClose } from "./WorkspaceClose";

export function WorkspaceTabActions({
  view,
  tab,
  onClose,
}: {
  view: Workspace;
  tab?: WorkspaceEntry;
  onClose: () => void;
}) {
  const [closing, setClosing] = useState<WorkspaceTab[]>([]);
  const [closingModules, setClosingModules] = useState<string[]>([]);

  return (
    <>
      <PickerSheet
        title={tab ? tabName(tab) : "Tab actions"}
        visible={Boolean(tab)}
        onClose={onClose}
        sections={[
          {
            options: [
              { value: "keep", label: "Keep tab" },
              { value: "up", label: "Move up" },
              { value: "down", label: "Move down" },
              { value: "close", label: "Close tab" },
              { value: "others", label: "Close other tabs" },
              { value: "saved", label: "Close saved tabs" },
            ],
          },
        ]}
        onSelect={(action) => {
          if (!tab) return;
          applyAction(view, tab, action, (entries) => {
            setClosing(entries.filter(fileTab));
            setClosingModules(entries.filter((entry) => entry.kind === "module").map((entry) => entry.id));
          });
          onClose();
        }}
      />
      <WorkspaceClose
        view={view}
        tabs={closing}
        onComplete={() => {
          for (const id of closingModules) view.close(id);
        }}
        onClose={() => {
          setClosing([]);
          setClosingModules([]);
        }}
      />
    </>
  );
}

function applyAction(view: Workspace, tab: WorkspaceEntry, action: string, confirm: (tabs: WorkspaceEntry[]) => void) {
  if (action === "keep") view.keep(tab.id);

  if (action === "up") view.move(tab.id, -1);

  if (action === "down") view.move(tab.id, 1);

  if (action === "close") {
    if (tabDirty(tab)) confirm([tab]);
    else view.close(tab.id);
  }

  if (action === "others") {
    const entries = view.tabs.filter((entry) => entry.id !== tab.id && !tabBusy(entry));

    if (entries.some(tabDirty)) confirm(entries);
    else for (const entry of entries) view.close(entry.id);
  }

  if (action === "saved") for (const entry of view.tabs) if (!tabDirty(entry)) view.close(entry.id);
}
