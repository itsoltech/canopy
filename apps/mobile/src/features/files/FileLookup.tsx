import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { fileLookupMessage } from "@canopy/domain/thread-files";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";

export function FileLookup({
  file,
  name,
  onSelect,
}: {
  file: ui.ThreadFile;
  name: string;
  onSelect: (path: string) => void;
}) {
  const c = useColors();
  const [details, setDetails] = useState(false);

  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityLiveRegion="polite" style={[styles.body, { color: c.text }]}>
        {fileLookupMessage(name, file.resolution)}
      </Text>
      {file.searchIncomplete && (
        <Text style={[styles.body, { color: c.muted }]}>
          The search reached its limit. Open a full workspace-relative path.
        </Text>
      )}
      {file.matches.map((path) => (
        <Button key={path} title={path} label={`Open ${path}`} variant="ghost" onPress={() => onSelect(path)} />
      ))}
      {file.searchedPaths.length > 0 && (
        <View style={{ gap: 4 }}>
          <Button
            title={details ? "Hide searched paths" : "Show searched paths"}
            size="sm"
            variant="ghost"
            onPress={() => setDetails((shown) => !shown)}
          />
          {details &&
            file.searchedPaths.map((path, index) => (
              <Text key={index} selectable style={[styles.caption, { color: c.muted }]}>
                {path}
              </Text>
            ))}
        </View>
      )}
    </View>
  );
}
