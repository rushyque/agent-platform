// observe_state 摘要 —— 询价项目的"看全局现状"钩子。
// 供中台 coreTools.observeState 调用：agent-config 在 resolveContext 注入
//   getState: (ctx, focus?) => freightStateSummary(ctx.userId, focus)
// 返回精简、带「下一步工具提示」的全局快照，治"4 个 view 工具各看一片、模型拼不出全局"。
import { getWorld } from './state.js';
import { INQUIRY_STATUS_LABEL, PREFERENCE_LABEL } from './types.js';
import type { CargoInquiry, InquiryStatus, QuoteEmail } from './types.js';

// 依据 status + 审核留痕推断下一步该调哪个工具（给模型明确动作指引，减少瞎猜）
function nextStepOf(iq: CargoInquiry): string {
  switch (iq.status) {
    case 'draft':
      return 'dispatch_inquiry_emails（发询价邮件给货代）';
    case 'sent':
      return 'collect_quote_emails（收集货代报价邮件）';
    case 'quoting':
      return 'parse_quote_emails（AI 解析报价邮件）';
    case 'reviewing':
      return 'review_quotes（销售管理审核 approve/reject）';
    case 'decided':
      return 'confirm_forwarder（向选定货代发订舱确认）';
    case 'confirmed':
      return '已完成全流程';
    case 'evaluated':
      // evaluated 有三种子态：未送审 / 审核通过 / 驳回
      if (!iq.reviewedAt) return 'evaluate_quotes 已完成，可 notify_manager_review 送审';
      if (iq.reviewNote?.startsWith('审核通过')) return 'record_decision（审核已通过，选定货代）';
      return 'evaluate_quotes / negotiate_with_forwarder（审核被驳回，重新议价/评估）';
    default:
      return '—';
  }
}

function inquirySummary(iq: CargoInquiry) {
  return {
    id: iq.id,
    inquiryNo: iq.inquiryNo,
    status: iq.status,
    statusLabel: INQUIRY_STATUS_LABEL[iq.status],
    cargo: { name: iq.cargo.name, destination: iq.cargo.destination, destCode: iq.cargo.destCode, weight: iq.cargo.weight },
    preference: iq.preference,
    preferenceLabel: PREFERENCE_LABEL[iq.preference],
    selectedForwarderId: iq.selectedForwarderId,
    reviewNote: iq.reviewNote,
    nextStep: nextStepOf(iq),
    createdAt: iq.createdAt,
  };
}

export function freightStateSummary(userId: string, focus?: string): any {
  const world = getWorld(userId);

  // focus = "inquiry:<id>" → 单询价全貌（合并多个 view 工具的结果）
  if (focus?.startsWith('inquiry:')) {
    const id = focus.slice('inquiry:'.length).trim();
    const iq = world.inquiries.find((i) => i.id === id);
    if (!iq) return { ok: false, message: `未找到询价 ${id}` };
    const quoteEmails = world.emails.filter(
      (e) => e.inquiryId === iq.id && e.kind === 'quote_inbound',
    ) as QuoteEmail[];
    const parsedCount = quoteEmails.filter((e) => e.parsedQuote).length;
    const ev = world.evaluations[iq.id];
    return {
      ok: true,
      inquiry: inquirySummary(iq),
      stats: {
        quoteCount: quoteEmails.length,
        parsedCount,
        evaluated: !!ev,
        reviewing: iq.status === 'reviewing',
      },
      recommendation: ev
        ? {
            recommendedForwarderName: ev.recommendedForwarderName,
            reason: ev.reason,
            ranking: ev.ranking,
          }
        : null,
      quotes: quoteEmails.map((e) => ({
        forwarderName: e.truthQuote?.forwarderName,
        parsed: e.parsedQuote
          ? {
              freightTotal: e.parsedQuote.freightTotal,
              unitPrice: e.parsedQuote.unitPrice,
              transitDays: e.parsedQuote.transitDays,
              airline: e.parsedQuote.airline,
              validity: e.parsedQuote.validity,
            }
          : null,
      })),
    };
  }

  // 缺省：全局概览
  const count = (s: InquiryStatus) => world.inquiries.filter((i) => i.status === s).length;
  return {
    totals: {
      inquiries: world.inquiries.length,
      reviewing: count('reviewing'),
      decided: count('decided'),
      confirmed: count('confirmed'),
    },
    inquiries: world.inquiries.map(inquirySummary),
    recentLog: world.log.slice(0, 8).map((l) => ({ at: l.timestamp, text: l.text, kind: l.kind })),
  };
}
