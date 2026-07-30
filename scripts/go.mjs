#!/usr/bin/env node
// 一键构建并运行中台 + 观察控制台。
//
// 用法：
//   npm run go            # 开发模式：构建 console → tsx watch 起中台（默认）
//   npm run go:prod       # 生产模式：构建 console + tsc → node dist/server.js
//   node scripts/go.mjs [prod]
//
// 行为：根 node_modules / console/node_modules 缺失时自动 install；每次都重建 console
// 以保证 /console 是最新；最后启动中台。Ctrl+C 退出。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE = resolve(ROOT, "console");
const PROD = process.argv.slice(2).includes("prod");

function run(cmd, args, cwd = ROOT) {
  console.log(`\n▶ ${cmd} ${args.join(" ")}${cwd !== ROOT ? `   (in ${cwd})` : ""}`);
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (res.status !== 0) {
    console.error(`\n✗ 失败：${cmd} ${args.join(" ")} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

function readEnv() {
  const env = {};
  const p = resolve(ROOT, ".env");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

console.log(PROD ? "【生产模式】构建并运行" : "【开发模式】构建 console + tsx watch");

// 1) 根依赖（tsx / tsc 等）
if (!existsSync(resolve(ROOT, "node_modules"))) {
  console.log("\n· 根 node_modules 缺失，先 npm install …");
  run("npm", ["install"]);
}
// 2) console 依赖
if (!existsSync(resolve(CONSOLE, "node_modules"))) {
  console.log("\n· console/node_modules 缺失，先 npm install …");
  run("npm", ["install"], CONSOLE);
}
// 3) 构建 console SPA（保证 /console 最新）
run("npm", ["run", "build"], CONSOLE);

// 4) 生产模式先 tsc + prisma generate（确保 Prisma client/引擎最新）
if (PROD) {
  run("npm", ["run", "build"]);
  run("npm", ["run", "db:generate"]);
}

// 5) 启动中台（前台，Ctrl+C 退出）
const env = readEnv();
const host = env.RUNTIME_HOST || "127.0.0.1";
const port = env.RUNTIME_PORT || 9876;
console.log(`\n· 启动中台（${PROD ? "node dist/server.js" : "tsx watch"}）…`);
console.log(`  观察控制台:  http://${host}:${port}/console`);
console.log(`  AG-UI 入口:  http://${host}:${port}/agent/{agentId}/run\n`);

const final = spawnSync("npm", PROD ? ["start"] : ["run", "dev"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: true,
});
process.exit(final.status ?? 0);
