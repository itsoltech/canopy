import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button } from "../../ui/components";
import { ConnectGitHub } from "./ConnectGitHub";

export function RepositoryAccessActions({ homeId, onconnected }: { homeId: string; onconnected: () => void }) {
  const { client } = useSession();

  const read = useSharedQuery(
    `GitHubAccessAccounts:${homeId}`,
    () => client!.api.listGitHubAccounts({ homeId }),
    !!client,
  );

  if (!read.data?.accounts.some((a) => a.status === "connected"))
    return <ConnectGitHub homeId={homeId} configured={read.data?.configured ?? true} onconnected={onconnected} />;

  return (
    <Button
      title="Manage access"
      size="sm"
      onPress={() => {
        if (read.data?.installUrl) void Linking.openURL(read.data.installUrl);
        else router.push({ pathname: "/settings/[section]", params: { section: "github" } });
      }}
    />
  );
}
