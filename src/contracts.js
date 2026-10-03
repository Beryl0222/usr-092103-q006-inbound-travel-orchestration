/**
 * 与 contracts/domain.schema.json、src/domain.ts 同步的稳定枚举。
 * 运行时代码（校验器、测试、服务实现）统一从这里取值，避免字面量漂移。
 * 纪律：只追加、不复用、不改写；解析器对未知值前向兼容（见 validator.lintEvent）。
 */

export const EventType = Object.freeze({
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
});

export const AggregateType = Object.freeze({
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
});

export const ServiceProvider = Object.freeze({
  BorderCheck: "border_check",
  Hotel: "hotel",
  PaymentNetwork: "payment_network",
  Transport: "transport",
  Attraction: "attraction",
  Translation: "translation",
  TaxRefund: "tax_refund",
  Orchestrator: "orchestrator",
});

/** 身份断言粒度：商户只能申请资格，不得索取护照原件。 */
export const AssertionScope = Object.freeze({
  EntryEligibility: "entry_eligibility",
  AdultStatus: "adult_status",
  HotelRegistrationAlias: "hotel_registration_alias",
  TaxRefundEligibility: "tax_refund_eligibility",
  PaymentKycReceipt: "payment_kyc_receipt",
});

/** 数据保留类别：不同服务方不同保留期；法定留档独立于授权状态。 */
export const RetentionClass = Object.freeze({
  SessionWorking: "session_working",
  HotelRegister: "hotel_register",
  PaymentLedger: "payment_ledger",
  TaxRefundRecord: "tax_refund_record",
  TranslationSource: "translation_source",
});

export const EVENT_TYPES = Object.values(EventType);
export const AGGREGATE_TYPES = Object.values(AggregateType);
export const SERVICE_PROVIDERS = Object.values(ServiceProvider);
