import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
import type { UserRole, UserStatus } from "../db/users.js";

const secret = new TextEncoder().encode(config.jwtSecret);
const ALG = "HS256";
const EXPIRY = "7d";

export interface TokenPayload {
  sub: string;        // user id
  role: UserRole;
  status: UserStatus; // hint only — the auth hook re-reads the DB for the live value
}

export async function signToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ role: payload.role, status: payload.status })
    .setProtectedHeader({ alg: ALG })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
  return {
    sub: String(payload.sub),
    role: payload.role as UserRole,
    status: payload.status as UserStatus,
  };
}
