/**
 * 入境游服务编排 —— 跨服务消息边界的类型化契约。
 *
 * 契约纪律：
 * 1. 事件类型与聚合类型只追加、不复用、不改写；解析器必须容忍未知枚举值（前向兼容）。
 * 2. 信封字段新增时一律可选，保证旧消息可被新代码读取。
 * 3. 护照原件信息（号码、姓名、出生日期等）不得进入事件 payload；
 *    需要时只在 payload.sealed_ref 中放置保险库密封件引用。
 */

// ---- 稳定枚举（与 contracts/domain.schema.json 保持同步） ----

export const EventType = {
  IdentityVerified: "IDENTITY_VERIFIED",
  ServiceAuthorized: "SERVICE_AUTHORIZED",
  ReservationConfirmed: "RESERVATION_CONFIRMED",
  CompensationStarted: "COMPENSATION_STARTED",
  ItineraryUpdated: "ITINERARY_UPDATED",
  IdentityAssertionIssued: "IDENTITY_ASSERTION_ISSUED",
  IdentityAssertionRevoked: "IDENTITY_ASSERTION_REVOKED",
  AuthorizationRevoked: "AUTHORIZATION_REVOKED",
  ReservationHeld: "RESERVATION_HELD",
  ReservationReleased: "RESERVATION_RELEASED",
  CredentialRotated: "CREDENTIAL_ROTATED",
  ItineraryProposed: "ITINERARY_PROPOSED",
  ItineraryConfirmed: "ITINERARY_CONFIRMED",
  PaymentInitiated: "PAYMENT_INITIATED",
  PaymentCaptured: "PAYMENT_CAPTURED",
  PaymentRefunded: "PAYMENT_REFUNDED",
  PaymentFailed: "PAYMENT_FAILED",
  CallbackDeduped: "CALLBACK_DEDUPED",
  StepStarted: "STEP_STARTED",
  StepSucceeded: "STEP_SUCCEEDED",
  StepFailed: "STEP_FAILED",
  CompensationResumed: "COMPENSATION_RESUMED",
  CompensationCompleted: "COMPENSATION_COMPLETED",
  TopupRequested: "TOPUP_REQUESTED",
  TopupCompleted: "TOPUP_COMPLETED",
  TranslationRequested: "TRANSLATION_REQUESTED",
  TranslationCorrected: "TRANSLATION_CORRECTED",
  TaxFreeDocumentCollected: "TAXFREE_DOCUMENT_COLLECTED",
  DataRetentionExpired: "DATA_RETENTION_EXPIRED",
  DataPurged: "DATA_PURGED",
} as const;
export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

export const AggregateType = {
  TravelerSession: "traveler_session",
  ServiceAuthorization: "service_authorization",
  ItineraryRevision: "itinerary_revision",
  OrchestrationStep: "orchestration_step",
  IdentityAssertion: "identity_assertion",
  Reservation: "reservation",
  Payment: "payment",
  TranslationRequest: "translation_request",
  TaxRefundPack: "tax_refund_pack",
  Credential: "credential",
} as const;
export type AggregateTypeValue = (typeof AggregateType)[keyof typeof AggregateType];

export const ServiceProvider = {
  BorderCheck: "border_check",
  Hotel: "hotel",
  PaymentNetwork: "payment_network",
  Transport: "transport",
  Attraction: "attraction",
  Translation: "translation",
  TaxRefund: "tax_refund",
  Orchestrator: "orchestrator",
} as const;
export type ServiceProviderValue = (typeof ServiceProvider)[keyof typeof ServiceProvider];

/** 身份断言的粒度：商户只能申请资格，不得索取护照原件。 */
export const AssertionScope = {
  /** 已通过入境身份核验（布尔资格，不含任何证件字段）。 */
  EntryEligibility: "entry_eligibility",
  /** 成年人资格（布尔）。 */
  AdultStatus: "adult_status",
  /** 入住登记所需的有限化名（酒店法定用途，单独授权）。 */
  HotelRegistrationAlias: "hotel_registration_alias",
  /** 退税资格（签证类别/停留期限的布尔判定，不含证件影像）。 */
  TaxRefundEligibility: "tax_refund_eligibility",
  /** 支付外卡实名核验回执（发卡行交易留档用途）。 */
  PaymentKycReceipt: "payment_kyc_receipt",
} as const;
export type AssertionScopeValue = (typeof AssertionScope)[keyof typeof AssertionScope];

/** 数据保留类别：不同服务方拥有不同保留期；法定留档独立于授权状态。 */
export const RetentionClass = {
  /** 会话工作数据：授权撤回或会话结束后短期清除。 */
  SessionWorking: "session_working",
  /** 酒店入住登记：按旅店业治安要求留档。 */
  HotelRegister: "hotel_register",
  /** 支付/充值交易凭证：按财务与反洗钱要求留档。 */
  PaymentLedger: "payment_ledger",
  /** 退税材料：按税务机关要求留档。 */
  TaxRefundRecord: "tax_refund_record",
  /** 翻译原图与更正记录：会话短期保留。 */
  TranslationSource: "translation_source",
} as const;
export type RetentionClassValue = (typeof RetentionClass)[keyof typeof RetentionClass];

