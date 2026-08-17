import { describe, it, expect } from "vitest";
import {
  stableStringify,
  toolSignature,
  schemaKeys,
  createToolDedupCache,
  replayDedup,
} from "./tool-dedup.js";

describe("tool dedup", () => {
  it("stableStringify 对键序无关（对象键排序后序列化）", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("toolSignature 拼名字与参数签名", () => {
    expect(toolSignature("saleshub_order_stats", { startDate: "2026-08-01" })).toBe(
      'saleshub_order_stats|{"startDate":"2026-08-01"}'
    );
  });

  it("schemaKeys 只取对象 schema 的键", () => {
    const keys = schemaKeys({ shape: { a: {}, b: {} } });
    expect(keys.sort()).toEqual(["a", "b"]);
    expect(schemaKeys(null)).toEqual([]);
    expect(schemaKeys({})).toEqual([]);
  });

  it("首次调用不入缓存不命中，回放 null", () => {
    const cache = createToolDedupCache();
    const hit = replayDedup(cache, "saleshub_order_stats", { a: 1 }, ["a"]);
    expect(hit).toBeNull();
  });

  it("同签名且已内联则命中回放，并带信任提示", () => {
    const cache = createToolDedupCache();
    cache.set(toolSignature("saleshub_list_orders", { status: "未收款" }), {
      result: { total: 114 },
      inline: true,
    });
    const hit = replayDedup(cache, "saleshub_list_orders", { status: "未收款" }, ["status"]);
    expect(hit).not.toBeNull();
    expect(hit!.replay).toContain("去重回放");
    expect(hit!.replay).toContain('{"total":114}');
  });

  it("上次结果外置（带 ref）也命中：回放 ref+summary 并引导 getArtifact 取回，而非重查", () => {
    const cache = createToolDedupCache();
    cache.set(toolSignature("saleshub_list_orders", {}), {
      result: { ref: "art-abc", summary: "共344笔" },
      inline: false,
      ref: "art-abc",
    });
    const hit = replayDedup(cache, "saleshub_list_orders", {}, []);
    expect(hit).not.toBeNull();
    expect(hit!.replay).toContain("art-abc");
    expect(hit!.replay).toContain("getArtifact");
    expect(hit!.replay).toContain("不要重新调用");
  });

  it("上次结果外置但缺 ref（异常态）不命中，正常执行", () => {
    const cache = createToolDedupCache();
    cache.set(toolSignature("saleshub_list_orders", {}), { result: { ref: "x" }, inline: false });
    const hit = replayDedup(cache, "saleshub_list_orders", {}, []);
    expect(hit).toBeNull();
  });

  it("元工具（now/recall）不参与去重", () => {
    const cache = createToolDedupCache();
    cache.set(toolSignature("now", {}), { result: "2026-08-11", inline: true });
    expect(replayDedup(cache, "now", {}, [])).toBeNull();
    cache.set(toolSignature("recall", {}), { result: {}, inline: true });
    expect(replayDedup(cache, "recall", {}, [])).toBeNull();
  });
});
