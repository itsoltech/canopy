import type { TestGateway } from "./gateway.ts";

export async function listArtifacts(api: TestGateway["api"], threadId: string) {
  return (await Array.fromAsync(api.listThreadArtifacts({ threadId }))).flatMap((batch) => batch.items);
}
