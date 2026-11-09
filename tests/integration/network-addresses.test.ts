import { describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { advertisedAddresses } from "../../apps/gateway/src/network/addresses.ts";

const address = (host: string, netmask = "255.255.255.0", internal = false): NetworkInterfaceInfo => ({
  address: host,
  netmask,
  internal,
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  cidr: null,
});

describe("advertised network interfaces", () => {
  test("macOS keeps physical LAN and tailnet but excludes bridges, VM networks and unrelated utun", () => {
    const detected = advertisedAddresses({
      lo0: [address("127.0.0.1", "255.0.0.0", true)],
      bridge100: [address("10.20.1.1")],
      bridge101: [address("10.20.2.0")],
      vmnet2: [address("10.20.3.1")],
      vmenet0: [address("10.20.7.1")],
      orb0: [address("10.20.4.1")],
      utun2: [address("10.20.5.1")],
      utun4: [address("100.64.0.9", "255.255.255.255")],
      awdl0: [address("169.254.1.2")],
      en0: [address("10.20.6.9"), address("10.20.6.0"), address("10.20.6.255")],
    });

    expect(detected).toEqual([
      { host: "10.20.6.9", interfaceName: "en0", kind: "lan" },
      { host: "100.64.0.9", interfaceName: "utun4", kind: "tailscale" },
    ]);
  });

  test("Linux excludes container networks, non-unicast and link-local while retaining LAN, VPN and public", () => {
    expect(
      advertisedAddresses({
        docker0: [address("10.30.1.1")],
        "br-example": [address("10.30.2.1")],
        br0: [address("10.30.8.1")],
        veth123: [address("10.30.3.1")],
        virbr0: [address("10.30.4.1")],
        cni0: [address("10.30.5.1")],
        eth0: [
          address("203.0.113.9"),
          address("169.254.1.2"),
          address("0.0.0.0"),
          address("224.0.0.1"),
          address("255.255.255.255"),
        ],
        wlan0: [address("10.30.6.9"), address("10.30.6.9")],
        tailscale0: [address("100.64.0.0", "255.255.255.255")],
        wg0: [address("10.30.7.1", "255.255.255.254")],
      }).map(({ host, kind }) => ({ host, kind })),
    ).toEqual([
      { host: "10.30.6.9", kind: "lan" },
      { host: "100.64.0.0", kind: "tailscale" },
      { host: "10.30.7.1", kind: "vpn" },
      { host: "203.0.113.9", kind: "public" },
    ]);
  });

  test("Windows excludes virtual adapters by their descriptive names", () => {
    expect(
      advertisedAddresses({
        "vEthernet (Default Switch)": [address("10.40.1.1")],
        "Ethernet adapter VMware Network Adapter VMnet8": [address("10.40.2.1")],
        "VirtualBox Host-Only Network": [address("10.40.3.1")],
        "Npcap Loopback Adapter": [address("10.40.4.1")],
        "Wi-Fi": [address("10.40.5.9")],
        Tailscale: [address("100.64.0.10", "255.255.255.255")],
      }).map((entry) => entry.host),
    ).toEqual(["10.40.5.9", "100.64.0.10"]);
  });

  test("subnet boundaries use the mask: /23, /25, /31 and /32 are not assumed to be /24", () => {
    expect(
      advertisedAddresses({
        en0: [
          address("10.50.2.0", "255.255.254.0"),
          address("10.50.3.255", "255.255.254.0"),
          address("10.50.3.0", "255.255.254.0"),
          address("10.50.4.128", "255.255.255.128"),
          address("10.50.4.255", "255.255.255.128"),
          address("10.50.4.129", "255.255.255.128"),
          address("10.50.5.0", "255.255.255.254"),
          address("10.50.5.1", "255.255.255.254"),
          address("10.50.6.0", "255.255.255.255"),
        ],
      }).map((entry) => entry.host),
    ).toEqual(["10.50.3.0", "10.50.4.129", "10.50.5.0", "10.50.5.1", "10.50.6.0"]);
  });
});
