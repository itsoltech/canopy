import { useState } from "react";
import { Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";

export function GitHubInstallation({
  accountId,
  installation,
}: {
  accountId: string;
  installation: github.GitHubInstallation;
}) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<github.GitHubRepository[]>([]);
  const [next, setNext] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  async function load(page = 0) {
    if (!client || busy) return;
    setBusy(true);
    setError("");

    try {
      const result = await client.api.listGitHubRepositories({
        accountId,
        installationId: installation.installationId,
        page,
      });

      setRepos((previous) => (page ? [...previous, ...result.repositories] : result.repositories));
      setNext(result.nextPage);
      setLoaded(true);
    } catch {
      setError("Could not load repositories. Check access on GitHub, then retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      <Button
        size="sm"
        title={`${open ? "Hide" : "Show"} repositories: ${installation.login}${installation.suspended ? " · Suspended" : ""}`}
        onPress={() => {
          setOpen(!open);

          if (!loaded && !open) void load();
        }}
      />
      {open && (
        <View style={{ gap: 12, paddingLeft: 12 }}>
          <Button
            size="sm"
            title="Manage repositories"
            onPress={() =>
              void Linking.openURL(installation.manageUrl).catch(() =>
                setError("Could not open GitHub. Check your browser, then retry."),
              )
            }
          />
          {installation.suspended && (
            <Notice>This installation is suspended. Ask its administrator to restore access.</Notice>
          )}
          {repos.map((repo) => (
            <Text key={repo.repositoryId} style={[type.body, { color: c.text }]}>
              {repo.fullName}
              {repo.private ? " · Private" : " · Public"}
            </Text>
          ))}
          {loaded && !repos.length && !installation.suspended && (
            <Text style={[type.body, { color: c.muted }]}>
              No accessible repositories. Choose repositories on GitHub or ask an administrator for access.
            </Text>
          )}
          {busy && <Text style={[type.body, { color: c.muted }]}>Loading repositories…</Text>}
          {!!next && (
            <Button size="sm" title="Load more repositories" disabled={busy} onPress={() => void load(next)} />
          )}
          {!!error && (
            <View style={{ gap: 8 }}>
              <Notice error>{error}</Notice>
              <Button size="sm" title="Retry" onPress={() => void load()} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}
