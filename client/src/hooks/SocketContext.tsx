import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import { getAccessToken } from "../api/client";
import { useAuth } from "./AuthContext";

const SocketCtx = createContext<Socket | null>(null);

/**
 * One socket connection per logged-in session (design §8: JWT-authed, room `user:{id}`).
 * Reconnects automatically if the access token rotates (e.g. after a refresh).
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setSocket(null);
      return;
    }
    const token = getAccessToken();
    if (!token) return;

    const s = io({ auth: { token }, path: "/socket.io" });
    socketRef.current = s;
    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [user?.id]);

  return <SocketCtx.Provider value={socket}>{children}</SocketCtx.Provider>;
}

export function useSocket() {
  return useContext(SocketCtx);
}
