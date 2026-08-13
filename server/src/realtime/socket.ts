import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { verifyAccessToken } from "../utils/jwt.js";

/**
 * Realtime layer per borla-technical-design.md §8: JWT-authed on connect, one private room
 * per user (`user:{id}`). No Redis adapter (Technical_Debt_Plan.md, TD-05) — this only scales
 * to a single Node instance, which is the correct trade-off for a single free-tier deploy.
 */

let io: SocketIOServer | null = null;

// userId -> Set of socket ids. In-memory replacement for the design's `socket:{userId}` Redis
// key — lost on restart, which is acceptable because clients reconnect and resync via REST.
const connectedUsers = new Map<string, Set<string>>();

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: "*" }, // same-origin in production; local dev serves client separately
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
