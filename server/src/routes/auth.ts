import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signToken } from "../auth/jwt.js";
import { createUser, findUserByEmail, getUserById, toPublicUser } from "../db/users.js";

const Credentials = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // Open signup → account starts 'pending' (super-admin must approve before chat).
  app.post("/auth/signup", async (req, reply) => {
    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    const { email, password } = parsed.data;

    if (findUserByEmail(email)) return reply.conflict("An account with this email already exists");

    const user = createUser({
      email,
      passwordHash: hashPassword(password),
      role: "user",
      status: "pending",
    });
    const token = await signToken({ sub: user.id, role: user.role, status: user.status });
    return { token, user: toPublicUser(user) };
  });

  app.post("/auth/login", async (req, reply) => {
    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("Invalid email or password");
    const { email, password } = parsed.data;

    const user = findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.unauthorized("Invalid email or password");
    }
    if (user.status === "disabled") return reply.forbidden("This account has been disabled");

    const token = await signToken({ sub: user.id, role: user.role, status: user.status });
    return { token, user: toPublicUser(user) };
  });

  // Live identity — the client polls this to detect pending → active transitions.
  app.get("/auth/me", async (req, reply) => {
    if (!req.user) return reply.unauthorized();
    const user = getUserById(req.user.id);
    if (!user) return reply.unauthorized();
    return { user: toPublicUser(user) };
  });
}
