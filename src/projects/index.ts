// 项目聚合点 —— 平台唯一的"已知项目列表"。
// 平台核心不依赖任何具体项目；每个接入项目在此 registerAgent（agent 路由）
// 与 registerProjectRoutes（自有 HTTP 路由）即可被驱动。
import { registerAgent } from "../core/agent-router.js";
import { registerProjectRoutes } from "../core/http-router.js";
import { starlinkFactoryAgentConfig } from "./starlink-factory/agent-config.js";
import { freightInquiryAgentConfig } from "./freight-inquiry/agent-config.js";
import { dbDemoAgentConfig } from "./db-demo/agent-config.js";
import { freightInquiryRoutes } from "./freight-inquiry/http.js";
import { starlinkFactoryRoutes } from "./starlink-factory/http.js";

export function registerAllProjects(): void {
  registerAgent(starlinkFactoryAgentConfig);
  registerAgent(freightInquiryAgentConfig);
  registerAgent(dbDemoAgentConfig);
  registerProjectRoutes("/inquiry", freightInquiryRoutes);
  registerProjectRoutes("/game", starlinkFactoryRoutes);
}
