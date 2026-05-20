import { createHash, randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authAccounts, authUsers, authVerifications, instanceUserRoles } from "@paperclipai/db";
import {
  authSessionSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";
import { conflict, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";

const AUTH_OTP_LENGTH = 6;
const AUTH_OTP_EXPIRES_IN_MS = 5 * 60 * 1000;

type GraphMailConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderUserId: string;
};

const passwordStartSchema = z.object({
  mode: z.enum(["sign_in", "sign_up"]),
  email: z.string().email(),
  password: z.string().min(1),
  name: z.string().trim().max(200).optional(),
});

function getGraphMailConfig(): GraphMailConfig {
  const tenantId = process.env.MS_GRAPH_TENANT_ID?.trim() ?? "";
  const clientId = process.env.MS_GRAPH_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET?.trim() ?? "";
  const senderUserId = process.env.MS_GRAPH_SENDER_USER_ID?.trim() ?? "";
  if (!tenantId || !clientId || !clientSecret || !senderUserId) {
    throw new Error(
      "Microsoft Graph email is not configured. Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, " +
      "MS_GRAPH_CLIENT_SECRET, and MS_GRAPH_SENDER_USER_ID.",
    );
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

function otpHash(otp: string) {
  return createHash("sha256").update(otp).digest("base64url");
}

function generateNumericOtp(length = AUTH_OTP_LENGTH) {
  let otp = "";
  while (otp.length < length) {
    otp += String(randomInt(0, 10));
  }
  return otp.slice(0, length);
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

function buildOtpEmailHtml(input: { email: string; otp: string }) {
  const safeEmail = escapeHtml(input.email);
  const safeOtp = escapeHtml(input.otp);
  return [
    '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827;line-height:1.5">',
    "<p style=\"margin:0 0 12px\"><strong>Verify your Paperclip sign-in</strong></p>",
    "<p style=\"margin:0 0 16px\">Use this one-time code to finish signing in to Paperclip.</p>",
    `<p style="margin:0 0 8px">Account: ${safeEmail}</p>`,
    `<div style="display:inline-block;padding:12px 18px;border-radius:10px;background:#111827;color:#ffffff;font-size:24px;letter-spacing:0.3em;font-weight:700">${safeOtp}</div>`,
    "<p style=\"margin:16px 0 0;color:#4b5563\">This code expires in 5 minutes.</p>",
    "</div>",
  ].join("");
}

async function issueSignInOtp(db: Db, email: string) {
  const otp = generateNumericOtp();
  const now = new Date();
  const identifier = `sign-in-otp-${email}`;

  await db.delete(authVerifications).where(eq(authVerifications.identifier, identifier));
  await db.insert(authVerifications).values({
    id: randomUUID(),
    identifier,
    value: `${otpHash(otp)}:0`,
    expiresAt: new Date(now.getTime() + AUTH_OTP_EXPIRES_IN_MS),
    createdAt: now,
    updatedAt: now,
  });

  await sendGraphMail(getGraphMailConfig(), {
    to: email,
    subject: "Paperclip verification code",
    html: buildOtpEmailHtml({ email, otp }),
  });
}

async function ensureBootstrapAdminForUser(db: Db, userId: string) {
  const existingAdmins = await db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"));
  if (existingAdmins.length > 0) return;
  await db.insert(instanceUserRoles).values({
    userId,
    role: "instance_admin",
  });
}

async function loadCurrentUserProfile(db: Db, userId: string) {
  const user = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    throw unauthorized("Signed-in user not found");
  }

  return currentUserProfileSchema.parse({
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  });
}

export function authRoutes(db: Db) {
  const router = Router();

  router.post("/sign-in/email", (_req, res) => {
    res.status(410).json({
      error: "Password sign-in now requires one-time email verification. Use /api/auth/password/start.",
      code: "OTP_REQUIRED_SIGN_IN",
    });
  });

  router.post("/sign-up/email", (_req, res) => {
    res.status(410).json({
      error: "Account creation now requires one-time email verification. Use /api/auth/password/start.",
      code: "OTP_REQUIRED_SIGN_UP",
    });
  });

  router.post("/password/start", validate(passwordStartSchema), async (req, res) => {
    const payload = passwordStartSchema.parse(req.body);
    const email = payload.email.trim().toLowerCase();

    if (payload.mode === "sign_up") {
      const name = payload.name?.trim() ?? "";
      if (!name) {
        res.status(400).json({ error: "Name is required", code: "NAME_REQUIRED" });
        return;
      }
      if (payload.password.trim().length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters", code: "PASSWORD_TOO_SHORT" });
        return;
      }

      const existingUser = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.email, email))
        .then((rows) => rows[0] ?? null);
      if (existingUser) {
        throw conflict("An account already exists for this email", { code: "USER_ALREADY_EXISTS" });
      }

      const now = new Date();
      const userId = randomUUID();
      await db.insert(authUsers).values({
        id: userId,
        name,
        email,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(authAccounts).values({
        id: randomUUID(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: await bcrypt.hash(payload.password, 12),
        createdAt: now,
        updatedAt: now,
      });
      await issueSignInOtp(db, email);
      res.json({ status: "otp_required", email });
      return;
    }

    const userWithAccount = await db
      .select({
        userId: authUsers.id,
        passwordHash: authAccounts.password,
      })
      .from(authUsers)
      .innerJoin(
        authAccounts,
        and(eq(authAccounts.userId, authUsers.id), eq(authAccounts.providerId, "credential")),
      )
      .where(eq(authUsers.email, email))
      .then((rows) => rows[0] ?? null);

    if (!userWithAccount?.passwordHash) {
      throw unauthorized("Invalid email or password");
    }

    const passwordMatches = await bcrypt.compare(payload.password, userWithAccount.passwordHash);
    if (!passwordMatches) {
      throw unauthorized("Invalid email or password");
    }

    await ensureBootstrapAdminForUser(db, userWithAccount.userId);
    await issueSignInOtp(db, email);
    res.json({ status: "otp_required", email });
  });

  router.get("/get-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await loadCurrentUserProfile(db, req.actor.userId);
    await ensureBootstrapAdminForUser(db, req.actor.userId);
    res.json(authSessionSchema.parse({
      session: {
        id: `paperclip:${req.actor.source ?? "none"}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user,
    }));
  });

  router.get("/profile", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    res.json(await loadCurrentUserProfile(db, req.actor.userId));
  });

  router.patch("/profile", validate(updateCurrentUserProfileSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const patch = updateCurrentUserProfileSchema.parse(req.body);
    const now = new Date();

    const updated = await db
      .update(authUsers)
      .set({
        name: patch.name,
        ...(patch.image !== undefined ? { image: patch.image } : {}),
        updatedAt: now,
      })
      .where(eq(authUsers.id, req.actor.userId))
      .returning({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      throw unauthorized("Signed-in user not found");
    }

    res.json(currentUserProfileSchema.parse({
      id: updated.id,
      email: updated.email ?? null,
      name: updated.name ?? null,
      image: updated.image ?? null,
    }));
  });

  return router;
}
