import type { FastifyInstance } from "fastify";
import { requireSuperadmin } from "../auth/guards.js";
import { getUserById, listUsers, setUserStatus } from "../db/users.js";
import { getAllUsageTotals, getRecentCalls } from "../db/usage.js";

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/users", async (req, reply) => {
    if (requireSuperadmin(req, reply)) return;
    return { users: listUsers() };
  });

  // Per-user usage totals across all users (admin only).
  app.get("/admin/usage", async (req, reply) => {
    if (requireSuperadmin(req, reply)) return;
    return { usage: getAllUsageTotals() };
  });

  // Recent calls for one user (admin drill-in).
  app.get<{ Params: { id: string } }>("/admin/usage/:id", async (req, reply) => {
    if (requireSuperadmin(req, reply)) return;
    return { calls: getRecentCalls(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/approve", async (req, reply) => {
    if (requireSuperadmin(req, reply)) return;
    const updated = setUserStatus(req.params.id, "active");
    if (!updated) return reply.notFound("User not found");
    return updated;
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/disable", async (req, reply) => {
    if (requireSuperadmin(req, reply)) return;
    if (req.params.id === req.user!.id) return reply.badRequest("You can't disable your own account");
    const target = getUserById(req.params.id);
    if (!target) return reply.notFound("User not found");
    const updated = setUserStatus(req.params.id, "disabled");
    return updated!;
  });
}
