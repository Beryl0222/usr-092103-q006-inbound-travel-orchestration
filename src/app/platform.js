import { Clock } from "../platform/clock.js";
import { EventStore } from "../platform/event-store.js";
import { IdempotencyTable } from "../platform/idempotency.js";
import { ServiceRegistry } from "../platform/service-registry.js";
import { IdentityService } from "../identity/identity-service.js";
import { AuthorizationService } from "../identity/authorization-service.js";
import { ItineraryService } from "../booking/itinerary-service.js";
import { ReservationService } from "../booking/reservation-service.js";
import { PaymentService } from "../payment/payment-service.js";
import { TranslationService } from "../translation/translation-service.js";
import { TaxRefundService } from "../taxrefund/tax-refund-service.js";
import { DomainError } from "../platform/errors.js";
import { OrchestrationEngine, RecoverableError } from "../orchestration/orchestrator.js";
import { TraceView } from "../ops/trace-view.js";
import { RetentionService } from "../ops/retention-service.js";
import { registerFlows } from "./flows.js";

/**
 * 平台装配（内存实现）：
 * 一个 EventStore 作为全部服务的消息边界；各域服务只订阅自己聚合的事件。
 * 服务方在此登记彼此不同的身份白名单、重试策略与留存策略。
 */
export function buildPlatform({ clock = new Clock() } = {}) {
  const store = new EventStore();
  const registry = new ServiceRegistry();
  const idempotency = new IdempotencyTable();

  // —— 服务方登记：同一入口，规则各异 ——
  registry.register({
    id: "gov-immigration",
    kind: "identity_authority",
    name: "边检身份核验",
    identityPolicy: {
      allowedFields: ["full_name", "passport_number", "nationality", "date_of_birth", "passport_expiry"],
      requiresPassportAccess: true,
    },
    retryPolicy: { timeoutMs: 3_000, maxAttempts: 2, backoffBaseMs: 100 },
    retentionPolicy: { days: 365, legalHold: false },
  });
  registry.register({
    id: "hotel-lakeside",
    kind: "lodging",
    name: "湖畔酒店",
    // 酒店只需姓名 + 资格结论即可办入住，护照号/出生日期不下发。
    identityPolicy: { allowedFields: ["full_name"] },
    retryPolicy: { timeoutMs: 4_000, maxAttempts: 3, backoffBaseMs: 200 },
    retentionPolicy: { days: 90 },
  });
  registry.register({
    id: "hotel-riverside",
    kind: "lodging",
    name: "滨江酒店",
    identityPolicy: { allowedFields: ["full_name"] },
    retryPolicy: { timeoutMs: 4_000, maxAttempts: 3, backoffBaseMs: 200 },
    retentionPolicy: { days: 120 },
  });
  registry.register({
    id: "rail-provincial",
    kind: "transport",
    name: "省级铁路",
    identityPolicy: { allowedFields: ["full_name", "nationality"] },
    retryPolicy: { timeoutMs: 6_000, maxAttempts: 4, backoffBaseMs: 300 },
    retentionPolicy: { days: 30 },
  });
  registry.register({
    id: "acquirer-globalpay",
    kind: "payment",
    name: "环球外卡收单",
    identityPolicy: { allowedFields: [] },
    retryPolicy: { timeoutMs: 8_000, maxAttempts: 4, backoffBaseMs: 500 },
    retentionPolicy: { days: 180, legalHold: true },
  });
  registry.register({
    id: "ocr-translate",
    kind: "translation",
    name: "拍照翻译引擎",
    identityPolicy: { allowedFields: [] },
    retryPolicy: { timeoutMs: 5_000, maxAttempts: 2, backoffBaseMs: 200 },
    retentionPolicy: { days: 60 },
  });
  registry.register({
    id: "tax-agency",
    kind: "tax_refund",
    name: "省级退税服务机构",
    identityPolicy: {
      allowedFields: ["full_name", "passport_number", "nationality"],
      requiresPassportAccess: true,
    },
    retryPolicy: { timeoutMs: 5_000, maxAttempts: 3, backoffBaseMs: 200 },
    retentionPolicy: { days: 365, legalHold: true },
  });

  const identity = new IdentityService({ store, clock, registry });
  const authorization = new AuthorizationService({ store, clock, registry });
  const itineraries = new ItineraryService({ store, clock });
  const reservations = new ReservationService({ store, clock, registry, idempotency });
  const payments = new PaymentService({ store, clock, registry, idempotency });
  const translations = new TranslationService({ store, clock, registry });
  const taxRefund = new TaxRefundService({ store, clock, registry, identity, authorization });
  const orchestrator = new OrchestrationEngine({ store, clock, registry });
  const traceView = new TraceView({ store });
  const retention = new RetentionService({ store, clock, registry });

  const faults = { timeoutTokens: new Set(), lostResponseTokens: new Set(), rejectTokens: new Map(), alwaysTimeout: new Set(), remoteState: new Map() };
  const network = {
    /**
     * 模拟跨系统调用。三类故障：
     * - timeoutOnce：请求未到达对端（重试安全，由幂等键兜底）；
     * - loseNextResponse：对端已执行、回执丢失（必须先对账，probe 会看到 committed）；
     * - rejectOnce：对端明确拒绝（满房、拒卡等业务终态，不重试，直接补偿）。
     * token 可传具体键，或用 "*" 通配（下一次该服务方该动作的调用即触发，用后即焚）。
     */
    call(partyId, action, token, fn) {
      const k = `${partyId}|${action}|`;
      if (faults.alwaysTimeout.has(`${partyId}|${action}`)) {
        throw new RecoverableError(`调用「${partyId}」${action} 持续超时（故障注入）`, { partyId, action });
      }
      if (faults.timeoutTokens.delete(k + token) || faults.timeoutTokens.delete(k + "*")) {
        throw new RecoverableError(`调用「${partyId}」${action} 超时，请求可能未送达`, { partyId, action });
      }
      const rejectKey = faults.rejectTokens.has(k + token) ? k + token
        : faults.rejectTokens.has(k + "*") ? k + "*" : null;
      if (rejectKey) {
        const rejection = faults.rejectTokens.get(rejectKey);
        faults.rejectTokens.delete(rejectKey);
        throw new DomainError(rejection.code, rejection.message, { partyId, action });
      }
      const lostKey = faults.lostResponseTokens.has(k + token)
        ? k + token
        : faults.lostResponseTokens.has(k + "*") ? k + "*" : null;
      if (lostKey) {
        faults.lostResponseTokens.delete(lostKey);
        const result = fn(); // 对端真实受理，副作用已发生
        faults.remoteState.set(token, { state: "committed", result });
        const error = new RecoverableError(
          `调用「${partyId}」${action} 回执丢失，结果未知（对端可能已受理）`,
          { partyId, action },
        );
        // 关键标记：副作用可能已经发生，禁止盲目自动重试，必须先 probe 对账。
        error.sideEffectPossible = true;
        throw error;
      }
      return fn();
    },
    timeoutOnce(partyId, action, token) {
      faults.timeoutTokens.add(`${partyId}|${action}|${token}`);
    },
    /** 持续超时直到 restore（验证重试耗尽 → 补偿）。 */
    alwaysTimeout(partyId, action) {
      faults.alwaysTimeout.add(`${partyId}|${action}`);
    },
    restore(partyId, action) {
      faults.alwaysTimeout.delete(`${partyId}|${action}`);
    },
    loseNextResponse(partyId, action, token) {
      faults.lostResponseTokens.add(`${partyId}|${action}|${token}`);
    },
    /** 安排一次明确业务拒绝（不可重试）。rejection 形如 { code, message }。 */
    rejectOnce(partyId, action, token, rejection = { code: "REMOTE_REJECTED", message: "对端拒绝" }) {
      faults.rejectTokens.set(`${partyId}|${action}|${token}`, rejection);
    },
    /** 对账查询：模拟询问对端系统的真实账本。 */
    probe(token) {
      return faults.remoteState.get(token)?.state === "committed"
        ? { state: "committed", result: faults.remoteState.get(token).result }
        : { state: "absent" };
    },
  };

  registerFlows({
    orchestrator,
    services: { identity, authorization, itineraries, reservations, payments, translations, taxRefund },
    network,
    registry,
    clock,
  });

  return {
    clock,
    store,
    registry,
    idempotency,
    identity,
    authorization,
    itineraries,
    reservations,
    payments,
    translations,
    taxRefund,
    orchestrator,
    traceView,
    retention,
    network,
  };
}

export { RecoverableError };
