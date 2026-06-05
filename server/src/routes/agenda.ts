import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listAgenda } from "../db/agenda.js";

const ListQuery = z.object({
  profileId: z.string().optional(),
});

export async function registerAgendaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/agenda", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    return { items: listAgenda(req.user!.id, parsed.data.profileId) };
  });
}
