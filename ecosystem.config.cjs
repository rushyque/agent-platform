/**
 * agent-platform PM2 托管配置
 *
 * 吸收 mail-gateway / saleshub / svc-monitor 三处的经验：
 * - cwd 用 __dirname 绝对定位（无论从哪启动 pm2 都能正确定位项目根，.env 与 JSONL 落盘不漂移）
 * - 项目是 type:module，生态文件必须用 .cjs 后缀（否则 pm2 require(ESM) 会报错）
 * - 运行构建产物 dist/server.js（生产版），不再用 tsx watch
 * - PM2 的 out/error 只捕应用 console 输出，写到独立文件；
 *   结构化 JSONL 由应用自身 JsonlSink 写 logs/agent-platform.log，互不混用
 */
module.exports = {
  apps: [
    {
      name: "agent-platform",
      cwd: __dirname,
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      windowsHide: true, // 隐藏控制台窗口
      watch: false,
      autorestart: true, // 崩溃自动重启
      max_memory_restart: "1G", // 超内存自动重启兜底
      kill_timeout: 10, // 停止超时（秒）
      merge_logs: true,
      time: true, // 日志行带时间戳
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/agent-monitor.err.log", // PM2 捕应用 stderr
      out_file: "./logs/agent-monitor.out.log", // PM2 捕应用 stdout
      env: {
        NODE_ENV: "production",
        RUNTIME_HOST: "192.168.1.155",
        RUNTIME_PORT: "9876",
      },
    },
  ],
};
