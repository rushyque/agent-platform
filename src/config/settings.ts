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
});

export const settings = envSchema.parse(process.env);
