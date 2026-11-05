import { useLayout } from "../../state/layout";
import { IconButton } from "../../ui/components";

/** Wide windows: collapses or expands the thread list beside the open thread. */
export function SidebarToggle() {
  const layout = useLayout();

  if (!layout.wide) return null;

  return (
    <IconButton
      icon="bars-3"
      label={layout.sidebarOpen ? "Hide threads" : "Show threads"}
      onPress={layout.toggleSidebar}
    />
  );
}
