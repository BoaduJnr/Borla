import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { JwtPayload, Role } from "../types.js";

export function signAccessToken(userId: string, role: Role): string {
  const payload: JwtPayload = { sub: userId, role, type: "access" };
  const options: jwt.SignOptions = { expiresIn: config.accessTokenTtl as jwt.SignOptions["expiresIn"] };
  return jwt.sign(payload, config.jwtAccessSecret, options);
}

export function signRefreshToken(userId: string, role: Role): string {
  const payload: JwtPayload = { sub: userId, role, type: "refresh" };
  const options: jwt.SignOptions = { expiresIn: config.refreshTokenTtl as jwt.SignOptions["expiresIn"] };
  return jwt.sign(payload, config.jwtRefreshSecret, options);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtAccessSecret) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtRefreshSecret) as JwtPayload;
}
