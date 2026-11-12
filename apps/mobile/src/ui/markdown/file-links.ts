import { createContext, useContext } from "react";

/** Only a thread message supplies this handler; files never become external URLs. */
export const FileLinks = createContext<((path: string) => void) | undefined>(undefined);
export const useFileLinks = () => useContext(FileLinks);
