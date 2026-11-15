/** Workspace drags stay in this page and may only add a mention to their source thread. */
const FILE_TYPE = "application/x-canopy-workspace-file";

export interface WorkspaceFileDrag {
  readonly threadId: string;
  readonly path: string;
}

let active: (WorkspaceFileDrag & { readonly token: string }) | undefined;

export const isWorkspaceFileDrag = (data: DataTransfer | null): boolean => data?.types.includes(FILE_TYPE) ?? false;

export function startWorkspaceFileDrag(data: DataTransfer, threadId: string, path: string): void {
  active = { threadId, path, token: crypto.randomUUID() };
  data.effectAllowed = "copy";
  data.setData(FILE_TYPE, active.token);
  data.setData("text/plain", `@${path}`);
}

export function endWorkspaceFileDrag(): void {
  active = undefined;
}

/** Browsers hide the payload during hover; on drop it must also match this page's active session. */
export function workspaceFileDrag(
  data: DataTransfer | null,
  threadId: string | undefined,
  dropping = false,
): WorkspaceFileDrag | undefined {
  if (!data || !isWorkspaceFileDrag(data) || !threadId || active?.threadId !== threadId) return;
  const token = data.getData(FILE_TYPE);

  return token === active.token || (!dropping && !token) ? active : undefined;
}
