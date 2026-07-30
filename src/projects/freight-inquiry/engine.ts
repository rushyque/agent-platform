// 状态机操作 —— 守卫 → 改 state → log → emit → 返回 OpResult。
// 模式参考 starlink-factory/game/engine.ts。每个操作对应流程图的一个环节。
import type {
  CargoInquiry,
  FreightWorld,
  ParsedQuote,
  Evaluation,
  Preference,
  Cargo,
  Email,
  QuoteEmail,
  OpResult,
} from './types.js';
import { getWorld, emitFreightWorld, nextInquiryId, nextEmailId } from './state.js';
import { FORWARDERS, willQuote, computeTruthQuote, composeQuoteEmailBody } from './world.js';

function log(world: FreightWorld, text: string, kind = 'op'): void {
  world.log.unshift({ timestamp: new Date().toISOString(), text, kind });
  if (world.log.length > 80) world.log.pop();
}

function findInquiry(world: FreightWorld, inquiryId: string): CargoInquiry | undefined {
  return world.inquiries.find((i) => i.id === inquiryId);
}

// ---------- 1. 销售：录入询价 ----------
export interface CreateInquiryInput {
  shipper?: string;
  cargo: Cargo;
  terms: string;
  preference?: Preference;
}

export function createInquiry(userId: string, input: CreateInquiryInput): OpResult<CargoInquiry> {
  const world = getWorld(userId);
  const id = nextInquiryId();
  const inquiry: CargoInquiry = {
    id,
    inquiryNo: id,
    shipper: input.shipper ?? '销售·Cherry',
    cargo: input.cargo,
    terms: input.terms,
    preference: input.preference ?? 'balanced',
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
  world.inquiries.push(inquiry);
  log(
    world,
    `录入询价 ${id}：${input.cargo.name} → ${input.cargo.destination}(${input.cargo.destCode})，${input.cargo.weight}kg/${input.cargo.boxes}箱，${input.terms}条款，偏好${inquiry.preference}`,
  );
  emitFreightWorld(userId, '询价已创建');
  return { ok: true, message: `询价单 ${id} 已创建`, data: inquiry };
}

// ---------- 设置评估偏好 ----------
export function setPreference(userId: string, inquiryId: string, preference: Preference): OpResult<CargoInquiry> {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  iq.preference = preference;
  log(world, `${inquiryId} 评估偏好设为 ${preference}`);
  emitFreightWorld(userId, '偏好已更新');
  return { ok: true, message: `${inquiryId} 偏好已设为 ${preference}`, data: iq };
}

// ---------- 2. 系统：分发询价邮件给匹配货代 ----------
export function dispatchInquiryEmails(userId: string, inquiryId: string): OpResult<Email[]> {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  if (iq.status !== 'draft') return { ok: false, message: `询价状态为 ${iq.status}，无法重复发送` };
  const targets = FORWARDERS.filter((f) => willQuote(f, iq.cargo.destCode, iq.cargo.destCountry));
  const emails: Email[] = targets.map((f) => ({
    id: nextEmailId(),
    inquiryId,
    kind: 'inquiry_outbound',
    from: 'system@fscargo.com',
    to: f.email,
    subject: `询价 ${iq.inquiryNo} - ${iq.cargo.destCode} ${iq.cargo.weight}kg ${iq.terms}`,
    body: [
      `${f.contact}您好，`,
      '',
      `现就以下货物向贵司询价：`,
      `- 货物：${iq.cargo.name}`,
      `- 目的地：${iq.cargo.destination} (${iq.cargo.destCode}, ${iq.cargo.destCountry})`,
      `- 重量/箱数：${iq.cargo.weight}kg / ${iq.cargo.boxes}箱`,
      `- 贸易条款：${iq.terms}`,
      `- 期望提货：尽快`,
      '',
      `请回复：运费单价、附加费明细（燃油/安检/战争险）、承运航司、航班周期、时效（工作日）、报价有效期。`,
      '',
      `FSCargo 询比价系统`,
    ].join('\n'),
    receivedAt: new Date().toISOString(),
  }));
  world.emails.push(...emails);
  iq.status = 'sent';
  log(world, `${inquiryId} 询价分发给 ${targets.length} 家货代（${targets.map((t) => t.name).join('、')}）`);
  emitFreightWorld(userId, '询价邮件已发送');
  return { ok: true, message: `已向 ${targets.length} 家货代发送询价邮件`, data: emails };
}

// ---------- 3. 货代：回报价邮件（半模拟，按各家风格生成） ----------
export function collectQuoteEmails(userId: string, inquiryId: string): OpResult<QuoteEmail[]> {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  if (iq.status !== 'sent') return { ok: false, message: `询价状态为 ${iq.status}，需先发送询价` };
  const forwarders = FORWARDERS.filter((f) => willQuote(f, iq.cargo.destCode, iq.cargo.destCountry));
  const quotes: QuoteEmail[] = forwarders.map((f) => {
    const truth = computeTruthQuote(f, iq);
    return {
      id: nextEmailId(),
      inquiryId,
      kind: 'quote_inbound',
      from: f.email,
      to: 'system@fscargo.com',
      subject: `Re: 询价 ${iq.inquiryNo} - ${iq.cargo.destCode} 报价`,
      body: composeQuoteEmailBody(f, iq, truth),
      receivedAt: new Date().toISOString(),
      truthQuote: truth,
    } as QuoteEmail;
  });
  world.emails.push(...quotes);
  iq.status = 'quoting';
  log(world, `${inquiryId} 收到 ${quotes.length} 家货代报价邮件`);
  emitFreightWorld(userId, '报价邮件已收集');
  return { ok: true, message: `收到 ${quotes.length} 份报价邮件`, data: quotes };
}

// ---------- 4. AI：写回解析结果 ----------
export function recordParseResult(userId: string, inquiryId: string, parsed: ParsedQuote[]): OpResult {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  let updated = 0;
  for (const p of parsed) {
    const qe = world.emails.find(
      (e) => e.inquiryId === inquiryId && e.kind === 'quote_inbound' && (e as QuoteEmail).truthQuote?.forwarderId === p.forwarderId,
    ) as QuoteEmail | undefined;
    if (qe) {
      qe.parsedQuote = p;
      updated++;
    }
  }
  log(world, `${inquiryId} AI 解析 ${updated}/${parsed.length} 份报价邮件`);
  emitFreightWorld(userId, '报价解析完成');
  return { ok: true, message: `已解析 ${updated} 份报价`, data: { updated } };
}

// ---------- 5. AI：写回评估结果 ----------
export function recordEvaluation(userId: string, inquiryId: string, evaluation: Evaluation): OpResult<Evaluation> {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  world.evaluations[inquiryId] = evaluation;
  iq.status = 'evaluated';
  log(
    world,
    `${inquiryId} AI 评估完成：推荐 ${evaluation.recommendedForwarderName ?? evaluation.recommendedForwarderId}（${evaluation.preferenceUsed}）`,
  );
  emitFreightWorld(userId, '评估完成');
  return { ok: true, message: `评估完成，推荐：${evaluation.recommendedForwarderName ?? evaluation.recommendedForwarderId}`, data: evaluation };
}

// ---------- 6. 销售管理：议价（模拟货代回复） ----------
export function negotiate(userId: string, inquiryId: string, forwarderId: string, newUnitPrice: number): OpResult<QuoteEmail> {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  const fwd = FORWARDERS.find((f) => f.id === forwarderId);
  if (!fwd) return { ok: false, message: `未找到货代 ${forwarderId}` };
  const orig = world.emails.find(
    (e) => e.inquiryId === inquiryId && e.kind === 'quote_inbound' && (e as QuoteEmail).truthQuote?.forwarderId === forwarderId,
  ) as QuoteEmail | undefined;
  if (!orig || !orig.truthQuote) return { ok: false, message: `${fwd.name} 尚未报价，无法议价` };

  // 货代按风格决定接受/反价
  const acceptProb = fwd.style === 'cheap' ? 0.8 : fwd.style === 'fast' ? 0.3 : 0.55;
  const accept = Math.random() < acceptProb;
  const finalUnit = accept ? newUnitPrice : Math.round(((newUnitPrice + orig.truthQuote.unitPrice) / 2) * 100) / 100;
  const fuel = Math.round(finalUnit * iq.cargo.weight * 0.12);
  const freight = Math.round(
    finalUnit * iq.cargo.weight + fuel + orig.truthQuote.surcharges.security + (orig.truthQuote.surcharges.war ?? 0),
  );
  const newTruth: ParsedQuote = {
    ...orig.truthQuote,
    unitPrice: finalUnit,
    surcharges: { ...orig.truthQuote.surcharges, fuel },
    freightTotal: freight,
  };
  const body = accept
    ? [
        `${fwd.contact}：`,
        '',
        `经内部申请，我们同意您提出的 ¥${newUnitPrice}/kg。议价后：单价 ¥${finalUnit}/kg，燃油 ¥${fuel}，总价 ¥${freight}。`,
        `其余条款（${orig.truthQuote.airline}、时效 ${orig.truthQuote.transitDays} 天、有效期 ${orig.truthQuote.validity}）不变。请尽快确认订舱。`,
      ].join('\n')
    : [
        `${fwd.contact}：`,
        '',
        `您给的 ¥${newUnitPrice}/kg 实在做不到，亏本了。最低 ¥${finalUnit}/kg，这是底线。`,
        `总价 ¥${freight}（含燃油 ¥${fuel}）。要的话今天定，舱位紧张。`,
        '',
        `${fwd.name}`,
      ].join('\n');

  const nege: QuoteEmail = {
    id: nextEmailId(),
    inquiryId,
    kind: 'negotiation_inbound',
    from: fwd.email,
    to: 'system@fscargo.com',
    subject: `Re: 议价 ${iq.inquiryNo} - ${fwd.name} 回复`,
    body,
    receivedAt: new Date().toISOString(),
    truthQuote: newTruth,
  };
  world.emails.push(nege);
  log(world, `${inquiryId} 与 ${fwd.name} 议价（目标 ¥${newUnitPrice}/kg）→ ${accept ? '接受' : '反价 ¥' + finalUnit + '/kg'}`);
  emitFreightWorld(userId, '议价已回复');
  return { ok: true, message: `${fwd.name} ${accept ? '接受' : '反价'}：¥${finalUnit}/kg`, data: nege };
}

// 议价后把最新真值同步到 parsedQuote（让评估拿到最新价）
export function applyNegotiationToParsed(userId: string, inquiryId: string, forwarderId: string): OpResult<ParsedQuote> {
  const world = getWorld(userId);
  const candidates = world.emails
    .filter(
      (e) =>
        e.inquiryId === inquiryId &&
        (e.kind === 'quote_inbound' || e.kind === 'negotiation_inbound') &&
        (e as QuoteEmail).truthQuote?.forwarderId === forwarderId,
    )
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)) as QuoteEmail[];
  const latest = candidates[0];
  if (!latest?.truthQuote) return { ok: false, message: '无报价可同步' };
  const target = world.emails.find(
    (e) => e.inquiryId === inquiryId && e.kind === 'quote_inbound' && (e as QuoteEmail).truthQuote?.forwarderId === forwarderId,
  ) as QuoteEmail;
  if (target) target.parsedQuote = latest.truthQuote;
  log(world, `${inquiryId} ${forwarderId} 议价后报价同步为 ¥${latest.truthQuote.unitPrice}/kg`);
  emitFreightWorld(userId, '报价已更新');
  return { ok: true, message: '已更新', data: latest.truthQuote };
}

