import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { workspaceModule, workspaceModules } from "@canopy/domain/workspace-modules";
import { useWorkspace } from "./context";
import { WorkspaceModuleBody } from "./WorkspaceModule";
import { WorkspaceModulePicker } from "./WorkspaceModulePicker";
import type { ThreadState } from "../threads/ThreadScreen";
import { Button, Sheet } from "../../ui/components";

export function WorkspaceModules({
  state,
  visible,
  onClose,
}: {
  state: ThreadState;
  visible: boolean;
  onClose: () => void;
}) {
  const view = useWorkspace();

  if (!view) return null;

  return <ModulesSheet state={state} view={view} visible={visible} onClose={onClose} />;
}

function ModulesSheet({
  state,
  view,
  visible,
  onClose,
}: {
  state: ThreadState;
  view: NonNullable<ReturnType<typeof useWorkspace>>;
  visible: boolean;
  onClose: () => void;
}) {
  useSyncExternalStore(view.store.subscribe, view.store.getVersion);
  const selection = view.sidebar;
  const active = selection && workspaceModule(selection.module);

  return (
    <Sheet
      title={active?.label ?? "Modules"}
      visible={visible}
      onClose={onClose}
      scroll={selection?.module !== "files"}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <WorkspaceModulePicker view={view} sidebar />
        {selection && (
          <>
            <Button
              title="Open in tab"
              onPress={() => {
                view.openModule(selection);
                onClose();
              }}
            />
            <Button title="Close module" onPress={() => view.setSidebar()} />
          </>
        )}
      </View>
      {visible &&
        (selection ? (
          <WorkspaceModuleBody state={state} target={selection} onClose={onClose} />
        ) : (
          <View style={{ gap: 8 }}>
            {workspaceModules.map((module) => (
              <Button
                key={module.id}
                title={module.label}
                onPress={() => view.setSidebar({ module: module.id, resource: "" })}
              />
            ))}
          </View>
        ))}
    </Sheet>
  );
}
