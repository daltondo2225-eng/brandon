import { config } from "../config.js";
import { hashPassword } from "../auth/password.js";
import { db, tx } from "./client.js";
import { createUser, findUserByEmail, setUserRole, setUserStatus } from "./users.js";

// First-boot setup: ensure the super-admin account exists and that any
// pre-existing (single-user-era) rows are owned by them. Idempotent — safe to
// run on every server start.
export function bootstrap(): void {
  const email = config.superadminEmail;
  const password = config.superadminPassword;

  if (!email || !password) {
    // No super-admin configured. Warn if there are ownerless rows that will be
    // invisible to everyone until an admin claims them.
    const orphan = countOwnerless();
    if (orphan > 0) {
      console.warn(
        `[brandon] ${orphan} ownerless rows exist but BRANDON_SUPERADMIN_EMAIL/PASSWORD ` +
        "are not set — set them so existing data is assigned to the super-admin.",
      );
    }
    return;
  }

  tx(() => {
    let admin = findUserByEmail(email);
    if (!admin) {
      admin = createUser({
        email,
        passwordHash: hashPassword(password),
        role: "superadmin",
        status: "active",
      });
    } else {
      // Ensure an existing account with this email is a usable super-admin.
      if (admin.role !== "superadmin") setUserRole(admin.id, "superadmin");
      if (admin.status !== "active") setUserStatus(admin.id, "active");
    }

    // Backfill ownerless rows to the super-admin.
    for (const table of ["profiles", "sessions", "companies"]) {
      db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(admin.id);
    }
  });
}

function countOwnerless(): number {
  let total = 0;
  for (const table of ["profiles", "sessions", "companies"]) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id IS NULL`).get() as { n: number };
      total += Number(r.n);
    } catch { /* table/column may not exist yet */ }
  }
  return total;
}
