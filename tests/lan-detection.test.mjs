import test from "node:test";
import assert from "node:assert/strict";
import { detectDirectGateway, networkProbeScript, parseNetwork, sameSubnet } from "../src/lan-detection.mjs";

const gateway = { host: "192.168.10.2", url: "http://192.168.10.2:3425", key: "fixture-sharing-key", info: { version: "0.1.3357" } };
const interfaces = { Ethernet: [{ address: gateway.host, cidr: gateway.host + "/24", internal: false }] };
const network = ({ ssh = "192.168.10.2 1234 192.168.10.3 22", curl = true, routes = { [gateway.host]: gateway.host + " dev eth0 src 192.168.10.3" } } = {}) =>
  "MIGPIE_LAN_NETWORK_V1\nssh\t" + Buffer.from(ssh).toString("base64") + "\ncurl\t" + curl + "\n"
  + Object.entries(routes).map(([host, route]) => "route\t" + host + "\t" + Buffer.from(route).toString("base64")).join("\n") + "\n";

async function detect({ stdout = network(), code = 0, http = {}, gateways = [gateway], assigned = interfaces } = {}) {
  const calls = [];
  const sessions = { async execute(id, command, options) {
    assert.equal(id, "server"); assert.equal(command, "sh -s");
    calls.push(options);
    return calls.length === 1 ? { code, stdout } : { code: http.code ?? 0, stdout: http.stdout ?? 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"name":"magpie","version":"0.1.3357"}' };
  } };
  return { result: await detectDirectGateway(sessions, "server", gateways, { interfaces: assigned }), calls };
}

test("subnet detection uses real IPv4/IPv6 prefixes and contiguous netmasks", () => {
  for (const [address, entry, expected] of [
    ["192.168.11.254", { address: "192.168.10.2", cidr: "192.168.10.2/23" }, true],
    ["192.168.12.2", { address: "192.168.10.2", cidr: "192.168.10.2/23" }, false],
    ["192.168.10.129", { address: "192.168.10.2", cidr: "192.168.10.2/25" }, false],
    ["10.50.1.3", { address: "10.20.1.2", cidr: "10.20.1.2/16" }, false],
    ["192.168.11.3", { address: "192.168.10.2", netmask: "255.255.254.0" }, true],
    ["192.168.10.3", { address: "192.168.10.2", netmask: "255.0.255.0" }, false],
    ["192.168.10.3", { address: "192.168.10.2", netmask: "0.0.0.0" }, false],
    ["192.168.10.3", { address: "192.168.10.2", cidr: "192.168.10.2/24", internal: true }, false],
    ["fd12:3456:789a:1::99", { address: "fd12:3456:789a:1::2", cidr: "fd12:3456:789a:1::2/64" }, true],
    ["fd12:3456:789a:2::99", { address: "fd12:3456:789a:1::2", cidr: "fd12:3456:789a:1::2/64" }, false],
    ["fd12:3456:789a:1::99", { address: "fd12:3456:789a:1::2", netmask: "ffff:ffff:ffff:ffff::" }, true],
    ["fd12::1%eth0", { address: "fd12::2", cidr: "fd12::2/64" }, false],
    ["invalid", { address: "192.168.10.2", cidr: "192.168.10.2/24" }, false],
    ["fd12::1", { address: "192.168.10.2", cidr: "192.168.10.2/24" }, false],
  ]) assert.equal(sameSubnet(address, entry), expected, JSON.stringify([address, entry]));
});

test("network protocol preserves empty route fields and rejects banners, duplicates and incomplete data", () => {
  const empty = network({ routes: { [gateway.host]: "" } });
  assert.equal(parseNetwork(empty, [gateway.host]).routes.get(gateway.host), "");
  for (const value of ["banner\n" + empty, empty + "curl\ttrue\n", empty.replace("curl\ttrue\n", ""), empty.replace(/route\t[^\n]+/, "route\t192.168.10.2\tbad!"), empty.replace("curl\ttrue", "curl\tyes")]) {
    assert.throws(() => parseNetwork(value, [gateway.host]));
  }
  for (const hosts of [[], ["example.com"], ["192.168.10.2; id"], ["fd12::1%eth0"], Array(17).fill(gateway.host)]) assert.throws(() => networkProbeScript(hosts));
});

test("direct selection requires both an on-link subnet and authenticated Magpie reachability", async () => {
  const { result, calls } = await detect();
  assert.equal(result.gateway, gateway); assert.equal(result.remoteHTTP, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].input.includes("Authorization: Bearer " + gateway.key));
  assert.ok(calls[1].input.includes("x-api-key: " + gateway.key));
  for (const route of ["192.168.10.2 via 192.168.10.1 dev eth0 src 192.168.10.3", "192.168.10.2 dev eth0 src 10.1.2.3", "unreachable 192.168.10.2", "192.168.10.2 dev eth0"]) {
    const rejected = await detect({ stdout: network({ routes: { [gateway.host]: route } }) });
    assert.equal(rejected.result.gateway, undefined); assert.equal(rejected.calls.length, 1);
  }
  for (const http of [{ code: 28 }, { code: 22 }, { stdout: "invalid" }, { stdout: "HTTP/1.1 302 Found\r\n\r\n{}" }, { stdout: 'HTTP/1.1 200 OK\r\n\r\n{"name":"magpie","version":"different"}' }]) {
    const rejected = await detect({ http });
    assert.equal(rejected.result.gateway, undefined); assert.equal(rejected.result.remoteHTTP, true);
    assert.match(rejected.result.reason, /不可达或鉴权未通过/);
  }
});

test("SSH_CONNECTION can confirm a subnet only when route output is absent and the client IP belongs to this host", async () => {
  const routes = { [gateway.host]: "" };
  assert.equal((await detect({ stdout: network({ routes }) })).result.gateway, gateway);
  for (const ssh of ["", "127.0.0.1 1234 192.168.10.3 22", "192.168.10.2 1234 10.1.1.3 22", "192.168.10.99 1234 192.168.10.3 22"]) {
    const rejected = await detect({ stdout: network({ routes, ssh }) });
    assert.equal(rejected.result.gateway, undefined); assert.equal(rejected.calls.length, 1);
  }
});

test("multiple interfaces can select a reachable IPv6 ULA instead of a routed IPv4 address", async () => {
  const ipv6 = { ...gateway, host: "fd12:3456::2", url: "http://[fd12:3456::2]:3425" };
  const { result, calls } = await detect({ gateways: [gateway, ipv6], assigned: { ...interfaces, ULA: [{ address: "fd12:3456:0:0:0:0:0:2", cidr: ipv6.host + "/64", internal: false }] }, stdout: network({ routes: {
    [gateway.host]: gateway.host + " via 192.168.10.1 dev eth0 src 192.168.10.3",
    [ipv6.host]: ipv6.host + " dev eth1 src fd12:3456::3 metric 256",
  } }) });
  assert.equal(result.gateway, ipv6); assert.equal(calls.length, 2);
});

test("unavailable network evidence or curl leaves SSH fallback available without sending a shared key", async () => {
  for (const options of [{ code: 69 }, { stdout: "invalid" }, { stdout: network({ curl: false }) }]) {
    const { result, calls } = await detect(options);
    assert.equal(result.gateway, undefined); assert.equal(result.remoteHTTP, false);
    assert.equal(calls.length, 1); assert.ok(!calls[0].input.includes(gateway.key));
  }
});
