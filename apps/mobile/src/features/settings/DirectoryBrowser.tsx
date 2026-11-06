import { useState } from "react";
import { Button, Field, Notice } from "../../ui/components";
import { SettingsRow } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";

export function DirectoryBrowser({
  workerId,
  value,
  onChange,
}: {
  workerId: string;
  value: string;
  onChange: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const resource = useSettingsResource(`directory:${workerId}:${path}`, (api) => api.listDirectory({ workerId, path }));

  return (
    <ResourceState resource={resource}>
      <Field label="Directory path" value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} />
      <Button secondary title="Browse directory" disabled={!workerId} onPress={() => setPath(value)} />
      {resource.data && (
        <>
          <Button secondary title="Use this directory" onPress={() => onChange(resource.data!.path)} />
          <Button
            secondary
            title="Parent directory"
            onPress={() => setPath(resource.data!.path.replace(/[\\/][^\\/]+[\\/]?$/, "/"))}
          />
          {resource.data.entries.flatMap((entry) =>
            entry.isDir
              ? [
                  <SettingsRow
                    key={entry.name}
                    title={entry.name}
                    onPress={() => setPath(`${resource.data?.path}/${entry.name}`)}
                  />,
                ]
              : [],
          )}
          {!resource.data.entries.some((e) => e.isDir) && <Notice>No subdirectories here.</Notice>}
        </>
      )}
    </ResourceState>
  );
}
