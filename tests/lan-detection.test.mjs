import test from "node:test";
import assert from "node:assert/strict";
import { detectDirectGateway, networkProbeScript, parseNetwork, sameSubnet } from "../src/lan-detection.mjs";

const gateway = { host: "192.168.10.2", url: "http://192.168.10.2:3425", key: "fixture-sharing-key", info: { version: "0.1.3357" } };
const interfaces = { Ethernet: [{ address: gateway.host, cidr: gateway.host + "/24", internal: false }] };
const network = ({ ssh = "192.168.10.2 1234 192.168.10.3 22", curl = true, routes = { [gateway.host]: gateway.host + " dev eth0 src 192.168.10.3" } } = {}) =>
  "MIGPIE_LAN_NETWORK_V1\nssh\t" + Buffer.from(ssh).toString("base64") + "\ncurl\t" + curl + "\n"
  + Object.entries(routes).map(([host, route]) => "route\t" + host + "\t" + Buffer.from(route).toString("base64")).join("\n") + "\n";

async function detect({ stdout = network(), code = 0, http = {}, gateways = [gateway], assigned = interfaces, signal } = {}) {
  const calls = [];
  const sessions = { async execute(id, command, options) {
    assert.equal(id, "server"); assert.equal(command, "sh -s");
    calls.push(options);
    const reply = Array.isArray(http) ? http[calls.length - 2] ?? {} : http;
    return calls.length === 1 ? { code, stdout } : { code: reply.code ?? 0, stdout: reply.stdout ?? 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"name":"magpie","version":"0.1.3357"}' };
  } };
  return { result: await detectDirectGateway(sessions, "server", gateways, { interfaces: assigned, signal }), calls };
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

test("direct selection requires authenticated Magpie reachability", async () => {
  const { result, calls } = await detect();
  assert.equal(result.gateway, gateway); assert.equal(result.remoteHTTP, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].input.includes("Authorization: Bearer " + gateway.key));
  assert.ok(calls[1].input.includes("x-api-key: " + gateway.key));
  for (const http of [{ code: 28 }, { code: 22 }, { stdout: "invalid" }, { stdout: "HTTP/1.1 302 Found\r\n\r\n{}" },
    { stdout: 'HTTP/1.1 401 Unauthorized\r\n\r\n{"name":"magpie","version":"0.1.3357"}' },
    { stdout: 'HTTP/1.1 200 OK\r\n\r\n{"name":"other","version":"0.1.3357"}' },
    { stdout: 'HTTP/1.1 200 OK\r\n\r\n{"name":"magpie","version":"different"}' }]) {
    const rejected = await detect({ http });
    assert.equal(rejected.result.gateway, undefined); assert.equal(rejected.result.remoteHTTP, true);
    assert.match(rejected.result.reason, /不可达或鉴权未通过/);
  }
});

test("routed and cross-subnet gateways are selected only after an authenticated HTTP probe", async () => {
  const host = "192.168.1.115", candidate = { ...gateway, host, url: `http://${host}:3425` };
  for (const route of [host + " via 10.10.10.1 dev eth0 src 10.10.10.81", host + " dev eth0 src 10.10.10.81", "unreachable " + host, host + " dev eth0", ""]) {
    const options = { gateways: [candidate], assigned: { Ethernet: [{ address: host, cidr: host + "/24", internal: false }] },
      stdout: network({ ssh: host + " 1234 10.10.10.81 22", routes: { [host]: route } }) };
    const accepted = await detect(options);
    assert.equal(accepted.result.gateway, candidate); assert.equal(accepted.calls.length, 2);
    assert.ok(accepted.calls[1].input.includes(candidate.url + "/"));
    assert.ok(accepted.calls[1].input.includes("Authorization: Bearer " + candidate.key));
    const refused = await detect({ ...options, http: { code: 28 } });
    assert.equal(refused.result.gateway, undefined); assert.equal(refused.calls.length, 2);
    assert.match(refused.result.reason, /不可达或鉴权未通过/);
  }
});

test("absent route and different SSH ingress addresses do not prevent verified direct access", async () => {
  const routes = { [gateway.host]: "" };
  assert.equal((await detect({ stdout: network({ routes }) })).result.gateway, gateway);
  for (const ssh of ["", "127.0.0.1 1234 192.168.10.3 22", "192.168.10.2 1234 10.1.1.3 22", "192.168.10.99 1234 192.168.10.3 22"]) {
    const accepted = await detect({ stdout: network({ routes, ssh }) });
    assert.equal(accepted.result.gateway, gateway); assert.equal(accepted.calls.length, 2);
  }
});

test("subnet evidence prioritizes probes but routed addresses are tried if the on-link candidate fails", async () => {
  const ipv6 = { ...gateway, host: "fd12:3456::2", url: "http://[fd12:3456::2]:3425" };
  const options = { gateways: [gateway, ipv6], assigned: { ...interfaces, ULA: [{ address: "fd12:3456:0:0:0:0:0:2", cidr: ipv6.host + "/64", internal: false }] }, stdout: network({ routes: {
    [gateway.host]: gateway.host + " via 192.168.10.1 dev eth0 src 192.168.10.3",
    [ipv6.host]: ipv6.host + " dev eth1 src fd12:3456::3 metric 256",
  } }) };
  const { result, calls } = await detect(options);
  assert.equal(result.gateway, ipv6); assert.equal(calls.length, 2);
  assert.ok(calls[1].input.includes(ipv6.url));
  const fallback = await detect({ ...options, http: [{ code: 28 }, {}] });
  assert.equal(fallback.result.gateway, gateway); assert.equal(fallback.calls.length, 3);
  assert.ok(fallback.calls[2].input.includes(gateway.url));
});

test("direct probes reject local addresses that disappeared or became internal", async () => {
  for (const assigned of [{}, { Ethernet: [{ address: gateway.host, internal: true }] }]) {
    const { result, calls } = await detect({ assigned });
    assert.equal(result.gateway, undefined); assert.equal(calls.length, 1);
    assert.match(result.reason, /不属于当前网卡/);
  }
});

test("cancellation does not accept a late successful gateway response", async () => {
  const controller = new AbortController();
  let calls = 0;
  const sessions = { async execute() {
    if (++calls === 1) return { code: 0, stdout: network() };
    controller.abort();
    return { code: 0, stdout: 'HTTP/1.1 200 OK\r\n\r\n{"name":"magpie","version":"0.1.3357"}' };
  } };
  const result = await detectDirectGateway(sessions, "server", [gateway], { interfaces, signal: controller.signal });
  assert.equal(result.gateway, undefined); assert.match(result.reason, /已取消/);
});

test("unavailable network evidence or curl leaves SSH fallback available without sending a shared key", async () => {
  for (const options of [{ code: 69 }, { stdout: "invalid" }, { stdout: network({ curl: false }) }]) {
    const { result, calls } = await detect(options);
    assert.equal(result.gateway, undefined); assert.equal(result.remoteHTTP, false);
    assert.equal(calls.length, 1); assert.ok(!calls[0].input.includes(gateway.key));
  }
});
