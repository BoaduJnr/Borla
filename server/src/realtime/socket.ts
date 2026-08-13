import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { verifyAccessToken } from "../utils/jwt.js";
import { redis } from "../redis/client.js";

/**
 * Realtime layer per borla-technical-design.md §8: JWT-authed on connect, one private room
 * per user (`user:{id}`). The Redis adapter (Technical_Debt_Plan.md TD-05) means `emitToUser`
 * correctly reaches a user connected to a *different* Node instance — required for any future
 * horizontal scale-out; harmless with the single instance this still deploys as today.
 */

let io: SocketIOServer | null = null;

// userId -> Set of socket ids, scoped to *this* instance. Only used for a same-instance
// presence hint; the Redis adapter (not this map) is what makes cross-instance emit correct.
const connectedUsers = new Map<string, Set<string>>();

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: "*" }, // same-origin in production; local dev serves client separately
    adapter: createAdapter(redis.duplicate(), redis.duplicate()),
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("unauthorized"));
    try {
      const payload = verifyAccessToken(token);
      (socket as any).userId = payload.sub;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = (socket as any).userId as string;
    socket.join(`user:${userId}`);

    if (!connectedUsers.has(userId)) connectedUsers.set(userId, new Set());
    connectedUsers.get(userId)!.add(socket.id);

    socket.on("disconnect", () => {
      const set = connectedUsers.get(userId);
      set?.delete(socket.id);
      if (set && set.size === 0) connectedUsers.delete(userId);
    });
  });

  return io;
}

/** Same-instance hint only — with multiple instances, a user connected elsewhere still gets
 *  the event via the Redis adapter even though this returns false for them locally. */
export function isUserConnected(userId: string): boolean {
  return (connectedUsers.get(userId)?.size ?? 0) > 0;
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function getIo(): SocketIOServer {
  if (!io) throw new Error("Socket.IO not initialised yet");
  return io;
}
