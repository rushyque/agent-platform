// 货运询比价 - 数据模型
// 替换原"单货代跟单"模型；这套服务于"多货代询价 → AI解析报价邮件 → AI偏好评估推荐"流程。

// ---------- 货代公司 ----------
export type ForwarderStyle = 'fast' | 'cheap' | 'premium' | 'steady' | 'regional';

export const FORWARDER_STYLE_LABEL: Record<ForwarderStyle, string> = {
  fast: '急速型',
  cheap: '低价型',
  premium: '高端型',
  steady: '稳健型',
  regional: '区域专精',
};

export interface Forwarder {
  id: string;
  name: string;
  email: string;
  contact: string;
  style: ForwarderStyle;
  specialties: string[]; // 擅长机场码或区域关键词
  rating: number; // 0-5
}

// ---------- 询价单 ----------
export type Preference = 'price_first' | 'time_first' | 'balanced' | 'service_first';

export const PREFERENCE_LABEL: Record<Preference, string> = {
  price_first: '价格优先',
  time_first: '时效优先',
  balanced: '综合平衡',
  service_first: '服务优先',
};

export const PREFERENCE_HINT: Record<Preference, string> = {
  price_first: '价格优先：忽略小幅时效差异，优先总价最低；特别注意是否有隐藏附加费（燃油/战争险等）。',
  time_first: '时效优先：优先 transitDays 最短；直飞优于转机；航司准点率也要考虑。',
  balanced: '综合平衡：兼顾价格、时效、航司口碑与货代评分，给出综合最优。',
  service_first: '服务优先：优先大航司、口碑好、评分高（rating）的货代；价格可适当放宽。',
};

// reviewed 标志审核回路：notify 送审 → reviewing；approve/reject 后回 evaluated，由 reviewNote 区分意图
export type InquiryStatus =
  | 'draft'
  | 'sent'
  | 'quoting'
  | 'evaluated'
  | 'reviewing'
  | 'decided'
  | 'confirmed';

export const INQUIRY_STATUS_LABEL: Record<InquiryStatus, string> = {
  draft: '草稿',
  sent: '已发询价',
  quoting: '报价中',
  evaluated: '已评估',
  reviewing: '待审核',
  decided: '已决策',
  confirmed: '已确认',
};

export const INQUIRY_STATUS_ICON: Record<InquiryStatus, string> = {
  draft: '📝',
  sent: '📤',
  quoting: '💬',
  evaluated: '🧠',
  reviewing: '🔍',
  decided: '✅',
  confirmed: '🏁',
};

export interface Cargo {
  name: string;
  weight: number; // kg
  boxes: number;
  volume?: number; // cbm
  destination: string;
  destCode: string; // 机场三字码
  destCountry: string;
}

export interface CargoInquiry {
  id: string;
  inquiryNo: string;
  shipper: string;
  cargo: Cargo;
  terms: string; // CIF / DDU / DAP / FOB / CPT ...
  preference: Preference;
  status: InquiryStatus;
  selectedForwarderId?: string;
  // 审核回路留痕：reviewing 态期间为空；approve/reject 后写入，status 回到 evaluated
  reviewNote?: string; // 如 '审核通过' / '驳回：价格偏高，需重新议价'
  reviewedAt?: string;
  createdAt: string;
}

// ---------- 邮件 ----------
export type EmailKind =
  | 'inquiry_outbound'
  | 'quote_inbound'
  | 'negotiation_inbound'
  | 'review_notice'
  | 'confirm_notice';

export const EMAIL_KIND_LABEL: Record<EmailKind, string> = {
  inquiry_outbound: '询价邮件',
  quote_inbound: '报价邮件',
  negotiation_inbound: '议价邮件',
  review_notice: '审核通知',
  confirm_notice: '确认通知',
};

export const EMAIL_KIND_ICON: Record<EmailKind, string> = {
  inquiry_outbound: '📤',
  quote_inbound: '📥',
  negotiation_inbound: '🤝',
  review_notice: '🔔',
  confirm_notice: '🎉',
};

export interface Email {
  id: string;
  inquiryId: string;
  kind: EmailKind;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: string;
}

// ---------- 报价（AI 解析的目标结构） ----------
export interface Surcharges {
  fuel: number;
  security: number;
  war?: number;
  other?: number;
}

export interface ParsedQuote {
  forwarderId: string;
  forwarderName?: string;
  freightTotal: number; // 总运费（含附加费）
  currency: string;
  unitPrice: number; // /kg
  surcharges: Surcharges;
  transitDays: number;
  airline: string;
  flightSchedule: string;
  validity: string;
  remarks?: string;
}

// 报价邮件 = 邮件 + AI 解析结果 + 真值（模拟时落地，供对比解析准确度）
export interface QuoteEmail extends Email {
  kind: 'quote_inbound' | 'negotiation_inbound';
  parsedQuote?: ParsedQuote;
  truthQuote?: ParsedQuote;
}

// ---------- AI 评估结果 ----------
export interface RankingEntry {
  forwarderId: string;
  forwarderName?: string;
  score: number; // 0-100
  pros: string;
  cons: string;
}

export interface Evaluation {
  inquiryId: string;
  recommendedForwarderId: string;
  recommendedForwarderName?: string;
  reason: string;
  ranking: RankingEntry[];
  preferenceUsed: Preference;
  createdAt: string;
}

// ---------- 决策记录 ----------
export interface DecisionRecord {
  inquiryId: string;
  forwarderId: string;
  forwarderName?: string;
  reason: string;
  decidedAt: string;
}

// ---------- 日志 ----------
export interface LogEntry {
  timestamp: string;
  text: string;
  kind: string;
}

// ---------- 世界状态 ----------
export interface FreightWorld {
  forwarders: Forwarder[];
  inquiries: CargoInquiry[];
  emails: Email[]; // 含 QuoteEmail（kind=quote_inbound/negotiation_inbound）
  evaluations: Record<string, Evaluation>; // inquiryId -> Evaluation
  decisionLog: DecisionRecord[];
  log: LogEntry[];
}

// ---------- 操作结果 ----------
export interface OpResult<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
}
