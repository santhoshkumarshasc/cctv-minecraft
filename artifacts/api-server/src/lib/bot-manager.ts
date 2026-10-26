import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Server as SocketServer } from "socket.io";
import { createBot, type Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { Movements, goals, pathfinder } from "mineflayer-pathfinder";
import { logger } from "./logger";

export type PatrolPoint = { x: number; y: number; z: number };
export type BotAuthMode = "offline" | "microsoft";
export type BotStatus =
  | "offline"
  | "connecting"
  | "online"
  | "reconnecting"
  | "error";

export interface BotConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  version: string;
  authMode: BotAuthMode;
  microsoftEmail?: string;
  serverPermissionConfirmed: true;
  antiAfk: boolean;
  autoReconnect: boolean;
  patrolEnabled: boolean;
  patrolPath: PatrolPoint[];
  chatEnabled: boolean;
  createdAt: number;
}

export interface BotInput {
  name: string;
  host: string;
  port: number;
  version: string;
  authMode: BotAuthMode;
  microsoftEmail?: string;
  serverPermissionConfirmed: boolean;
  antiAfk: boolean;
  autoReconnect: boolean;
  patrolEnabled: boolean;
  patrolPath?: PatrolPoint[];
  chatEnabled: boolean;
}

interface RuntimeBot {
  config: BotConfig;
  bot?: Bot;
  status: BotStatus;
  startedAt: number | null;
  lastError: string | null;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout;
  antiAfkTimer?: NodeJS.Timeout;
  viewerPort: number | null;
  shouldRun: boolean;
  patrolIndex: number;
  patrolEventBot?: Bot;
  lastChatCommandAt?: number;
}

interface CameraBotResponse {
  id: string;
  cameraNumber: number;
  name: string;
  server: string;
  version: string;
  authMode: BotAuthMode;
  status: BotStatus;
  uptimeSeconds: number;
  health: number | null;
  food: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  pingMs: number | null;
  lastError: string | null;
  viewerUrl: string;
  antiAfk: boolean;
  autoReconnect: boolean;
  patrolEnabled: boolean;
  chatEnabled: boolean;
}

const MAX_PATROL_POINTS = 32;
const MAX_COORDINATE = 30_000_000;
const MIN_Y = -64;
const MAX_Y = 320;

function configPath(): string {
  return path.resolve(
    process.cwd(),
    process.env.BOT_CONFIG_PATH || "../../data/bots.json",
  );
}

