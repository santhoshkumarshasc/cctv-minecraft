import type { IncomingMessage } from "node:http";
import { createProxyServer } from "http-proxy";
import type { Response } from "express";
import type { Socket } from "node:net";
import { getBotManager } from "./bot-manager";
import { logger } from "./logger";

const viewerProxy = createProxyServer({ ws: true, xfwd: true });

viewerProxy.on("error", (error, _request, response) => {
  logger.warn({ errorName: error.name }, "Viewer proxy request failed");
  if (response && "writeHead" in response && !response.headersSent) {
    (response as Response).status(502).send("Camera viewer is unavailable.");
  }
});

export function proxyViewerHttp(
  botId: string,
  request: IncomingMessage & { url?: string },
  response: Response,
): void {
  const port = getBotManager().viewerPortFor(botId);
  if (!port) {
    response.status(503).send("This camera has no live viewer yet.");
    return;
  }
  viewerProxy.web(request, response, {
    target: `http://127.0.0.1:${port}`,
  });
}

export function proxyViewerWebSocket(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  botId: string,
): void {
  const port = getBotManager().viewerPortFor(botId);
  if (!port) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  viewerProxy.ws(request, socket, head, {
    target: `http://127.0.0.1:${port}`,
  });
}
