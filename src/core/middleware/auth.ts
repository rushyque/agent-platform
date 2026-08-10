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
    // userId 一律归一为字符串：业务 JWT 的 sub/id 常为数字（如 SQL 主键），
    // 而审计表的 userId 列是字符串。不归一会在 recordRun 落库时被 Prisma 拒绝。
    const userId = String(decoded.id ?? decoded.userId ?? decoded.sub ?? "");
    return {
      ...decoded,
      userId,
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
