import { useLocalSearchParams } from "expo-router";
import { ThreadScreen } from "../../../features/threads/ThreadScreen";

export default function ThreadRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return <ThreadScreen key={id} id={id} />;
}
