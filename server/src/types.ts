export type Role = "household" | "collector" | "admin";

export interface AuthedUser {
  id: string;
  role: Role;
  phone: string;
  verified: boolean;
  suspended: boolean;
  display_name: string | null;
}

export interface JwtPayload {
  sub: string; // user id
  role: Role;
  type: "access" | "refresh";
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}
