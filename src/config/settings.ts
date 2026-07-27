import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string(),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  DEEPSEEK_BASE_URL: z.string(),
  RUNTIME_PORT: z.coerce.number().default(9876),
  RUNTIME_HOST: z.string().default("127.0.0.1"),
  DB_HOST: z.string(),
  DB_PORT: z.coerce.number().default(1433),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  JWT_SECRET: z.string(),
  // 观察控制台：默认开启；设 OBSERVE_ENABLED=false 关闭。
  // 注意 env 永远是字符串，"false" 经 coerce.boolean() 会变 true，故用字符串比较。
  OBSERVE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false")
    .default("true"),
  // 可选 admin token；配置后 /observe/stream 与 /console/api/* 需带 ?token= 或 Authorization。
  OBSERVE_TOKEN: z.string().optional(),
});

export const settings = envSchema.parse(process.env);
