import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Block non-active accounts from an action (chat + all mutations). Pending users
 * can log in and browse their own (empty) data, but can't spend the operator's
 * LLM budget or create data until the super-admin approves them.
 * Returns true if the request should STOP (reply already sent).
 */
export function requireActive(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.status !== "active") {
    reply.code(403).send({ error: "account_pending_approval" });
    return true;
  }
  return false;
}

/** Block non-super-admins. Returns true if the request should STOP. */
export function requireSuperadmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.role !== "superadmin") {
    reply.code(403).send({ error: "forbidden" });
    return true;
  }
  return false;
}
