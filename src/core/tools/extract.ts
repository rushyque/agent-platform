import { generateObject } from "ai";
import type { ZodType } from "zod";
import { createLLMClient } from "../llm.js";

// runExtract —— 工具内部用 LLM 把非结构化文本抽成结构化数据（helper，非模型直调工具）。
// 不做模型直调工具：模型自己描述 schema 不靠谱；schema 应由项目代码用 Zod 确定性定义。
//
// 用法（项目工具 execute 内）：
//   const quote = await runExtract({
//     source: emailBody,
//     schema: z.object({ freight: z.number(), unitPrice: z.number() }),
//     instruction: "提取报价字段",
//   });
export async function runExtract<T>(
  opts: { source: string; schema: ZodType<T>; instruction?: string; model?: string }
): Promise<T> {
  const { source, schema, instruction, model } = opts;
  const { object } = await generateObject({
    model: createLLMClient(model),
    schema,
    prompt: [
      instruction ?? "从以下内容中提取结构化信息，严格按 schema 输出，找不到的字段留空或 null。",
      "",
      "内容：",
      source,
    ].join("\n"),
  });
  return object;
}
