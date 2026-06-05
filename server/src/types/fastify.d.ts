import type { UserRole, UserStatus } from "../db/users.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated user, attached by the onRequest hook in index.ts.
     *  Present on every route except the public ones (/health, /auth/*). */
    user?: {
      id: string;
      email: string;
      role: UserRole;
      status: UserStatus;
    };
  }
}
