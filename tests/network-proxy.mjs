import { createServer, connect } from "node:net";
import { listen } from "./helpers.mjs";

// Drops traffic without a TCP close, so SSH must discover the outage via keepalive.
export async function networkProxy(t, targetPort) {
  const sockets = new Set();
  let blocked = false;
  const server = createServer((downstream) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    for (const socket of [upstream, downstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => { sockets.delete(socket); upstream.destroy(); downstream.destroy(); });
    }
    downstream.on("data", (chunk) => { if (!blocked) upstream.write(chunk); });
    upstream.on("data", (chunk) => { if (!blocked) downstream.write(chunk); });
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port, interrupt() { blocked = true; }, resume() { blocked = false; } };
}
