import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { resolvePublicUrl } from "../../../src/shared/public-network";

/** Security transport: every proxy connection is pinned to a validated public IP.
 * This loopback listener exists for network enforcement, not worker messaging. */
export async function createNetworkGuard(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const lifetime = new AbortController();
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (!["GET", "HEAD"].includes(incoming.method ?? ""))
        throw new Error("method");
      const destination = await resolvePublicUrl(
        incoming.url ?? "",
        undefined,
        lifetime.signal,
      );
      if (lifetime.signal.aborted || outgoing.destroyed)
        throw new Error("closed");
      if (destination.url.protocol !== "http:") throw new Error("protocol");
      const upstream = request(
        destination.url,
        {
          method: incoming.method,
          headers: {
            host: destination.url.host,
            "user-agent": "Verbo public page reader",
            accept: "text/html,*/*;q=0.1",
          },
          lookup: (_host, options, callback) => {
            if (options.all)
              callback(null, [
                { address: destination.address, family: destination.family },
              ]);
            else callback(null, destination.address, destination.family);
          },
          timeout: 15000,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => outgoing.destroy());
      outgoing.on("close", () => upstream.destroy());
      upstream.end();
    } catch {
      outgoing.writeHead(403);
      outgoing.end();
    }
  });
  server.on("connect", async (incoming, downstream, head) => {
    try {
      const destination = await resolvePublicUrl(
        `https://${incoming.url ?? ""}/`,
        undefined,
        lifetime.signal,
      );
      if (lifetime.signal.aborted || downstream.destroyed)
        throw new Error("closed");
      if (destination.url.port && destination.url.port !== "443")
        throw new Error("port");
      const upstream = connect({
        host: destination.address,
        port: 443,
        family: destination.family,
      });
      sockets.add(upstream);
      upstream.setTimeout(20000, () => upstream.destroy());
      upstream.on("close", () => {
        sockets.delete(upstream);
        downstream.destroy();
      });
      upstream.on("error", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
      downstream.on("close", () => upstream.destroy());
      upstream.once("connect", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(downstream);
        downstream.pipe(upstream);
      });
    } catch {
      downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("proxy_unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
