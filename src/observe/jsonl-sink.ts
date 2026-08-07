import fs from "node:fs";
import path from "node:path";

// 符合《高质量日志规范》§12 的 JSONL 文件落盘：
//   - 主日志 <dir>/<app>.log，error/fatal 另写 <dir>/<app>.error.log（快速筛错）
//   - 按大小 + 按天双触发轮转，按保留天数清理旧文件
//   - 异步批量写（250ms 合并/appendFile），进程退出前同步兜底，避免丢末批
export interface JsonlSinkOptions {
  dir: string;
  appName: string;
  maxMb: number;
  retentionDays: number;
}

export class JsonlSink {
  private readonly mainPath: string;
  private readonly errorPath: string;
  private queue: Array<{ line: string; error: boolean }> = [];
  private timer: NodeJS.Timeout | null = null;
  private dayStamp = "";
  private flushing = false;

  constructor(private readonly opts: JsonlSinkOptions) {
    this.mainPath = path.join(opts.dir, `${opts.appName}.log`);
    this.errorPath = path.join(opts.dir, `${opts.appName}.error.log`);
    this.dayStamp = this.today();
    this.ensureDir();
    this.prune();
    // 退出兜底：未刷盘的末批同步写掉（best-effort）
    process.on("exit", () => {
      this.flushSync();
    });
  }

  write(line: string, error: boolean): void {
    this.queue.push({ line, error });
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 250);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.opts.dir, { recursive: true });
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;
    this.flushing = true;
    try {
      const now = this.today();
      if (now !== this.dayStamp) {
        this.dayStamp = now;
        this.rotateDaily();
      }
      const main = batch.filter((b) => !b.error).map((b) => b.line);
      const errs = batch.filter((b) => b.error).map((b) => b.line);
      if (main.length) await this.appendWithRotate(this.mainPath, main);
      if (errs.length) await this.appendWithRotate(this.errorPath, errs);
      this.prune();
    } finally {
      this.flushing = false;
    }
  }

  private async appendWithRotate(filePath: string, lines: string[]): Promise<void> {
    await this.rotateBySize(filePath);
    try {
      await fs.promises.appendFile(filePath, lines.join("\n") + "\n", "utf8");
    } catch {
      /* 写盘失败不阻塞业务（本服务 DB-optional 同理） */
    }
  }

  private async rotateBySize(filePath: string): Promise<void> {
    try {
      const st = await fs.promises.stat(filePath);
      const maxBytes = this.opts.maxMb * 1024 * 1024;
      if (st.size > maxBytes) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await fs.promises.rename(filePath, `${filePath}.${stamp}`);
      }
    } catch {
      // 文件尚不存在，跳过
    }
  }

  private rotateDaily(): void {
    this.rotateOne(this.mainPath);
    this.rotateOne(this.errorPath);
  }

  private rotateOne(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, `${filePath}.${this.dayStamp}`);
      }
    } catch {
      /* ignore */
    }
  }

  private prune(): void {
    try {
      const cutoff = Date.now() - this.opts.retentionDays * 24 * 3600 * 1000;
      const prefix = `${this.opts.appName}.log`;
      for (const f of fs.readdirSync(this.opts.dir)) {
        if (!f.startsWith(prefix)) continue;
        const full = path.join(this.opts.dir, f);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  private flushSync(): void {
    const batch = this.queue;
    this.queue = [];
    if (!batch.length) return;
    const main = batch.filter((b) => !b.error).map((b) => b.line);
    const errs = batch.filter((b) => b.error).map((b) => b.line);
    try {
      this.ensureDir();
      if (main.length) fs.appendFileSync(this.mainPath, main.join("\n") + "\n", "utf8");
      if (errs.length) fs.appendFileSync(this.errorPath, errs.join("\n") + "\n", "utf8");
    } catch {
      /* ignore */
    }
  }
}
