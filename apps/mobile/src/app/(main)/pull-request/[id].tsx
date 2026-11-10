import { useLocalSearchParams } from "expo-router";
import { PullRequestScreen } from "../../../features/github/PullRequestScreen";

export default function PullRequestRoute() {
  const { id, threadId } = useLocalSearchParams<{ id: string; threadId?: string }>();

  return <PullRequestScreen key={id} id={id} threadId={threadId} />;
}
