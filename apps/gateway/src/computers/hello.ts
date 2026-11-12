import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";

export const LEGACY_CAPABILITY_LIMIT = 32;
export const COMPUTER_CAPABILITY_LIMIT = 128;

/** Protocol-1 peers reject more than 32 entries in field 7, even when their own hello exceeds that limit. */
export function wireHello(hello: link.NodeHello): link.NodeHello {
  const capabilities = [...hello.capabilities, ...hello.additionalCapabilities];

  return create(link.NodeHelloSchema, {
    ...hello,
    capabilities: capabilities.slice(0, LEGACY_CAPABILITY_LIMIT),
    additionalCapabilities: capabilities.slice(LEGACY_CAPABILITY_LIMIT),
  });
}
