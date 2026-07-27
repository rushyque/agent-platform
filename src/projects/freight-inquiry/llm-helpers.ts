// LLM 封装 —— 工具内部用 generateObject 做"结构化提取"，主上下文只看结果 + trace。
// 用裸模型（不挂 compaction middleware）避免递归，模式参考 src/core/context/summarizer.ts:11-20。
// 设计依据见记忆 nl2sql-design：上下文隔离防 DeepSeek 多步幻觉，trace 给主模型适度透明度。
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { settings } from '../../config/settings.js';
import type { TraceRound } from '../../types/agent-config.js';
import {
  PREFERENCE_LABEL,
  PREFERENCE_HINT,
} from './types.js';
import type { ParsedQuote, Evaluation, Preference, QuoteEmail, Forwarder, CargoInquiry, Surcharges } from './types.js';
import { logger } from '../../observe/logger.js';

let rawModelCache: any = null;
function getRawModel(): any {
  if (!rawModelCache) {
    const openai = createOpenAI({
      apiKey: settings.DEEPSEEK_API_KEY,
      baseURL: settings.DEEPSEEK_BASE_URL,
    });
    // DeepSeek 仅支持 Chat Completions，必须 openai.chat(model)
    rawModelCache = (openai as any).chat(settings.DEEPSEEK_MODEL);
  }
  return rawModelCache;
}

// ---------- 解析：报价/议价邮件正文 → ParsedQuote[] ----------
const ParsedQuoteItemSchema = z.object({
  forwarderId: z.string().describe('货代 ID，必须与名册标注一致'),
  freightTotal: z.number().describe('总运费，含全部附加费，RMB'),
  unitPrice: z.number().describe('单价 元/kg'),
  fuel: z.number().describe('燃油附加费，未提及填 0'),
  security: z.number().describe('安检费，未提及填 0'),
  war: z.number().optional().describe('战争险，未提及则不填'),
  transitDays: z.number().describe('运输时效，工作日'),
  airline: z.string().describe('承运航司'),
  flightSchedule: z.string().describe('航班周期/起飞日'),
  validity: z.string().describe('报价有效期'),
  remarks: z.string().optional().describe('备注'),
});

