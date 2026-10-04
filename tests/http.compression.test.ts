import { describe, expect, it } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";
import nextConfig from "../next.config";

const require = createRequire(import.meta.url);
const compression = require("next/dist/compiled/compression") as () => (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

/** Exercise the actual bundled middleware's drain delegation without opening a socket. */
function retainedDrainListeners(compress: boolean): number {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.headers = { "accept-encoding": "gzip" };
  const response = new ServerResponse(request);
  response.setHeader("Content-Type", "text/html");
  if (compress) compression()(request, response, () => {});
  response.writeHead(200);
  // compression returns its Gzip from res.on('drain'); ordinary HTTP returns res.
  const sentinel = () => {};
  const target = response.on("drain", sentinel) as EventEmitter;
  target.removeListener("drain", sentinel);
  for (let n = 0; n < 8; n++) {
    response.once("drain", () => {});
    target.emit("drain");
  }
  const retained = target.listenerCount("drain");
  target.removeAllListeners("drain");
  if (target !== response) (target as EventEmitter & { destroy(): void }).destroy();
  response.destroy();
  socket.destroy();
  return retained;
}

describe("loopback HTTP compression", () => {
  it("reproduces the bundled compression listener leak", () => {
    expect(retainedDrainListeners(true)).toBe(8);
  });

  it("keeps drain listeners bounded in the configured runtime", () => {
    expect(retainedDrainListeners(nextConfig.compress !== false)).toBe(0);
  });
});
