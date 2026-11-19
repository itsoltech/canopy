import { marketplaceReference as marketplace, parseSourceCommand as skill } from "@canopy/domain/source-command";
import { Code, ConnectError } from "@connectrpc/connect";

export function sourceInvalid(message: string): never {
  throw new ConnectError(message, Code.InvalidArgument);
}

function parse<A>(command: string, parser: (input: string) => A): A {
  try {
    return parser(command);
  } catch (error) {
    return sourceInvalid(error instanceof Error ? error.message : "Invalid source command.");
  }
}

export const marketplaceReference = (command: string) => parse(command, marketplace);
export const parseSourceCommand = (command: string) => parse(command, skill);
