import ssh2 from "ssh2";
import { createServer, connect as connectTCP } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHostSandbox } from "../scripts/host-sandbox.mjs";
import { fingerprint } from "../src/host-keys.mjs";
import { keys } from "./fixtures.mjs";

const { Server, utils } = ssh2;
export { keys };
const parsedKey = utils.parseKey(keys.private);
if (parsedKey instanceof Error) throw new Error("Invalid test-only SSH fixture", { cause: parsedKey });
export const hostPublicKey = parsedKey.getPublicSSH();

export async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "migpie-remote-test-"));
  t.after(async () => {
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("migpie-remote-test-")) {
      throw new Error("Refusing to remove an unexpected temporary directory");
    }
    await rm(absolute, { recursive: true, force: true });
  });
  return directory;
}

export async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

export async function startPagePlugin(t, directory) {
  const sandbox = await createHostSandbox(fileURLToPath(new URL("../", import.meta.url)));
  t.after(() => sandbox.cleanup());
  const { default: plugin } = await import(pathToFileURL(join(sandbox.root, "index.mjs")));
  const { closePlugin } = await import(pathToFileURL(join(sandbox.root, "src", "plugin.mjs")));
  const hooks = await plugin.server({ directory });
  t.after(() => closePlugin(hooks));
  const call = managementClient(sandbox.getEndpoint());
  return { hooks, call, close: () => closePlugin(hooks) };
}

export function managementClient(url) {
  const token = new URL(url).pathname.split("/")[1];
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return async (method, args = {}) => {
    const response = await fetch(new URL("api/call", url), {
      method: "POST", headers, body: JSON.stringify({ method, args }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Management request failed (${response.status})`);
    return body.result;
  };
}

export async function echoServer(t) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, port };
}

export function exchange(port, payload = Buffer.from("SSH tunnel round trip")) {
  return new Promise((resolve, reject) => {
    const socket = connectTCP({ host: "127.0.0.1", port });
    const chunks = [];
    let size = 0;
    socket.setTimeout(4000, () => socket.destroy(new Error("TCP exchange timeout")));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= payload.length) {
        socket.end();
        resolve(Buffer.concat(chunks));
      }
    });
    socket.on("end", () => {
      if (size < payload.length) reject(new Error("TCP data truncated"));
    });
    socket.once("connect", () => socket.write(payload));
  });
}

export async function until(predicate, message = "condition not met", timeout = 4000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

export async function sshServer(t, { rejectRemote = false, hangAuth = false, hangForward = false, cancelForward = "accept", clientPublicKey = hostPublicKey } = {}) {
  const acceptedKey = utils.parseKey(`ssh-ed25519 ${clientPublicKey.toString("base64")}`);
  if (acceptedKey instanceof Error) throw acceptedKey;
  const clients = new Set();
  const listeners = new Set();
  const sockets = new Set();
  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    const forwards = new Map();
    const track = (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      return socket;
    };
    const bridge = (socket, channel) => {
      track(channel);
      socket.pipe(channel).pipe(socket);
      socket.on("error", () => channel.destroy());
      channel.on("error", () => socket.destroy());
      channel.once("close", () => socket.end());
      socket.once("close", () => channel.destroy());
    };
    client.on("authentication", (ctx) => {
      if (hangAuth) return;
      if (ctx.username === "tester" && ctx.method === "password" && ctx.password === "local-test-secret") ctx.accept();
      else if (ctx.username === "tester" && ctx.method === "publickey"
        && ctx.key.data.equals(clientPublicKey)
        && (!ctx.signature || acceptedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        const socket = track(connectTCP({ host: info.destIP, port: info.destPort }));
        let answered = false;
        socket.once("error", () => { if (!answered) { answered = true; reject(); } });
        socket.once("connect", () => {
          answered = true;
          const channel = accept();
          if (channel) bridge(socket, channel);
          else socket.destroy();
        });
      });
      client.on("request", (accept, reject, name, info) => {
        if (name === "tcpip-forward") {
          if (hangForward) return;
          if (rejectRemote) return reject();
          const listener = createServer((socket) => {
            track(socket);
            client.forwardOut(info.bindAddr, listener.address().port,
              socket.remoteAddress, socket.remotePort, (error, channel) => {
                if (error) socket.destroy();
                else bridge(socket, channel);
              });
          });
          listeners.add(listener);
          listener.once("close", () => listeners.delete(listener));
          listener.on("error", () => reject());
          listener.listen(info.bindPort, info.bindAddr, () => {
            forwards.set(`${info.bindAddr}:${listener.address().port}`, listener);
            accept(listener.address().port);
          });
        } else if (name === "cancel-tcpip-forward") {
          if (cancelForward === "reject") return reject();
          if (cancelForward === "hang") return;
          if (cancelForward === "disconnect") return client.end();
          const key = `${info.bindAddr}:${info.bindPort}`;
          const listener = forwards.get(key);
          if (!listener) return reject();
          forwards.delete(key);
          listener.close();
          accept();
        } else reject?.();
      });
    });
    client.once("close", () => {
      clients.delete(client);
      for (const listener of forwards.values()) listener.close();
    });
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const client of clients) client.end();
    for (const listener of listeners) listener.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const directory = await temporary(t);
  const knownHostsFile = join(directory, "known_hosts");
  await writeFile(knownHostsFile, "");
  return {
    server, clients, listeners, port,
    profile: {
      id: "test-server", host: "127.0.0.1", port, username: "tester",
      passwordEnv: "MIGPIE_TEST_PASSWORD", knownHostsFile,
      hostFingerprint: fingerprint(hostPublicKey),
    },
  };
}
