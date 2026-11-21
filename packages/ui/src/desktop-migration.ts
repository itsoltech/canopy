export interface DesktopMigrationTarget {
  kind: "move" | "join";
  invitation: string;
}

export interface DesktopMigrationApproval {
  reviewDigest: string;
  conflictChoices: Record<string, "source" | "target">;
  approvedSecretIds: readonly string[];
}

export interface DesktopMigrationReview {
  operationId: string;
  sourceNodeId: string;
  sourceOwnerUserId: string;
  targetOwnerUserId: string;
  archiveSha256: string;
  reviewDigest: string;
  counts: Record<string, number>;
  conflicts: readonly { id: string; table: string; sourceKey: string; targetKey: string }[];
  secrets: readonly { id: string; table: string; sourceKey: string }[];
  blockers: readonly { table: string; key: string; reason: string }[];
}

export interface DesktopMigrationStatus {
  phase: "idle" | "preparing" | "prepared" | "draining" | "fenced" | "activating" | "switching" | "completed" | "error";
  kind?: DesktopMigrationTarget["kind"];
  target?: string;
  canAbort: boolean;
  canRecover: boolean;
  error?: string;
  preparation?: {
    durationMs: number;
    databaseBytes?: number;
    routes?: string[];
    review?: DesktopMigrationReview;
    peers?: readonly { nodeId: string; name: string; online: boolean }[];
    selectedPeerIds?: readonly string[];
  };
}

export interface DesktopMigrationBridge {
  status(): Promise<DesktopMigrationStatus>;
  prepare(input: DesktopMigrationTarget): Promise<DesktopMigrationStatus>;
  activate(approval?: DesktopMigrationApproval, selectedPeerIds?: readonly string[]): Promise<DesktopMigrationStatus>;
  recover(): Promise<DesktopMigrationStatus>;
  abort(): Promise<DesktopMigrationStatus>;
}
