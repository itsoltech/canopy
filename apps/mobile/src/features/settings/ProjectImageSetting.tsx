import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { Button, IconButton, Notice } from "../../ui/components";
import { ProjectMark } from "../../ui/ProjectMark";
import type { ProjectResource } from "./ProjectDefaults";
import { SettingsRow } from "./SettingsGroup";
import { pickProjectImage } from "./project-image-picker";
import { confirmAction } from "./resource";

export function ProjectImageSetting({ project, resource }: { project: ui.Project; resource: ProjectResource }) {
  const picking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasImage = Boolean(project.imageBase64);
  const disabled = busy || resource.busy;

  async function save(image: Uint8Array) {
    setError("");
    await resource.run(
      (api) => api.setProjectImage({ projectId: project.id, image }),
      "",
      (cause) => {
        const { code } = ConnectError.from(cause);

        if (code === Code.Unimplemented) setError("Update the gateway to change the project image.");
        else if (code === Code.InvalidArgument && image.byteLength)
          setError("Canopy could not use this crop. Choose another PNG, JPEG or WebP image.");
        else setError("Canopy could not update the project image. Check the connection and try again.");
      },
    );
  }

  async function choose() {
    if (picking.current || resource.busy) return;

    picking.current = true;
    setBusy(true);
    setError("");

    try {
      const result = await pickProjectImage();

      if (!result) return;

      if ("error" in result) setError(result.error);
      else await save(result.image);
    } finally {
      picking.current = false;
      setBusy(false);
    }
  }

  return (
    <SettingsRow
      title="Project image"
      description="Crop an image to a square for the sidebar, project pickers and thread headers."
      control={
        <View style={s.controls}>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <ProjectMark project={project} size={32} />
          </View>
          <View style={s.choose}>
            <Button
              title={hasImage ? "Change image" : "Add image"}
              disabled={disabled}
              busy={busy}
              onPress={() => void choose()}
              style={s.chooseButton}
            />
          </View>
          {hasImage && (
            <IconButton
              icon="trash"
              label="Remove project image"
              disabled={disabled}
              onPress={() =>
                confirmAction(
                  "Remove image",
                  "Canopy shows the project initials again.",
                  () => void save(new Uint8Array()),
                )
              }
            />
          )}
        </View>
      }
    >
      {error ? <Notice error>{error}</Notice> : null}
    </SettingsRow>
  );
}

const s = StyleSheet.create({
  controls: { flexDirection: "row", alignItems: "center", gap: 8 },
  choose: { minWidth: 0, flexShrink: 1 },
  chooseButton: { alignSelf: "flex-start" },
});
