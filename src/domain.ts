/** 领域事件公共信封与稳定枚举。枚举只可追加，不可改写既有取值。 */

export const EventType = {
  SessionOpened: "SESSION_OPENED",
  IdentityVerified: "IDENTITY_VERIFIED",
  IdentityAssertionIssued: "IDENTITY_ASSERTION_ISSUED",
  PassportAccessGranted: "PASSPORT_ACCESS_GRANTED",
  PassportAccessed: "PASSPORT_ACCESSED",
  ServiceAuthorized: "SERVICE_AUTHORIZED",
  AuthorizationRevoked: "AUTHORIZATION_REVOKED",
  ItineraryProposed: "ITINERARY_PROPOSED",
  ItineraryRejected: "ITINERARY_REJECTED",
  ItineraryUpdated: "ITINERARY_UPDATED",
  ReservationRequested: "RESERVATION_REQUESTED",
  ReservationConfirmed: "RESERVATION_CONFIRMED",
  ReservationRejected: "RESERVATION_REJECTED",
  ReservationCancelled: "RESERVATION_CANCELLED",
  ReservationOfferExpired: "RESERVATION_OFFER_EXPIRED",
  VoucherIssued: "VOUCHER_ISSUED",
  VoucherRevoked: "VOUCHER_REVOKED",
  PaymentInitiated: "PAYMENT_INITIATED",
  PaymentSucceeded: "PAYMENT_SUCCEEDED",
  PaymentFailed: "PAYMENT_FAILED",
  PaymentRefunded: "PAYMENT_REFUNDED",
  TranslationSubmitted: "TRANSLATION_SUBMITTED",
  TranslationCompleted: "TRANSLATION_COMPLETED",
  TranslationCorrected: "TRANSLATION_CORRECTED",
  TaxRefundDocumentPrepared: "TAX_REFUND_DOCUMENT_PREPARED",
  StepEnqueued: "STEP_ENQUEUED",
  StepStarted: "STEP_STARTED",
  StepSucceeded: "STEP_SUCCEEDED",
  StepFailed: "STEP_FAILED",
  StepSuspended: "STEP_SUSPENDED",
  StepResumed: "STEP_RESUMED",
  StepRetryScheduled: "STEP_RETRY_SCHEDULED",
  CompensationStarted: "COMPENSATION_STARTED",
  CompensationCompleted: "COMPENSATION_COMPLETED",
  LegalRecordHeld: "LEGAL_RECORD_HELD",
  RetentionPurged: "RETENTION_PURGED",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const AggregateType = {
  TravelerSession: "traveler_session",
  IdentityVault: "identity_vault",
  ServiceAuthorization: "service_authorization",
  ItineraryRevision: "itinerary_revision",
  Reservation: "reservation",
  Payment: "payment",
  TranslationRequest: "translation_request",
  TaxRefundCase: "tax_refund_case",
  OrchestrationStep: "orchestration_step",
} as const;
export type AggregateType = (typeof AggregateType)[keyof typeof AggregateType];

/** 服务方向平台声明的能力类别，决定最小断言与重试/留存策略。 */
export type ServiceKind =
  | "identity_authority"
  | "lodging"
  | "transport"
  | "payment"
  | "translation"
  | "tax_refund";

/** 护照字段分级：原件字段进入隔离 vault，资格字段可进入最小断言。 */
export type PassportField =
  | "full_name"
  | "passport_number"
  | "nationality"
  | "date_of_birth"
  | "sex"
  | "passport_expiry"
  | "visa_type"
  | "visa_valid_until";

export interface DomainEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: TPayload;
  causation_id?: string;
  correlation_id?: string;
}
