import { create } from "@bufbuild/protobuf";
import { ImportSecretValueSchema, type ImportSecretValue, type ReadImportSecret } from "@canopy/contracts";
import { CommandError } from "../runtime/host-types.ts";
import { claudeServers, codexServers, literalHeader, parseFragment, serverDigest } from "./library-mcp.ts";
import { libraryPlace, readConfig } from "./library-scan.ts";
import type { WorkerImport } from "./service.ts";
import { SourceKeyError, verifySourceKey } from "./source-key.ts";

/**
 * One secret header of an MCP server, read only when the owner chose it (docs/import.md, "Serwery MCP"). The
 * request carries the gateway's one-time confirmation token, which goes back with the value; the key must name a
 * connector this worker listed, its definition must be as scanned, and the header must hold a value in the file
 * (one that names an environment variable is never resolved). Never remembered, never logged; errors name no value.
 */
export function readImportSecret(service: WorkerImport, request: ReadImportSecret): ImportSecretValue {
  if (request.confirmation.length < 32)
    throw new CommandError("IMPORT_SECRET", "a secret is read only with the owner's confirmation", false);

  try {
    const { root, rel } = verifySourceKey(service.key, service.libraryRoots(), request.sourceKey);

    if (libraryPlace(root.agentCli, rel) !== "mcp") throw new SourceKeyError("the source is not an MCP server");
    const [file = "", fragment = ""] = rel.split("#mcp/");
    const where = parseFragment(fragment);

    if (!where) throw new SourceKeyError("the source is not an MCP server");
    const config = readConfig(root, file);
    const servers = root.agentCli === "claude" ? claudeServers(config) : codexServers(config);
    const server = servers.find((s) => s.scope === where.scope && s.name === where.name);

    if (!server || serverDigest(server) !== request.digest)
      throw new CommandError("IMPORT_CHANGED", "the server changed since the scan; scan again", false);
    const slot = server.slots.find((s) => s.name === request.slot);

    if (slot?.kind !== "literal")
      throw new CommandError("IMPORT_SECRET", "this header has no value in the file", false);
    const value = literalHeader(root.agentCli, config, where.scope, where.name, request.slot);

    if (value === undefined) throw new CommandError("IMPORT_SECRET", "this header has no value in the file", false);

    return create(ImportSecretValueSchema, { confirmation: request.confirmation, value });
  } catch (cause) {
    if (cause instanceof SourceKeyError) throw new CommandError("IMPORT_SOURCE", cause.message, false);
    throw cause;
  }
}
