import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const COOKIE_NAME = "minecraft_cctv_admin";
const SESSION_SECONDS = 60 * 60 * 8;

function secret(): string | null {
  return process.env.SESSION_SECRET || null;
}

function signature(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

function cookieFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const [name, ...valueParts] = item.trim().split("=");
    if (name === COOKIE_NAME) return valueParts.join("=") || null;
  }
  return null;
}

export function isValidAdminCookieHeader(
  cookieHeader: string | undefined,
): boolean {
  const key = secret();
  const value = cookieFromHeader(cookieHeader);
  if (!key || !value) return false;

  const separator = value.lastIndexOf(".");
  if (separator < 1) return false;

  const payload = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  const expiresAt = Number(payload);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  if (!/^[a-f0-9]{64}$/i.test(suppliedSignature)) return false;

  const expected = Buffer.from(signature(payload, key), "hex");
  const supplied = Buffer.from(suppliedSignature, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function isAdminRequest(req: Request): boolean {
  return isValidAdminCookieHeader(req.headers.cookie);
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "Admin sign-in required." });
    return;
  }
  next();
}

export function passwordsMatch(candidate: string): boolean {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword) return false;

  const expected = createHmac("sha256", "minecraft-cctv-password-check")
    .update(configuredPassword)
    .digest();
  const supplied = createHmac("sha256", "minecraft-cctv-password-check")
    .update(candidate)
    .digest();
  return timingSafeEqual(expected, supplied);
}

export function setAdminCookie(req: Request, res: Response): boolean {
  const key = secret();
  if (!key) return false;

  const expiresAt = Date.now() + SESSION_SECONDS * 1000;
  const payload = String(expiresAt);
  const value = `${payload}.${signature(payload, key)}`;
  const secure = req.secure ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`,
  );
  return true;
}

export function clearAdminCookie(req: Request, res: Response): void {
  const secure = req.secure ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
  );
}
