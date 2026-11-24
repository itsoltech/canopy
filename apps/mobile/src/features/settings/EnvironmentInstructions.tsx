import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { EnvironmentActionMenu } from "./EnvironmentActionMenu";
import { EnvironmentRow, EnvironmentRows } from "./EnvironmentRows";
import { environmentItemStatus } from "./environment-item-status";

export function EnvironmentInstructions({
  documents,
  workers,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  documents: ui.InstructionDocument[];
  workers: ui.EnvironmentWorker[];
  busy: boolean;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ alignItems: "flex-end" }}>
        <Button title="Add document" variant="text" size="sm" icon="plus" onPress={onAdd} />
      </View>
      <EnvironmentRows>
        {!documents.length && (
          <EnvironmentRow
            title="No instructions yet"
            description="Add a document and assign it to the computers that should use it."
            wrapDescription
          />
        )}
        {documents.map((document) => {
          const { status, computers, note } = environmentItemStatus(
            document,
            workers,
            "instructions",
            document.harness,
          );

          const fragments = document.fragments.length;

          const description = [
            document.harness === "claude" ? "CLAUDE.md" : "AGENTS.md",
            `v${document.revision}`,
            `${fragments} ${fragments === 1 ? "fragment" : "fragments"}`,
            computers,
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <EnvironmentRow
              key={document.id}
              title={document.name}
              description={description}
              status={status}
              warning={status === "Error"}
              onPress={() => onEdit(document.id)}
              actions={
                <EnvironmentActionMenu
                  title={document.name}
                  label={`Actions for ${document.name}`}
                  disabled={busy}
                  note={`${description}\n${note}`}
                  actions={[
                    { label: "Edit document", icon: "pencil-square", onPress: () => onEdit(document.id) },
                    { label: "Delete document", icon: "trash", tone: "danger", onPress: () => onDelete(document.id) },
                  ]}
                />
              }
            />
          );
        })}
      </EnvironmentRows>
    </View>
  );
}