function profilesPath(botId: string): string {
  return path.resolve(
    process.cwd(),
    process.env.MICROSOFT_PROFILES_PATH || "../../data/profiles",
    botId,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStoredConfig(value: unknown): BotConfig {
  if (!isRecord(value)) throw new Error("Bot configuration entry is not an object.");
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.host !== "string" ||
    typeof value.port !== "number" ||
    typeof value.version !== "string" ||
    (value.authMode !== "offline" && value.authMode !== "microsoft") ||
    value.serverPermissionConfirmed !== true ||
    typeof value.antiAfk !== "boolean" ||
    typeof value.autoReconnect !== "boolean" ||
    typeof value.patrolEnabled !== "boolean" ||
    typeof value.chatEnabled !== "boolean" ||
    typeof value.createdAt !== "number" ||
    !Array.isArray(value.patrolPath)
  ) {
    throw new Error("Bot configuration is invalid. Fix or remove the bad entry in the bot config file.");
  }
  return value as unknown as BotConfig;
}

function validHost(host: string): boolean {
  if (host.length > 253 || host.includes("/") || host.includes("@")) return false;
  if (host.includes(":")) {
    return isIP(host) === 6;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return isIP(host) === 4;
  }
  return /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(host);
}

function assertInput(input: BotInput): void {
  if (!input.serverPermissionConfirmed) {
    throw new Error("Confirm that you own or have permission to use this Minecraft server.");
  }
  if (!validHost(input.host.trim())) {
    throw new Error("Enter a hostname or IP address without a URL or path.");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("Server port must be between 1 and 65535.");
  }
  if (input.authMode === "microsoft" && !input.microsoftEmail?.trim()) {
    throw new Error("Microsoft authentication needs the account email used for sign-in.");
  }
  if ((input.patrolPath?.length ?? 0) > MAX_PATROL_POINTS) {
    throw new Error(`A patrol can contain at most ${MAX_PATROL_POINTS} waypoints.`);
  }
  for (const point of input.patrolPath ?? []) {
    if (
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      !Number.isInteger(point.z) ||
      Math.abs(point.x) > MAX_COORDINATE ||
      Math.abs(point.z) > MAX_COORDINATE ||
      point.y < MIN_Y ||
      point.y > MAX_Y
    ) {
      throw new Error("Patrol coordinates are outside the supported Minecraft world range.");
    }
  }
  if (input.patrolEnabled && (input.patrolPath?.length ?? 0) < 2) {
    throw new Error("Add at least two waypoints to enable patrol.");
  }
}

function serverLabel(host: string, port: number): string {
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return `${displayHost}:${port}`;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message.slice(0, 300);
  return String(value).slice(0, 300);
}

export class BotManager {
  private readonly bots = new Map<string, RuntimeBot>();
  private readonly io: SocketServer;
  private nextViewerPort = Number(process.env.VIEWER_PORT_START || 3200);
  private readonly viewerPorts = new Map<string, number>();
  private persistQueue = Promise.resolve();
  private ticker?: NodeJS.Timeout;

  constructor(io: SocketServer) {
    this.io = io;
  }

  get maxBots(): number {
    const configured = Number(process.env.MAX_BOTS || 12);
    return Number.isInteger(configured) ? Math.min(Math.max(configured, 1), 32) : 12;
  }

  get defaultVersion(): string {
    return process.env.MC_VERSION || "26.3";
  }

  get supportedVersions(): string[] {
    return minecraftData.versions.pc.map((entry) => entry.minecraftVersion);
  }

  private assignViewerPort(botId: string): number {
    const existing = this.viewerPorts.get(botId);
    if (existing !== undefined) return existing;
    const port = this.nextViewerPort++;
    this.viewerPorts.set(botId, port);
    return port;
  }

  async initialize(): Promise<void> {
    const file = configPath();
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        stored = [];
      } else {
        throw new Error(`Could not read bot configuration at ${file}: ${errorText(error)}`);
      }
    }
    if (!Array.isArray(stored)) {
      throw new Error(`Bot configuration at ${file} must contain a JSON array.`);
    }
    const configs = stored.map(validateStoredConfig);
    if (configs.length > this.maxBots) {
      throw new Error(`Bot configuration has ${configs.length} entries; MAX_BOTS is ${this.maxBots}.`);
    }
    for (const config of configs) {
      this.bots.set(config.id, {
        config,
        status: "offline",
        startedAt: null,
        lastError: null,
        reconnectAttempt: 0,
        viewerPort: null,
        shouldRun: false,
        patrolIndex: 0,
      });
    }
    this.ticker = setInterval(() => this.publishAll(), 1000);
    if (process.env.BOT_AUTOSTART !== "false") {
      for (const runtime of this.bots.values()) {
        void this.start(runtime.config.id);
      }
    }
    logger.info({ configuredBots: configs.length }, "Bot manager initialized");
  }

  list(): CameraBotResponse[] {
    return [...this.bots.values()]
      .sort((left, right) => left.config.createdAt - right.config.createdAt)
      .map((runtime, index) => this.toResponse(runtime, index + 1));
  }

  summary(): {
    total: number;
    online: number;
    offline: number;
    reconnecting: number;
    latestUpdate: string;
  } {
    const items = this.list();
    return {
      total: items.length,
      online: items.filter((item) => item.status === "online").length,
      offline: items.filter((item) => item.status === "offline" || item.status === "error").length,
      reconnecting: items.filter((item) => item.status === "reconnecting" || item.status === "connecting").length,
      latestUpdate: new Date().toISOString(),
    };
  }

  viewerPortFor(id: string): number | null {
    return this.bots.get(id)?.viewerPort ?? null;
  }

  hasBot(id: string): boolean {
    return this.bots.has(id);
  }

  async add(input: BotInput): Promise<CameraBotResponse> {
    assertInput(input);
    if (this.bots.size >= this.maxBots) {
      throw new Error(`Camera limit reached (${this.maxBots}).`);
    }
    const config: BotConfig = {
      ...input,
      id: randomUUID(),
      name: input.name.trim(),
      host: input.host.trim(),
      microsoftEmail: input.microsoftEmail?.trim() || undefined,
      serverPermissionConfirmed: true,
      patrolPath: input.patrolPath ?? [],
      createdAt: Date.now(),
    };
    const runtime: RuntimeBot = {
      config,
      status: "offline",
      startedAt: null,
      lastError: null,
      reconnectAttempt: 0,
      viewerPort: null,
      shouldRun: false,
      patrolIndex: 0,
    };
    this.bots.set(config.id, runtime);
    try {
      await this.persist();
    } catch (error) {
      this.bots.delete(config.id);
      throw error;
    }
    this.publish(runtime);
    return this.list().find((item) => item.id === config.id)!;
  }

  async start(id: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.bots.get(id);
    if (!runtime) return { ok: false, message: "Camera not found." };
    if (runtime.status === "online" || runtime.status === "connecting") {
      return { ok: true, message: `${runtime.config.name} is already running.` };
    }
    if (!runtime.config.serverPermissionConfirmed) {
      return { ok: false, message: "Server permission confirmation is required." };
    }
    const versionData = minecraftData(runtime.config.version);
    if (!versionData) {
      runtime.status = "error";
      runtime.lastError = `${runtime.config.version} is not available in minecraft-data ${process.env.MINECRAFT_DATA_VERSION || "3.117.0"}. Use a supported version such as 26.1, or configure a compatible ViaVersion server.`;
      this.publish(runtime);
      return { ok: false, message: runtime.lastError };
    }
    runtime.shouldRun = true;
    runtime.lastError = null;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    this.connect(runtime);
    return { ok: true, message: `Starting ${runtime.config.name}.` };
  }

  async stop(id: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.bots.get(id);
    if (!runtime) return { ok: false, message: "Camera not found." };
    runtime.shouldRun = false;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    this.clearBehaviorTimers(runtime);
    this.closeViewer(runtime);
    runtime.status = "offline";
    runtime.startedAt = null;
    runtime.lastError = null;
    const bot = runtime.bot;
    runtime.bot = undefined;
    if (bot) {
      try {
        bot.quit("Camera stopped by admin");
      } catch {
        bot._client.end("Camera stopped by admin");
      }
    }
    this.publish(runtime);
    return { ok: true, message: `${runtime.config.name} stopped.` };
  }

  async reconnect(id: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.bots.get(id);
    if (!runtime) return { ok: false, message: "Camera not found." };
    runtime.shouldRun = true;
    runtime.reconnectAttempt = 0;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    this.clearBehaviorTimers(runtime);
    this.closeViewer(runtime);
    const oldBot = runtime.bot;
    runtime.bot = undefined;
    runtime.status = "reconnecting";
    runtime.lastError = null;
    this.publish(runtime);
    if (oldBot) {
      try {
        oldBot.quit("Reconnecting by admin");
      } catch {
        oldBot._client.end("Reconnecting by admin");
      }
    }
    setTimeout(() => {
      if (runtime.shouldRun && this.bots.has(id)) this.connect(runtime);
    }, 400);
    return { ok: true, message: `Reconnecting ${runtime.config.name}.` };
  }

  async remove(id: string): Promise<boolean> {
    const runtime = this.bots.get(id);
    if (!runtime) return false;
    await this.stop(id);
    this.bots.delete(id);
    await this.persist();
    this.publishAll();
    return true;
  }

  sendChat(id: string, message: string): { ok: boolean; message: string } {
    const runtime = this.bots.get(id);
    if (!runtime) return { ok: false, message: "Camera not found." };
    if (!runtime.config.chatEnabled) {
      return { ok: false, message: "Chat is disabled for this camera." };
    }
    if (!runtime.bot || runtime.status !== "online") {
      return { ok: false, message: "The bot must be online to send chat." };
    }
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > 200) {
      return { ok: false, message: "Message must be between 1 and 200 characters." };
    }
    runtime.bot.chat(trimmed);
    return { ok: true, message: "Message sent." };
  }

  private connect(runtime: RuntimeBot): void {
    if (!runtime.shouldRun || !this.bots.has(runtime.config.id)) return;
    runtime.status = runtime.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    runtime.startedAt = null;
    runtime.lastError = null;
    runtime.patrolEventBot = undefined;
    this.publish(runtime);

    const config = runtime.config;
    const accountName =
      config.authMode === "microsoft" ? config.microsoftEmail! : config.name;
    let bot: Bot;
    try {
      bot = createBot({
        host: config.host,
        port: config.port,
        username: accountName,
        version: config.version,
        auth: config.authMode,
        profilesFolder: config.authMode === "microsoft" ? profilesPath(config.id) : false,
        onMsaCode: (data) => {
          this.io.to("admin").emit("auth:device-code", {
            botId: config.id,
            botName: config.name,
            verificationUri: data.verification_uri,
            userCode: data.user_code,
            expiresIn: data.expires_in,
            message: data.message,
          });
          logger.info({ botId: config.id }, "Microsoft device authorization requested");
        },
        hideErrors: true,
      });
    } catch (error) {
      runtime.status = "error";
      runtime.lastError = errorText(error);
      logger.warn({ botId: config.id }, "Minecraft bot could not be created");
      if (runtime.config.autoReconnect) this.scheduleReconnect(runtime);
      this.publish(runtime);
      return;
    }
    runtime.bot = bot;
    bot.loadPlugin(pathfinder);

    bot.on("login", () => {
      runtime.lastError = null;
      this.publish(runtime);
    });
    bot.on("spawn", () => {
      runtime.status = "online";
      runtime.startedAt ??= Date.now();
      runtime.lastError = null;
      runtime.reconnectAttempt = 0;
      if (runtime.viewerPort === null) {
        try {
          const port = this.assignViewerPort(config.id);
          runtime.viewerPort = port;
          const { mineflayer: startViewer } = require("prismarine-viewer") as {
            mineflayer: (
              botInstance: Bot,
              options: { port: number; firstPerson: boolean; viewDistance: number; prefix: string },
            ) => void;
          };
          startViewer(bot, {
            port,
            firstPerson: true,
            viewDistance: 6,
            prefix: `/api/cameras/${config.id}/viewer`,
          });
        } catch (error) {
          runtime.lastError = `Viewer could not start: ${errorText(error)}`;
          runtime.viewerPort = null;
        }
      }
      this.clearBehaviorTimers(runtime);
      this.beginBehaviors(runtime, bot);
      this.publish(runtime);
    });
    bot.on("kicked", (reason) => {
      runtime.lastError = `Server disconnected the bot: ${errorText(reason)}`;
      this.publish(runtime);
    });
    bot.on("chat", (username, message) => {
      this.handleChatCommand(runtime, bot, username, message);
    });
    bot.on("error", (error) => {
      runtime.lastError = errorText(error);
      runtime.status = "error";
      logger.warn({ botId: config.id, errorName: error.name }, "Minecraft bot error");
      this.publish(runtime);
    });
    bot.on("end", () => {
      if (runtime.bot !== bot) return;
      runtime.bot = undefined;
      this.clearBehaviorTimers(runtime);
      this.closeViewer(runtime, bot);
      runtime.startedAt = null;
      if (!runtime.shouldRun) {
        runtime.status = "offline";
      } else if (config.autoReconnect) {
        runtime.status = "reconnecting";
        this.scheduleReconnect(runtime);
      } else {
        runtime.status = "error";
        runtime.lastError ??= "Connection ended. Reconnect is disabled.";
      }
      this.publish(runtime);
    });
  }

  private beginBehaviors(runtime: RuntimeBot, bot: Bot): void {
    if (runtime.config.patrolEnabled && runtime.config.patrolPath.length > 1) {
      try {
        const data = minecraftData(runtime.config.version);
        const movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
        runtime.patrolIndex = 0;
        this.setPatrolGoal(runtime, bot);
        if (runtime.patrolEventBot !== bot) {
          runtime.patrolEventBot = bot;
          bot.on("goal_reached", () => {
            if (runtime.bot !== bot || !runtime.config.patrolEnabled) return;
            runtime.patrolIndex =
              (runtime.patrolIndex + 1) % runtime.config.patrolPath.length;
            this.setPatrolGoal(runtime, bot);
          });
        }
      } catch (error) {
        runtime.lastError = `Patrol could not start: ${errorText(error)}`;
      }
    }

    if (runtime.config.antiAfk) {
      runtime.antiAfkTimer = setInterval(() => {
        if (runtime.bot !== bot || runtime.status !== "online") return;
        const yaw = (Math.random() - 0.5) * Math.PI * 2;
        const pitch = (Math.random() - 0.5) * 0.3;
        void bot.look(yaw, pitch, true).catch(() => undefined);
        if (!runtime.config.patrolEnabled) {
          bot.setControlState("jump", true);
          setTimeout(() => {
            if (runtime.bot === bot) bot.setControlState("jump", false);
          }, 250);
        }
      }, 60_000);
    }
  }

  private handleChatCommand(
    runtime: RuntimeBot,
    bot: Bot,
    username: string,
    message: string,
  ): void {
    if (!runtime.config.chatEnabled || runtime.bot !== bot || username === bot.username) {
      return;
    }
    const match = /^!cctv(?:\s+(.+))?$/i.exec(message.trim());
    if (!match) return;

    const now = Date.now();
    if (now - (runtime.lastChatCommandAt ?? 0) < 4_000) return;
    runtime.lastChatCommandAt = now;

    const command = match[1]?.trim().toLowerCase();
    if (command === "status") {
      bot.chat(`${runtime.config.name}: ${runtime.status}.`);
      return;
    }
    if (command === "coords") {
      const position = bot.entity?.position;
      if (position) {
        bot.chat(
          `${runtime.config.name}: ${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)}.`,
        );
      } else {
        bot.chat(`${runtime.config.name}: location unavailable.`);
      }
      return;
    }
    bot.chat("Commands: !cctv status, !cctv coords");
  }

  private setPatrolGoal(runtime: RuntimeBot, bot: Bot): void {
    const point = runtime.config.patrolPath[runtime.patrolIndex];
    if (!point) return;
    bot.pathfinder.setGoal(new goals.GoalNear(point.x, point.y, point.z, 1), false);
  }

  private scheduleReconnect(runtime: RuntimeBot): void {
    if (!runtime.shouldRun || !runtime.config.autoReconnect) return;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    const delay = Math.min(5_000 * 2 ** runtime.reconnectAttempt, 60_000);
    runtime.reconnectAttempt += 1;
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = undefined;
      this.connect(runtime);
    }, delay);
  }

  private clearBehaviorTimers(runtime: RuntimeBot): void {
    if (runtime.antiAfkTimer) clearInterval(runtime.antiAfkTimer);
    runtime.antiAfkTimer = undefined;
  }

  private closeViewer(runtime: RuntimeBot, sourceBot = runtime.bot): void {
    const bot = sourceBot as (Bot & { viewer?: { close?: () => void } }) | undefined;
    try {
      bot?.viewer?.close?.();
    } catch (error) {
      logger.warn({ botId: runtime.config.id, errorName: error instanceof Error ? error.name : "unknown" }, "Viewer close failed");
    }
    runtime.viewerPort = null;
  }

  private toResponse(runtime: RuntimeBot, cameraNumber: number): CameraBotResponse {
    const bot = runtime.bot;
    const position = bot?.entity?.position;
    const player = bot?.players?.[bot.username];
    const uptimeSeconds =
      runtime.status === "online" && runtime.startedAt
        ? Math.max(0, Math.floor((Date.now() - runtime.startedAt) / 1000))
        : 0;
    return {
      id: runtime.config.id,
      cameraNumber,
      name: runtime.config.name,
      server: serverLabel(runtime.config.host, runtime.config.port),
      version: runtime.config.version,
      authMode: runtime.config.authMode,
      status: runtime.status,
      uptimeSeconds,
      health: typeof bot?.health === "number" ? bot.health : null,
      food: typeof bot?.food === "number" ? bot.food : null,
      x: position ? Math.round(position.x * 10) / 10 : null,
      y: position ? Math.round(position.y * 10) / 10 : null,
      z: position ? Math.round(position.z * 10) / 10 : null,
      pingMs: typeof player?.ping === "number" ? player.ping : null,
      lastError: runtime.lastError,
      viewerUrl: `/api/cameras/${runtime.config.id}/viewer/`,
      antiAfk: runtime.config.antiAfk,
      autoReconnect: runtime.config.autoReconnect,
      patrolEnabled: runtime.config.patrolEnabled,
      chatEnabled: runtime.config.chatEnabled,
    };
  }

  private publish(runtime: RuntimeBot): void {
    const cameraNumber =
      this.list().findIndex((item) => item.id === runtime.config.id) + 1;
    if (cameraNumber < 1) return;
    this.io.emit("camera:update", this.toResponse(runtime, cameraNumber));
    this.io.emit("camera:summary", this.summary());
  }

  private publishAll(): void {
    const cameras = this.list();
    for (const camera of cameras) {
      this.io.emit("camera:update", camera);
    }
    this.io.emit("camera:summary", this.summary());
  }

  private async persist(): Promise<void> {
    const configs = [...this.bots.values()].map(({ config }) => config);
    const file = configPath();
    const tempFile = `${file}.tmp`;
    this.persistQueue = this.persistQueue.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tempFile, `${JSON.stringify(configs, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tempFile, file);
    });
    return this.persistQueue;
  }
}

let activeBotManager: BotManager | null = null;

export function setBotManager(manager: BotManager): void {
  activeBotManager = manager;
}

export function getBotManager(): BotManager {
  if (!activeBotManager) throw new Error("Bot manager is not initialized.");
  return activeBotManager;
}
