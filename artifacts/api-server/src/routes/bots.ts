import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import {
  CreateAdminSessionBody,
  CreateAdminSessionResponse,
  CreateBotBody,
  CreateBotResponse,
  DeleteAdminSessionResponse,
  GetAdminConfigResponse,
  GetAdminSessionResponse,
  GetCameraSummaryResponse,
  ListAdminBotsResponse,
  ListCamerasResponse,
  ReconnectBotParams,
  ReconnectBotResponse,
  RemoveBotParams,
  SendBotChatBody,
  SendBotChatParams,
  SendBotChatResponse,
  StartBotParams,
  StartBotResponse,
  StopBotParams,
  StopBotResponse,
} from "@workspace/api-zod";
import { getBotManager } from "../lib/bot-manager";
import {
  clearAdminCookie,
  isAdminRequest,
  passwordsMatch,
  requireAdmin,
  setAdminCookie,
} from "../lib/admin-session";
import { proxyViewerHttp } from "../lib/viewer-proxy";

const router: IRouter = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Wait 15 minutes and try again." },
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Admin request limit reached. Wait a minute and try again." },
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Chat is limited to five messages per minute." },
});

router.get("/bots", (_req, res): void => {
  res.json(ListCamerasResponse.parse(getBotManager().list()));
});

router.get("/bots/summary", (_req, res): void => {
  res.json(GetCameraSummaryResponse.parse(getBotManager().summary()));
});

router.get("/admin/session", (req, res): void => {
  res.json(GetAdminSessionResponse.parse({ authenticated: isAdminRequest(req) }));
});

router.post("/admin/session", loginLimiter, (req, res): void => {
  if (!process.env.ADMIN_PASSWORD) {
    res.status(503).json({ error: "Admin password is not configured on the server." });
    return;
  }
  if (!process.env.SESSION_SECRET) {
    res.status(503).json({ error: "Session signing secret is not configured on the server." });
    return;
  }
  const parsed = CreateAdminSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter the admin password." });
    return;
  }
  if (!passwordsMatch(parsed.data.password)) {
    req.log.warn("Admin sign-in rejected");
    res.status(401).json({ error: "Incorrect password." });
    return;
  }
  if (!setAdminCookie(req, res)) {
    res.status(503).json({ error: "Admin session cannot be signed. Configure SESSION_SECRET." });
    return;
  }
  res.json(CreateAdminSessionResponse.parse({ authenticated: true }));
});

router.delete("/admin/session", (_req, res): void => {
  clearAdminCookie(_req, res);
  res.status(204).end();
});

router.get("/admin/config", requireAdmin, adminLimiter, (_req, res): void => {
  const manager = getBotManager();
  res.json(
    GetAdminConfigResponse.parse({
      defaultVersion: manager.defaultVersion,
      supportedVersions: manager.supportedVersions,
      maxBots: manager.maxBots,
    }),
  );
});

router.get("/admin/bots", requireAdmin, adminLimiter, (_req, res): void => {
  res.json(ListAdminBotsResponse.parse(getBotManager().list()));
});

router.post("/admin/bots", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const parsed = CreateBotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const camera = await getBotManager().add(parsed.data);
    res.status(201).json(CreateBotResponse.parse(camera));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create camera.";
    res.status(400).json({ error: message });
  }
});

router.post("/admin/bots/:botId/start", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const params = StartBotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await getBotManager().start(params.data.botId);
  res.status(result.message === "Camera not found." ? 404 : 200).json(StartBotResponse.parse(result));
});

router.post("/admin/bots/:botId/stop", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const params = StopBotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await getBotManager().stop(params.data.botId);
  res.status(result.message === "Camera not found." ? 404 : 200).json(StopBotResponse.parse(result));
});

router.post("/admin/bots/:botId/reconnect", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const params = ReconnectBotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await getBotManager().reconnect(params.data.botId);
  res.status(result.message === "Camera not found." ? 404 : 200).json(ReconnectBotResponse.parse(result));
});

router.delete("/admin/bots/:botId", requireAdmin, adminLimiter, async (req, res): Promise<void> => {
  const params = RemoveBotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const removed = await getBotManager().remove(params.data.botId);
  if (!removed) {
    res.status(404).json({ error: "Camera not found." });
    return;
  }
  res.status(204).end();
});

router.post(
  "/admin/bots/:botId/chat",
  requireAdmin,
  chatLimiter,
  (req, res): void => {
    const params = SendBotChatParams.safeParse(req.params);
    const body = SendBotChatBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const result = getBotManager().sendChat(params.data.botId, body.data.message);
    res.status(result.message === "Camera not found." ? 404 : result.ok ? 200 : 400)
      .json(SendBotChatResponse.parse(result));
  },
);

router.use("/cameras/:botId/viewer", (req, res): void => {
  const botId = Array.isArray(req.params.botId) ? req.params.botId[0] : req.params.botId;
  if (!/^[a-f0-9-]{36}$/i.test(botId)) {
    res.status(404).send("Camera not found.");
    return;
  }
  req.url = req.originalUrl;
  proxyViewerHttp(botId, req, res);
});

export default router;
