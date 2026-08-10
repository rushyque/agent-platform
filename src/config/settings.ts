import "dotenv/config";
import { z } from "zod";

// 多套模型：ACTIVE_MODEL 选当前组（值=前缀小写，如 deepseek / glm）。
// 每组三件套 <PREFIX>_API_KEY / _MODEL / _BASE_URL。消费方仍读 settings.DEEPSEEK_*，
// 这里按 ACTIVE_MODEL 把选中组的值写进 DEEPSEEK_*（缺失回退 DEEPSEEK_*），消费代码不用改。
const envSchema = z.object({
  ACTIVE_MODEL: z.string().default("deepseek"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().optional(),
  // 思考强度：deepseek-v4-flash 网关默认不返回思考体，需 reasoning_effort 触发。
  // 有效值 none/minimal/low/medium/high/xhigh（GLM 等默认出思考且不认此参数，留空即不传）。
  REASONING_EFFORT: z.string().optional(),
  GLM_API_KEY: z.string().optional(),
  GLM_MODEL: z.string().optional(),
  GLM_BASE_URL: z.string().optional(),
  // 运行环境与日志落地（符合《高质量日志规范》§3 公共字段 + §12 落盘/轮转/保留）
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  LOG_DIR: z.string().default("logs"),
  LOG_RETENTION_DAYS: z.coerce.number().default(30),
  LOG_MAX_MB: z.coerce.number().default(10),
  RUNTIME_PORT: z.coerce.number().default(9876),
  RUNTIME_HOST: z.string().default("127.0.0.1"),
  DB_HOST: z.string(),
  DB_PORT: z.coerce.number().default(1433),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  // 中台自有状态库（Prisma）：默认 ai_harness_db，与业务库 DB_NAME(ai_platform_db) 分开。
  HARNESS_DB_NAME: z.string().default("ai_harness_db"),
  // TTL 清理：事件/审计/artifact 保留天数（cleanup.ts 用；缺省由 cleanup 自定）。
  RETENTION_DAYS: z.coerce.number().optional(),
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
  // 限流与防滥用（见 core/middleware/rate-limit.ts）：
  // 滑动窗口（毫秒）内，单 IP 基础配额与 /agent/* LLM 入口额外配额；全局并发上限兜底。
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  RATE_LIMIT_AGENT_MAX: z.coerce.number().default(20),
  RATE_LIMIT_CONCURRENCY: z.coerce.number().default(50),
});

const __raw = envSchema.parse(process.env);
const __prefix = (__raw.ACTIVE_MODEL || "deepseek").toUpperCase();
export const settings = {
  ...__raw,
  appName: "agent-platform",
  env: __raw.NODE_ENV,
  DEEPSEEK_API_KEY: (process.env[`${__prefix}_API_KEY`] ?? __raw.DEEPSEEK_API_KEY) as string,
  DEEPSEEK_MODEL: (process.env[`${__prefix}_MODEL`] ?? __raw.DEEPSEEK_MODEL) as string,
  DEEPSEEK_BASE_URL: (process.env[`${__prefix}_BASE_URL`] ?? __raw.DEEPSEEK_BASE_URL) as string,
  // Prisma 连 ai_harness_db 的连接串（sqlserver JDBC 风格，分号分隔）。
  // 凭据复用 DB_*；密码含特殊字符（: \ = ; / [ ] 等）时需用 {...} 包裹或 URL 编码。
  // socketTimeout≈旧 requestTimeout(15s)；poolTimeout 防 DB 卡住时取池无限挂。
  HARNESS_DATABASE_URL:
    `sqlserver://${__raw.DB_HOST}:${__raw.DB_PORT};database=${__raw.HARNESS_DB_NAME};user=${__raw.DB_USER};password=${__raw.DB_PASSWORD};encrypt=false;trustServerCertificate=true;schema=dbo;connectTimeout=5;socketTimeout=15;poolTimeout=10`,
  // 限流配置（透传 + 默认值兜底，供 rate-limit.ts 使用）
  RATE_LIMIT_WINDOW_MS: __raw.RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX: __raw.RATE_LIMIT_MAX,
  RATE_LIMIT_AGENT_MAX: __raw.RATE_LIMIT_AGENT_MAX,
  RATE_LIMIT_CONCURRENCY: __raw.RATE_LIMIT_CONCURRENCY,
};
