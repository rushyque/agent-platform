import jwt from "jsonwebtoken";

const TOKEN_PREFIX = "Bearer ";

export function extractToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith(TOKEN_PREFIX)) return null;
  return authHeader.slice(TOKEN_PREFIX.length);
}

export function verifyToken(
  token: string,
  secret: string
): { userId: string; [key: string]: any } | null {
  try {
    const decoded = jwt.verify(token, secret) as any;
    return {
      userId: decoded.id || decoded.userId || decoded.sub || "",
      ...decoded,
    };
  } catch {
    return null;
  }
}

// 签发 JWT（开发/测试用，如游戏前端 dev-login）。生产对接应由项目自有 SSO 签发。
export function signToken(
  payload: Record<string, any>,
  secret: string,
  expiresIn = "7d"
): string {
  return jwt.sign(payload, secret, { expiresIn } as any);
}
