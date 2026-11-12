import { useState } from "react";
import { View } from "react-native";
import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button, Notice } from "../../ui/components";
import { PickerSheet } from "../../ui/Picker";

export function RepositoryAccountSwitch({
  repositoryName,
  accountId,
  disabled,
  onchanged,
}: {
  repositoryName: string;
  accountId: string;
  disabled: boolean;
  onchanged: () => void;
}) {
  const { client, queries } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const node = splitId(accountId).node;
  const homeId = node ? `${GITHUB_HOME}~${node}` : "";
  const key = `GitHubRepositoryAccount:${homeId}:${repositoryName}`;
  const read = useSharedQuery(key, () => client!.api.getGitHubRepositoryAccount({ homeId, repositoryName }), !!client);

  async function choose(id: string) {
    if (!client || !read.data || busy) return;
    setOpen(false);
    setBusy(true);
    setError("");

    try {
      queries.set(
        key,
        await client.api.setGitHubRepositoryAccount({
          homeId,
          repositoryName,
          accountId: id,
          expectedRevision: read.data.revision,
        }),
      );
      onchanged();
    } catch {
      setError("Could not change this account. Refresh, then retry.");
    } finally {
      setBusy(false);
    }
  }

  if (!read.data || read.data.candidates.length < 2) return null;

  return (
    <View style={{ gap: 4 }}>
      <Button
        title={read.data.candidates.find((a) => a.id === read.data?.accountId)?.login ?? "GitHub account"}
        label="GitHub account"
        size="sm"
        variant="ghost"
        disabled={disabled || busy}
        onPress={() => setOpen(true)}
      />
      {!!error && <Notice error>{error}</Notice>}
      <PickerSheet
        title="GitHub account"
        visible={open}
        onClose={() => setOpen(false)}
        value={read.data.accountId}
        sections={[{ options: read.data.candidates.map((a) => ({ value: a.id, label: a.login })) }]}
        onSelect={(id) => void choose(id)}
      />
    </View>
  );
}
