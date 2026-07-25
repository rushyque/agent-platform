// 模拟数据与生成器
// 8 家风格化货代 + 目的地费率表 + 报价邮件生成器（按风格出不同格式正文，考验 AI 解析） + 预设询价场景。
import type { Forwarder, CargoInquiry, ParsedQuote, ForwarderStyle, Preference, Cargo } from './types.js';

// ---------- 货代池（8 家，覆盖 5 种风格） ----------
export const FORWARDERS: Forwarder[] = [
  { id: 'fy_lingyun', name: '凌云国际物流', email: 'sales@lingyun-freight.com', contact: 'David 陈', style: 'fast', specialties: ['全球', '急件'], rating: 4.3 },
  { id: 'fy_haitu', name: '海途货运代理', email: 'ops@haitu-logistics.com', contact: '王 Linda', style: 'cheap', specialties: ['转机', '经济'], rating: 3.8 },
  { id: 'fy_xinzhou', name: '星洲航空货运', email: 'cs@xingzhou-aero.com', contact: '林经理', style: 'premium', specialties: ['直飞', '大航司'], rating: 4.7 },
  { id: 'fy_yuandong', name: '远东联运', email: 'service@fareast-link.com', contact: '赵 Peter', style: 'steady', specialties: ['综合', '口碑'], rating: 4.5 },
  { id: 'fy_afrlink', name: '非洲专线 AFRLINK', email: 'lagos@afrlink-cargo.com', contact: 'Emeka O.', style: 'regional', specialties: ['LOS', '非洲'], rating: 4.4 },
  { id: 'fy_globalair', name: '环球空运 GlobalAir', email: 'quote@globalair-cargo.com', contact: 'Susan 刘', style: 'steady', specialties: ['全球', '大型'], rating: 4.2 },
  { id: 'fy_jieda', name: '捷达跨境物流', email: 'biz@jieda-cross.com', contact: '吴 Tony', style: 'cheap', specialties: ['性价比', '经济'], rating: 3.9 },
  { id: 'fy_eurasia', name: '中欧快线 EurasiaExpress', email: 'fra@eurasia-express.com', contact: 'Hans M.', style: 'regional', specialties: ['FRA', '欧洲'], rating: 4.5 },
];

// ---------- 目的地基准费率 ----------
const RATE_TABLE: Record<string, { unit: number; days: number; airline: string }> = {
  LOS: { unit: 43.5, days: 6, airline: 'ET 转机' },
  JFK: { unit: 38.0, days: 4, airline: 'CX/CA 直飞' },
  LHR: { unit: 42.0, days: 4, airline: 'BA/CZ 直飞' },
  CDG: { unit: 40.0, days: 5, airline: 'AF 转机' },
  FRA: { unit: 39.0, days: 4, airline: 'LH 直飞' },
  DXB: { unit: 28.0, days: 3, airline: 'EK 直飞' },
  SIN: { unit: 22.0, days: 2, airline: 'SQ/CZ 直飞' },
  NRT: { unit: 32.0, days: 2, airline: 'NH/CZ 直飞' },
  SYD: { unit: 45.0, days: 5, airline: 'QF 转机' },
};
const DEFAULT_RATE = { unit: 40.0, days: 5, airline: '转机待定' };

const STYLE_FACTOR: Record<ForwarderStyle, { price: number; daysDelta: number; direct: boolean }> = {
  fast: { price: 1.28, daysDelta: -3, direct: true },
  cheap: { price: 0.78, daysDelta: 3, direct: false },
  premium: { price: 1.32, daysDelta: -1, direct: true },
  steady: { price: 1.0, daysDelta: 0, direct: true },
  regional: { price: 0.92, daysDelta: -2, direct: true },
};

function isSpecialistFor(fwd: Forwarder, destCode: string, destCountry: string): boolean {
  return fwd.specialties.includes(destCode) || fwd.specialties.some((s) => destCountry.includes(s));
}

// 区域专精货代（regional）只接专长航线，其余不报价。其他风格全接。
export function willQuote(fwd: Forwarder, destCode: string, destCountry: string): boolean {
  if (fwd.style !== 'regional') return true;
  return isSpecialistFor(fwd, destCode, destCountry);
}

