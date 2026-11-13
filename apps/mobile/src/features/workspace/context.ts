import { createContext, useContext } from "react";
import type { Workspace } from "@canopy/domain/workspace";

export const WorkspaceContext = createContext<Workspace | undefined>(undefined);
export const useWorkspace = () => useContext(WorkspaceContext);
