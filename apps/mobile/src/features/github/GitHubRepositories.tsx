import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Badge } from "../../ui/Badge";
import { Button, Notice } from "../../ui/components";
import { SearchField } from "../../ui/SearchField";
import { useColors, useTypography } from "../../ui/theme";
import type { AgentAccessTarget } from "./GitHubAgentAccess";
import { useGitHubRepositories } from "./useGitHubRepositories";

export function GitHubRepositories({
  accountId,
  installationId,
  onAccess,
}: {
  accountId: string;
  installationId: string;
  onAccess?: ((target: AgentAccessTarget) => void) | undefined;
}) {
  const c = useColors();
  const type = useTypography();
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const { repos, next, total, busy, error, load } = useGitHubRepositories(accountId, installationId);
  const matches = repos.filter((repo) => repo.fullName.toLowerCase().includes(query.trim().toLowerCase()));
  const shown = all || query ? matches : matches.slice(0, 5);

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      {total > 10 && (
        <SearchField
          label="Search repositories"
          placeholder="Search repositories…"
          value={query}
          onChange={(value) => {
            setQuery(value);

            if (next) load(true);
          }}
        />
      )}
      <ScrollView nestedScrollEnabled style={{ maxHeight: 288 }}>
        {shown.map((repo) => (
          <View key={repo.repositoryId} style={{ gap: 2, paddingVertical: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                numberOfLines={1}
                ellipsizeMode="middle"
                accessibilityLabel={repo.fullName}
                style={[type.chrome, { color: c.text, minWidth: 0, flex: 1 }]}
              >
                {repo.fullName}
              </Text>
              <Badge>{repo.private ? "Private" : "Public"}</Badge>
            </View>
            {onAccess && (
              <Button
                title="Edit agent access"
                label={`Edit agent access for ${repo.fullName}`}
                size="sm"
                variant="text"
                onPress={() => onAccess({ accountId, repositoryId: repo.repositoryId, repositoryName: repo.fullName })}
              />
            )}
          </View>
        ))}
      </ScrollView>
      {!shown.length && !busy && !error && (
        <Text style={[type.meta, { color: c.muted }]}>
          {query
            ? "No repositories match your search."
            : "No accessible repositories. Choose repositories on GitHub or ask an administrator for access."}
        </Text>
      )}
      {total > 5 && !query && (
        <Button
          title={all ? "Show fewer" : `Show all ${total}`}
          size="sm"
          variant="text"
          disabled={busy}
          onPress={() => {
            setAll(!all);

            if (!all && next) load(true);
          }}
        />
      )}
      {busy && (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted }]}>
          Loading repositories…
        </Text>
      )}
      {!!error && (
        <>
          <Notice error>{error}</Notice>
          <Button title="Retry" size="sm" onPress={() => load(Boolean(next))} />
        </>
      )}
    </View>
  );
}
