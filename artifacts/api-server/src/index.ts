import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Server as SocketServer } from "socket.io";
import app from "./app";
import { isValidAdminCookieHeader } from "./lib/admin-session";
import { BotManager, setBotManager } from "./lib/bot-manager";
import { proxyViewerWebSocket } from "./lib/viewer-proxy";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  path: "/api/socket.io",
  serveClient: false,
});
const botManager = new BotManager(io);
setBotManager(botManager);

io.on("connection", (socket) => {
  if (isValidAdminCookieHeader(socket.request.headers.cookie)) {
    socket.join("admin");
  }
});

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  const match = url.pathname.match(
    /^\/api\/cameras\/([a-f0-9-]{36})\/viewer\/socket\.io(?:\/|$)/i,
  );
  if (match) proxyViewerWebSocket(request, socket as Socket, head, match[1]);
});

async function start(): Promise<void> {
  await botManager.initialize();
  httpServer.listen(port, () => {
    logger.info({ port }, "Server listening");
  });
}

start().catch((error: unknown) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "API server failed to start",
  );
  process.exit(1);
});