export async function parseQuoteEmailsWithLLM(
  quoteEmails: QuoteEmail[],
  forwarders: Forwarder[],
): Promise<{ parsed: ParsedQuote[]; trace: TraceRound[] }> {
  if (quoteEmails.length === 0) {
    return { parsed: [], trace: [{ artifact: '0 封邮件', outcome: 'no_data' }] };
  }
  const roster = quoteEmails.map((q) => {
    const fid = q.truthQuote?.forwarderId ?? 'unknown';
    const fwd = forwarders.find((f) => f.id === fid);
    return { forwarderId: fid, name: fwd?.name ?? q.from };
  });
  const rosterLine = roster.map((r) => `- forwarderId: ${r.forwarderId}，名称: ${r.name}`).join('\n');
  const mailBlock = quoteEmails
    .map((q, i) => `[${i + 1}] forwarderId=${q.truthQuote?.forwarderId ?? 'unknown'}\n${q.body}`)
    .join('\n\n---\n\n');

  const t0 = Date.now();
  try {
    const { object } = await generateObject({
      model: getRawModel(),
      schemaName: 'parsed_quotes',
      schemaDescription: '从多封货代报价/议价邮件中提取的结构化报价数组',
      schema: z.object({ items: z.array(ParsedQuoteItemSchema) }),
      system:
        '你是国际空运报价邮件解析助手。从货代回复的自然语言邮件中精确提取运费、附加费、航司、时效、有效期等结构化字段。单位人民币元。邮件格式多样（列表/段落/中英混排/口语），都要准确提取。',
      prompt: [
        '货代名册（解析结果的 forwarderId 必须对应）：',
        rosterLine,
        '',
        '各家邮件正文：',
        mailBlock,
        '',
        '要求：每家一条。freightTotal = 总运费（含全部附加费）。燃油/安检未提及填 0，战争险未提及不填 war。时效取工作日数。',
      ].join('\n'),
    });
    const parsed: ParsedQuote[] = object.items.map((it) => ({
      forwarderId: it.forwarderId,
      forwarderName: roster.find((r) => r.forwarderId === it.forwarderId)?.name,
      freightTotal: it.freightTotal,
      currency: 'RMB',
      unitPrice: it.unitPrice,
      surcharges: { fuel: it.fuel, security: it.security, war: it.war } as Surcharges,
      transitDays: it.transitDays,
      airline: it.airline,
      flightSchedule: it.flightSchedule,
      validity: it.validity,
      remarks: it.remarks,
    }));
    return {
      parsed,
      trace: [
        {
          artifact: `解析 ${parsed.length}/${quoteEmails.length} 封（${Date.now() - t0}ms）`,
          outcome: 'success',
        },
      ],
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.for('parseQuoteEmails').error('generateObject failed', { err: msg });
    return {
      parsed: [],
      trace: [{ artifact: `generateObject 失败：${msg.slice(0, 200)}`, outcome: 'gen_error' }],
    };
  }
}

// ---------- 评估：报价汇总 + 偏好 → Evaluation ----------
const EvaluationSchema = z.object({
  recommendedForwarderId: z.string().describe('推荐货代 ID（分数最高者）'),
  reason: z.string().describe('推荐理由，结合偏好与具体数据，50-150 字'),
  ranking: z
    .array(
      z.object({
        forwarderId: z.string(),
        score: z.number().describe('综合评分 0-100'),
        pros: z.string().describe('优势'),
        cons: z.string().describe('劣势'),
      }),
    )
    .describe('所有货代按分数降序'),
});

export async function evaluateQuotesWithLLM(
  quotes: ParsedQuote[],
  inquiry: CargoInquiry,
  forwarders: Forwarder[],
  preference: Preference,
): Promise<{ evaluation: Evaluation | null; trace: TraceRound[] }> {
  if (quotes.length === 0) {
    return { evaluation: null, trace: [{ artifact: '0 份报价', outcome: 'no_data' }] };
  }
  const quoteLines = quotes
    .map((q) => {
      const fwd = forwarders.find((f) => f.id === q.forwarderId);
      const sc = q.surcharges;
      return `- ${q.forwarderId} (${fwd?.name}，rating ${fwd?.rating ?? '-'}, 风格 ${fwd?.style}): 总价 ¥${q.freightTotal}，单价 ¥${q.unitPrice}/kg，燃油 ¥${sc.fuel}，安检 ¥${sc.security}${sc.war ? `，战争险 ¥${sc.war}` : ''}，时效 ${q.transitDays} 工作日，航司 ${q.airline}（${q.flightSchedule}），有效期 ${q.validity}`;
    })
    .join('\n');

  const t0 = Date.now();
  try {
    const { object } = await generateObject({
      model: getRawModel(),
      schemaName: 'evaluation',
      schemaDescription: '按偏好对多家货代报价做评估，选出最优并排序',
      schema: EvaluationSchema,
      system:
        '你是国际空运询比价评估助手。严格按给定偏好为各家货代打分并选出最优，理由要结合偏好与具体数据（价格/时效/航司/附加费/评分）。',
      prompt: [
        `偏好：${PREFERENCE_LABEL[preference]} —— ${PREFERENCE_HINT[preference]}`,
        '',
        `询价：${inquiry.cargo.name} → ${inquiry.cargo.destination}(${inquiry.cargo.destCode})，${inquiry.cargo.weight}kg，${inquiry.terms}条款`,
        '',
        '各家报价（已结构化）：',
        quoteLines,
        '',
        '要求：1) 按偏好打分 0-100；2) ranking 按分数降序；3) recommendedForwarderId 必须是最高分；4) reason 解释最优理由，50-150 字。',
      ].join('\n'),
    });
    const fwdName = (id: string) => forwarders.find((f) => f.id === id)?.name;
    const evaluation: Evaluation = {
      inquiryId: inquiry.id,
      recommendedForwarderId: object.recommendedForwarderId,
      recommendedForwarderName: fwdName(object.recommendedForwarderId),
      reason: object.reason,
      ranking: object.ranking
        .sort((a, b) => b.score - a.score)
        .map((r) => ({ ...r, forwarderName: fwdName(r.forwarderId) })),
      preferenceUsed: preference,
      createdAt: new Date().toISOString(),
    };
    return {
      evaluation,
      trace: [
        {
          artifact: `评估 ${quotes.length} 家，推荐 ${evaluation.recommendedForwarderName}（${Date.now() - t0}ms）`,
          outcome: 'success',
        },
      ],
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.for('evaluateQuotes').error('generateObject failed', { err: msg });
    return {
      evaluation: null,
      trace: [{ artifact: `generateObject 失败：${msg.slice(0, 200)}`, outcome: 'gen_error' }],
    };
  }
}
