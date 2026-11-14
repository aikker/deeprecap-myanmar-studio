import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

interface FirebaseAppletConfig {
  projectId: string;
}

let cachedProjectId: string | null = null;
function getFirebaseProjectId(): string {
  if (cachedProjectId) return cachedProjectId;
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as FirebaseAppletConfig;
  cachedProjectId = parsed.projectId;
  return cachedProjectId;
}

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  )
);

export interface VerifiedFirebaseUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}

export async function verifyFirebaseBearerToken(
  req: express.Request
): Promise<VerifiedFirebaseUser | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  try {
    const projectId = getFirebaseProjectId();
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    const uid = typeof payload.sub === 'string' ? payload.sub : '';
    if (!uid) return null;
    return {
      uid,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified: Boolean(payload.email_verified),
    };
  } catch {
    return null;
  }
}

export async function requireFirebaseUser(
  req: express.Request,
  res: express.Response
): Promise<VerifiedFirebaseUser | null> {
  const user = await verifyFirebaseBearerToken(req);
  if (!user) {
    res.status(401).json({
      error: 'Please sign in with your Google account first.',
    });
    return null;
  }
  return user;
}