// ---------- 报价真值计算（货代真实意图，AI 解析的对照基准） ----------
export function computeTruthQuote(forwarder: Forwarder, inquiry: CargoInquiry): ParsedQuote {
  const rate = RATE_TABLE[inquiry.cargo.destCode] ?? DEFAULT_RATE;
  const factor = STYLE_FACTOR[forwarder.style];
  const regionalAdj = forwarder.style === 'regional' && isSpecialistFor(forwarder, inquiry.cargo.destCode, inquiry.cargo.destCountry) ? 0.88 : 1.0;
  const jitter = 0.95 + Math.random() * 0.1; // 同风格每次略有浮动
  const unit = +(rate.unit * factor.price * regionalAdj * jitter).toFixed(2);
  const fuel = Math.round(unit * inquiry.cargo.weight * 0.12);
  const security = 350 + Math.floor(Math.random() * 80);
  const warZones = ['LOS', 'JFK', 'DXB'];
  const war = warZones.includes(inquiry.cargo.destCode) ? 400 + Math.floor(Math.random() * 200) : 0;
  const freight = Math.round(unit * inquiry.cargo.weight + fuel + security + war);
  const transit = Math.max(2, rate.days + factor.daysDelta + (factor.direct ? 0 : 1));
  const airline = factor.direct ? rate.airline.replace('转机', '直飞') : rate.airline.replace('直飞', '转机');
  return {
    forwarderId: forwarder.id,
    forwarderName: forwarder.name,
    freightTotal: freight,
    currency: 'RMB',
    unitPrice: unit,
    surcharges: { fuel, security, war: war || undefined },
    transitDays: transit,
    airline,
    flightSchedule: scheduleForStyle(forwarder.style),
    validity: '2026-08-10',
    remarks: remarkForStyle(forwarder.style, inquiry),
  };
}

function scheduleForStyle(style: ForwarderStyle): string {
  switch (style) {
    case 'fast': return '每周二/五起飞（急件可加急次日）';
    case 'cheap': return '每周三/六航班（经济舱位）';
    case 'premium': return '每周一/四/五起飞';
    case 'steady': return '每周二/四/六';
    case 'regional': return '每周二/五专线起飞';
  }
}

function remarkForStyle(style: ForwarderStyle, inquiry: CargoInquiry): string {
  switch (style) {
    case 'fast': return `急件优先，${inquiry.cargo.destCode} 今早下单明早可起飞。`;
    case 'cheap': return '经济转机方案，价格最优，时效稍长，量大可再让价。';
    case 'premium': return '直飞大航司，全程保险与门到门追踪，服务到位。';
    case 'steady': return '长期合作航司，稳定可靠，老客户口碑好。';
    case 'regional': return `本线自有清关团队，${inquiry.cargo.destination} 时效与清关均有保障。`;
  }
}

