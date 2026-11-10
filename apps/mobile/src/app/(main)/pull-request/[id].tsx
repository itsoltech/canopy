import { useLocalSearchParams } from "expo-router";
import { PullRequestScreen } from "../../../features/github/PullRequestScreen";

export default function PullRequestRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return <PullRequestScreen key={id} id={id} />;
}
