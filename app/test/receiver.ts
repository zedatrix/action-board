import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Received = { method: string; headers: IncomingHttpHeaders; body: string };

// Local mock webhook receiver. Answers POSTs with the next status from `statuses` (the last one repeats).
export async function startReceiver(statuses: number[] = [200]) {
  const received: Received[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.statusCode = statuses[Math.min(n++, statuses.length - 1)];
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