// ---------- 报价邮件正文生成器（按风格出不同格式，散布关键信息） ----------
export function composeQuoteEmailBody(forwarder: Forwarder, inquiry: CargoInquiry, q: ParsedQuote): string {
  const c = inquiry.cargo;
  const warLine = q.surcharges.war ? `\n战争险：¥${q.surcharges.war}` : '';
  switch (forwarder.style) {
    case 'fast':
      return [
        `${forwarder.contact}您好，`,
        ``,
        `您的 ${c.destCode} ${c.weight}kg 询价已加急处理：`,
        `- 运费：¥${q.freightTotal}（含燃油 ¥${q.surcharges.fuel}、安检 ¥${q.surcharges.security}）${warLine}`,
        `- 单价：¥${q.unitPrice}/kg`,
        `- 航班：${q.airline}，${q.flightSchedule}`,
        `- 时效：${q.transitDays} 个工作日`,
        `- 报价有效期至：${q.validity}`,
        ``,
        `${q.remarks} 随时联系。`,
      ].join('\n');
    case 'cheap':
      return [
        `${forwarder.contact}好，`,
        ``,
        `感谢询价。这票到 ${c.destination}（${c.destCode}）${c.weight}kg 的货，我们走经济转机方案，性价比最高。`,
        `总价 ¥${q.freightTotal}，单价才 ¥${q.unitPrice}/kg，比直飞便宜不少。燃油 ¥${q.surcharges.fuel} 和安检 ¥${q.surcharges.security}${q.surcharges.war ? `、战争险 ¥${q.surcharges.war}` : ''} 都算在里头了。`,
        `走转机航司，预计 ${q.transitDays} 个工作日到港，${q.flightSchedule}。报价有效期到 ${q.validity}。`,
        ``,
        `经济方案价格最优，欢迎比价。${q.remarks}`,
      ].join('\n');
    case 'premium':
      return [
        `Dear ${forwarder.contact} / Hi,`,
        ``,
        `Re: ${c.destCode} ${c.weight}kg ${c.name} — ${inquiry.terms} terms`,
        ``,
        `Per your inquiry, our premium direct service:`,
        `• Freight: ¥${q.freightTotal} (unit ¥${q.unitPrice}/kg × ${c.weight}kg)`,
        `• Fuel surcharge (FSC): ¥${q.surcharges.fuel}`,
        `• Security: ¥${q.surcharges.security}${q.surcharges.war ? `\n• War risk: ¥${q.surcharges.war}` : ''}`,
        `• Carrier: ${q.airline}, ${q.flightSchedule}`,
        `• Transit: ${q.transitDays} working days`,
        `• Validity: ${q.validity}`,
        ``,
        `${q.remarks} Looking forward to your confirmation.`,
        ``,
        `Best regards,`,
        `${forwarder.name}`,
      ].join('\n');
    case 'steady':
      return [
        `${forwarder.contact}您好，`,
        ``,
        `${forwarder.name} 关于您 ${c.destCode} ${c.weight}kg（${inquiry.terms}）询价的正式报价：`,
        ``,
        `1. 运费单价：¥${q.unitPrice}/kg`,
        `2. 基础运费：¥${Math.round(q.unitPrice * c.weight)}`,
        `3. 燃油附加费：¥${q.surcharges.fuel}`,
        `4. 安检费：¥${q.surcharges.security}${q.surcharges.war ? `\n5. 战争险：¥${q.surcharges.war}\n6. 合计：¥${q.freightTotal}` : `\n5. 合计：¥${q.freightTotal}`}`,
        `7. 承运航司：${q.airline}`,
        `8. 航班周期：${q.flightSchedule}`,
        `9. 时效：${q.transitDays} 个工作日`,
        `10. 报价有效期：${q.validity}`,
        ``,
        `${q.remarks} 如有疑问请联系。`,
      ].join('\n');
    case 'regional':
      return [
        `Cherry 姐，`,
        ``,
        `${c.destination} 这条线是我们的王牌专线！${c.weight}kg 的${c.name}我给你最实在的价格：`,
        ``,
        `总价 ¥${q.freightTotal} 包干，单价 ¥${q.unitPrice}/kg。燃油 ¥${q.surcharges.fuel}、安检 ¥${q.surcharges.security}${q.surcharges.war ? `、${c.destCountry}战争险 ¥${q.surcharges.war}` : ''} 都含在里头了。`,
        `我们自己有清关团队，${q.airline}，${q.flightSchedule}，到港 ${q.transitDays} 天我给你搞定。别家转机清关拖半个月的，我们不会。`,
        ``,
        `报价压到 ${q.validity}，要的话今天给我回个邮件。`,
      ].join('\n');
  }
}

// ---------- 预设询价场景（开箱即用） ----------
export interface PresetInquiry {
  label: string;
  cargo: Cargo;
  terms: string;
  preference: Preference;
}

export const PRESET_INQUIRIES: PresetInquiry[] = [
  { label: '模具 → 拉各斯', cargo: { name: 'PET 注坯模具', weight: 500, boxes: 6, destination: 'Lagos', destCode: 'LOS', destCountry: '尼日利亚' }, terms: 'CIF', preference: 'price_first' },
  { label: '电子元件 → 纽约', cargo: { name: '电子控制板', weight: 120, boxes: 3, destination: 'New York', destCode: 'JFK', destCountry: '美国' }, terms: 'DAP', preference: 'time_first' },
  { label: '机械设备 → 法兰克福', cargo: { name: '数控机床配件', weight: 2000, boxes: 20, destination: 'Frankfurt', destCode: 'FRA', destCountry: '德国' }, terms: 'DDU', preference: 'balanced' },
  { label: '包装瓶胚 → 迪拜', cargo: { name: '食品包装瓶胚', weight: 800, boxes: 16, destination: 'Dubai', destCode: 'DXB', destCountry: '阿联酋' }, terms: 'CIF', preference: 'price_first' },
  { label: '光学零件 → 新加坡', cargo: { name: '精密光学零件', weight: 300, boxes: 8, destination: 'Singapore', destCode: 'SIN', destCountry: '新加坡' }, terms: 'FOB', preference: 'service_first' },
];