// ---- 信封与负载 ----

/** 领域事件公共信封（新增字段保持可选）。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 跨服务追踪标识（可给运维看，不含身份内容）。 */
  correlation_id?: string;
  /** 上游事件/回调标识。 */
  causation_id?: string;
  /** 外部幂等键。 */
  idempotency_key?: string;
  /** 实际处理方。 */
  service_provider?: ServiceProviderValue;
  payload?: EventPayload;
}

export interface EventPayload {
  session_id?: string;
  service?: string;
  purposes?: string[];
  assertion_scopes?: AssertionScopeValue[];
  /** 指向身份保险库密封件的引用；payload 本身绝不携带原件字段。 */
  sealed_ref?: string;
  reservation_id?: string;
  payment_id?: string;
  revision_no?: number;
  anchors_frozen?: boolean;
  credential_id?: string;
  superseded_credential_id?: string;
  /** 是否属于法定留档（授权撤回不影响其留存）。 */
  retained?: boolean;
  legal_hold?: boolean;
  retention_class?: RetentionClassValue;
  [key: string]: unknown;
}

// ---- 领域对象状态（供存储与视图层使用） ----

export type AuthorizationStatus = "active" | "revoked";

export interface ServiceAuthorizationState {
  authorization_id: string;
  session_id: string;
  service: string;
  purposes: string[];
  scopes: AssertionScopeValue[];
  status: AuthorizationStatus;
  granted_at: string;
  revoked_at?: string;
  /** 撤回原因（游客可见）。 */
  revoke_reason?: string;
}

export type ReservationStatus = "held" | "confirmed" | "released" | "compensating";

export interface ReservationState {
  reservation_id: string;
  session_id: string;
  service: string;
  provider: ServiceProviderValue;
  status: ReservationStatus;
  /** 占用版本：同一资源的每次重新占用产生新版本，旧凭证立即失效。 */
  occupancy_version: number;
  credential_id?: string;
  /** 被本次预订取代的旧预订（酒店换订链路）。 */
  supersedes?: string;
  /** 该预订已产生法定留档时为 true：释放/撤回不删除留档，只冻结后续用途。 */
  legal_hold: boolean;
  expires_at?: string;
}

export type ItineraryKind = "proposal" | "confirmation";

export interface ItineraryItem {
  item_id: string;
  type: "transport" | "lodging" | "activity";
  provider: ServiceProviderValue;
  /** 已确认交通/住宿为锚点：后续提案只能新增或给出替代选项，不能静默替换。 */
  anchor: boolean;
  reservation_id?: string;
  detail: Record<string, unknown>;
}

export interface ItineraryRevisionState {
  revision_id: string;
  session_id: string;
  revision_no: number;
  kind: ItineraryKind;
  items: ItineraryItem[];
  anchors_frozen: boolean;
  supersedes_revision?: number;
  change_note?: string;
}

export type PaymentStatus =
  | "initiated"
  | "captured"
  | "failed"
  | "refunded";

export interface PaymentState {
  payment_id: string;
  session_id: string;
  service: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  /** 外部回调键 -> 已处理结果。重复回调直接回放同一结果，绝不二次扣款。 */
  processed_callbacks: Record<string, "captured" | "failed">;
  legal_hold: boolean;
}

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed_retryable"
  | "compensating"
  | "compensated"
  | "failed_terminal";

export interface OrchestrationStepState {
  step_id: string;
  correlation_id: string;
  session_id: string;
  name: string;
  provider: ServiceProviderValue;
  status: StepStatus;
  attempt: number;
  max_attempts: number;
  /** 该服务方的失败重试策略。 */
  retry_policy: { max_attempts: number; backoff_ms: number; timeout_ms: number };
  last_error?: string;
  /** 失败后游客如何继续（中文指引）。 */
  recovery_hint?: string;
  compensation_of?: string;
  started_at?: string;
  finished_at?: string;
}

export interface TranslationRequestState {
  translation_id: string;
  session_id: string;
  /** 原图来源：拍摄时间、设备/渠道、内容哈希，不留证件影像。 */
  source: { captured_at: string; channel: string; image_hash: string };
  detected_text: string;
  confidence: number;
  translated_text: string;
  /** 过敏原等关键提示。 */
  allergen_flags: string[];
  corrections: { corrected_by: string; at: string; from_text: string; to_text: string }[];
}

export interface TaxRefundPackState {
  pack_id: string;
  session_id: string;
  /** 退税材料密封件引用（购物小票/退税单影像只存在于密封存储）。 */
  sealed_ref: string;
  ready: boolean;
  legal_hold: boolean;
}
