import { useLocalSearchParams } from "expo-router";
import { ThreadStartingScreen } from "../../../features/new-thread/ThreadStartingScreen";

export default function ThreadStartingRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return <ThreadStartingScreen key={id} id={id} />;
}
