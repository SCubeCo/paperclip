import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import { emailOTP } from "better-auth/plugins";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthInstance = ReturnType<typeof betterAuth>;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;
const AUTH_OTP_LENGTH = 6;
const AUTH_OTP_EXPIRES_IN_SECONDS = 300;
const AUTH_BCRYPT_ROUNDS = 12;

type GraphMailConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderUserId: string;
};

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

function getGraphMailConfig(): GraphMailConfig | null {
  const tenantId = process.env.MS_GRAPH_TENANT_ID?.trim() ?? "";
  const clientId = process.env.MS_GRAPH_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET?.trim() ?? "";
  const senderUserId = process.env.MS_GRAPH_SENDER_USER_ID?.trim() ?? "";
  if (!tenantId || !clientId || !clientSecret || !senderUserId) {
    return null;
  }
  return { tenantId, clientId, clientSecret, senderUserId };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getGraphAccessToken(config: GraphMailConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const response = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Graph token request failed (${response.status}): ${detail}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("Graph token request succeeded but no access token was returned");
  }
  return payload.access_token;
}

async function sendGraphMail(
  config: GraphMailConfig,
  options: { to: string; subject: string; html: string },
) {
  const accessToken = await getGraphAccessToken(config);
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.senderUserId)}/sendMail`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          subject: options.subject,
          body: {
            contentType: "HTML",
            content: options.html,
          },
          toRecipients: [{ emailAddress: { address: options.to } }],
        },
        saveToSentItems: false,
      }),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Graph sendMail failed (${response.status}): ${detail}`);
  }
}

function buildOtpEmailHtml(input: { email: string; otp: string; type: "sign-in" | "email-verification" | "forget-password" }) {
  const safeEmail = escapeHtml(input.email);
  const safeOtp = escapeHtml(input.otp);
  const title =
    input.type === "forget-password"
      ? "Reset your Paperclip password"
      : "Verify your Paperclip sign-in";
  const subtitle =
    input.type === "forget-password"
      ? "Use this one-time code to finish resetting your password."
      : "Use this one-time code to finish signing in to Paperclip.";
  return [
    '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827;line-height:1.5">',
    `<p style="margin:0 0 12px"><strong>${escapeHtml(title)}</strong></p>`,
    `<p style="margin:0 0 16px">${escapeHtml(subtitle)}</p>`,
    `<p style="margin:0 0 8px">Account: ${safeEmail}</p>`,
    `<div style="display:inline-block;padding:12px 18px;border-radius:10px;background:#111827;color:#ffffff;font-size:24px;letter-spacing:0.3em;font-weight:700">${safeOtp}</div>`,
    `<p style="margin:16px 0 0;color:#4b5563">This code expires in ${Math.floor(AUTH_OTP_EXPIRES_IN_SECONDS / 60)} minutes.</p>`,
    "</div>",
  ].join("");
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL ?? baseUrl;
  const isHttpOnly = publicUrl ? publicUrl.startsWith("http://") : false;

  const graphMailConfig = getGraphMailConfig();
  if (!graphMailConfig) {
    throw new Error(
      "Microsoft Graph email is not configured. Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, " +
      "MS_GRAPH_CLIENT_SECRET, and MS_GRAPH_SENDER_USER_ID.",
    );
  }

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
      password: {
        hash: async (password: string) => bcrypt.hash(password, AUTH_BCRYPT_ROUNDS),
        verify: async ({ hash, password }: { hash: string; password: string }) => bcrypt.compare(password, hash),
      },
    },
    emailVerification: {
      autoSignInAfterVerification: true,
    },
    plugins: [
      emailOTP({
        otpLength: AUTH_OTP_LENGTH,
        expiresIn: AUTH_OTP_EXPIRES_IN_SECONDS,
        allowedAttempts: 3,
        disableSignUp: true,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }) => {
          await sendGraphMail(graphMailConfig, {
            to: email,
            subject: type === "forget-password" ? "Paperclip password reset code" : "Paperclip verification code",
            html: buildOtpEmailHtml({ email, otp, type }),
          });
        },
      }),
    ],
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies: isHttpOnly }),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthInstance): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = (auth as unknown as { api?: { getSession?: (input: unknown) => Promise<unknown> } }).api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthInstance,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
