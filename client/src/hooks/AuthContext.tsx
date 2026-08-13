import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, clearTokens, getAccessToken, setTokens } from "../api/client";

export type Role = "household" | "collector" | "admin";
export interface User {
  id: string;
  role: Role;
  phone: string;
  display_name: string | null;
  verified: boolean;
  suspended: boolean;
}

interface AuthState {
  user: User | null;
  profile: any;
  loading: boolean;
  login: (access: string, refresh: string, user: User) => void;
  logout: () => void;
  refreshProfile: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  async function refreshProfile() {
    try {
      const data = await api<{ user: User; profile: any }>("/auth/me");
      setUser(data.user);
      setProfile(data.profile);
    } catch {
      setUser(null);
      setProfile(null);
      clearTokens();
    }
  }

  useEffect(() => {
    if (!getAccessToken()) {
      setLoading(false);
      return;
    }
    refreshProfile().finally(() => setLoading(false));
  }, []);

  function login(access: string, refresh: string, u: User) {
    setTokens(access, refresh);
    setUser(u);
    void refreshProfile();
  }

  function logout() {
    clearTokens();
    setUser(null);
    setProfile(null);
  }

  return (
    <AuthCtx.Provider value={{ user, profile, loading, login, logout, refreshProfile }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
