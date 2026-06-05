import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Password hashing with Node's built-in scrypt — no native build deps (unlike
// bcrypt/argon2, which break the Electron/Windows packaging). Stored format:
//   scrypt$N$r$p$saltB64$hashB64
// scryptSync is blocking; fine at MVP login/signup volume.
const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: Number(nStr), r: Number(rStr), p: Number(pStr),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
