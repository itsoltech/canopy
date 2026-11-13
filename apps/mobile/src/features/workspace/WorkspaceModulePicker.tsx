import { useState } from "react";
import { workspaceModules } from "@canopy/domain/workspace-modules";
import type { Workspace } from "@canopy/domain/workspace";
import { PickerSheet } from "../../ui/Picker";
import { IconButton } from "../../ui/components";

export function WorkspaceModulePicker({ view, sidebar = false }: { view: Workspace; sidebar?: boolean }) {
  const [open, setOpen] = useState(false);
  const title = sidebar ? "Open sidebar module" : "Open module";

  return (
    <>
      <IconButton icon="plus" label={title} onPress={() => setOpen(true)} />
      <PickerSheet
        title={title}
        visible={open}
        onClose={() => setOpen(false)}
        sections={[{ options: workspaceModules.map((module) => ({ value: module.id, label: module.label })) }]}
        onSelect={(id) => {
          const module = workspaceModules.find((module) => module.id === id);

          if (module) {
            const target = { module: module.id, resource: "" };

            if (sidebar) view.setSidebar(target);
            else view.openModule(target);
          }

          setOpen(false);
        }}
      />
    </>
  );
}