// ---------- 审核通知（送审 → reviewing） ----------
export function notifyManagerReview(userId: string, inquiryId: string, managerEmail: string): OpResult<Email> {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  if (iq.status !== 'evaluated') return { ok: false, message: `需先完成 AI 评估再送审（当前状态 ${iq.status}）` };
  const email: Email = {
    id: nextEmailId(),
    inquiryId,
    kind: 'review_notice',
    from: 'system@fscargo.com',
    to: managerEmail,
    subject: `审核通知：${iq.inquiryNo} AI 推荐报价待审核`,
    body: [
      '销售管理您好，',
      '',
      `询价单 ${iq.inquiryNo}（${iq.cargo.name} → ${iq.cargo.destination}）已完成报价收集与 AI 评估。`,
      '请登录系统查看完整报价列表与 AI 推荐，做出最终决策。',
      '',
      'FSCargo 询比价系统',
    ].join('\n'),
    receivedAt: new Date().toISOString(),
  };
  world.emails.push(email);
  iq.status = 'reviewing';
  log(world, `${inquiryId} 审核通知发送给 ${managerEmail}，进入待审核`);
  emitFreightWorld(userId, '审核通知已发送');
  return { ok: true, message: '审核通知已发送，等待销售管理审核', data: email };
}

// ---------- 销售管理：审核决策（reviewing → evaluated，留痕） ----------
// approve/reject 后都回到 evaluated 可操作态，由 reviewNote 区分意图：
//  - approve：审核通过，可继续 record_decision
//  - reject：驳回（需重新议价/评估），reviewNote 记原因
export function managerReview(
  userId: string,
  inquiryId: string,
  decision: 'approve' | 'reject',
  note: string,
): OpResult {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  if (iq.status !== 'reviewing') return { ok: false, message: `${inquiryId} 当前不在待审核状态（${iq.status}），无法审核` };
  iq.reviewNote = decision === 'approve' ? `审核通过${note ? '：' + note : ''}` : `驳回${note ? '：' + note : ''}`;
  iq.reviewedAt = new Date().toISOString();
  iq.status = 'evaluated';
  log(world, `${inquiryId} 销售管理${decision === 'approve' ? '审核通过' : '驳回'}（${note || '无备注'}）`);
  emitFreightWorld(userId, decision === 'approve' ? '审核通过' : '审核驳回');
  return {
    ok: true,
    message:
      decision === 'approve'
        ? `${inquiryId} 审核通过，可 record_decision 选定货代`
        : `${inquiryId} 已驳回，可重新 evaluate_quotes 或 negotiate_with_forwarder`,
  };
}

