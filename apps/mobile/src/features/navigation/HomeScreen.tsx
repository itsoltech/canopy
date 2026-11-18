import { useState } from "react";
import { CreateBot } from "../bots/CreateBot";
import { Text, View } from "react-native";
import { ListSkeleton } from "../../ui/Skeleton";
import { Redirect } from "expo-router";
import { ScreenFrame } from "../../ui/ScreenFrame";
import { ScreenScroll } from "../../ui/ScreenScroll";
import { useLayout } from "../../state/layout";
import { useSession } from "../../state/session";
import { Button } from "../../ui/components";
import { SidebarToggle } from "./SidebarToggle";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { AppSidebar } from "./AppSidebar";

/** Phones: the thread list. Wide windows: the list is the sidebar, so the main pane waits for a choice. */
export default function HomeScreen() {
  const c = useColors();
  const layout = useLayout();
  const [creating, setCreating] = useState(false);
  const bots = layout.selectedModule === "bots";
  const { ready, session } = useSession();

  if (!ready) return <ListSkeleton />;

  if (!session) return <Redirect href="/pair" />;

  if (!layout.wide) return <AppSidebar />;

  return (
    <ScreenFrame
      header={
        <View style={[styles.row, { height: 48, paddingHorizontal: 4 }]}>
          <SidebarToggle />
        </View>
      }
    >
      <ScreenScroll
        space={24}
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 12 }}
      >
        <Icon name="chat-bubble-left-right" size={32} color={c.faint} />
        <Text style={[styles.body, { color: c.muted, textAlign: "center" }]}>
          {bots ? "Choose a bot to open its chat." : "Choose a thread to open it."}
        </Text>
        <View>
          <Button
            variant="primary"
            title={bots ? "Create bot" : "New thread"}
            onPress={() => (bots ? setCreating(true) : layout.open("/new-thread"))}
          />
        </View>
        {bots && creating && <CreateBot onClose={() => setCreating(false)} />}
      </ScreenScroll>
    </ScreenFrame>
  );
}