// ---------- 7. 销售管理：决策 ----------
export function recordDecision(userId: string, inquiryId: string, forwarderId: string, reason: string): OpResult {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  const fwd = world.forwarders.find((f) => f.id === forwarderId);
  if (!fwd) return { ok: false, message: `未找到货代 ${forwarderId}` };
  iq.selectedForwarderId = forwarderId;
  iq.status = 'decided';
  world.decisionLog.push({ inquiryId, forwarderId, forwarderName: fwd.name, reason, decidedAt: new Date().toISOString() });
  log(world, `${inquiryId} 决策：选定 ${fwd.name}（${reason}）`);
  emitFreightWorld(userId, '决策已记录');
  return { ok: true, message: `已选定 ${fwd.name}` };
}

// ---------- 8. 系统：向选中货代发确认通知 ----------
export function confirmForwarder(userId: string, inquiryId: string): OpResult<Email> {
  const world = getWorld(userId);
  const iq = findInquiry(world, inquiryId);
  if (!iq) return { ok: false, message: `未找到询价 ${inquiryId}` };
  if (iq.status !== 'decided' || !iq.selectedForwarderId) return { ok: false, message: '需先做决策' };
  const fwd = world.forwarders.find((f) => f.id === iq.selectedForwarderId)!;
  const email: Email = {
    id: nextEmailId(),
    inquiryId,
    kind: 'confirm_notice',
    from: 'system@fscargo.com',
    to: fwd.email,
    subject: `订舱确认 ${iq.inquiryNo} - ${fwd.name}`,
    body: [
      `${fwd.contact}您好，`,
      '',
      `贵司报价已被选中，正式确认订舱：`,
      `- 询价单：${iq.inquiryNo}`,
      `- 货物：${iq.cargo.name}，${iq.cargo.weight}kg`,
      `- 航线：${iq.cargo.destination} (${iq.cargo.destCode})`,
      `- 条款：${iq.terms}`,
      '',
      '请按贵司报价中的航班与时效安排运输。后续提货事宜我方将与您对接。',
      '',
      'FSCargo',
    ].join('\n'),
    receivedAt: new Date().toISOString(),
  };
  world.emails.push(email);
  iq.status = 'confirmed';
  log(world, `${inquiryId} 已向 ${fwd.name} 发送确认通知`);
  emitFreightWorld(userId, '已确认货代');
  return { ok: true, message: `已向 ${fwd.name} 发送确认`, data: email };
}
