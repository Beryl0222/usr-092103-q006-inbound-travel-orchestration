/**
 * 各服务方差异化规则：身份凭证形态、失败重试策略、数据保留类别。
 * 编排引擎在调用、重试与清理时统一读取这里，而不是把规则散落到业务代码。
 */
export const PROVIDER_POLICIES = {
  border_check: {
    provider: "border_check",
    label: "口岸核验",
    // 口岸只发放一次性核验令牌，凭令牌换会话，不复用证件影像。
    credential: "one_time_verify_token",
    retry: { max_attempts: 2, backoff_ms: 1000, timeout_ms: 5000 },
    retention_class: "session_working",
  },
  hotel: {
    provider: "hotel",
    label: "酒店住宿",
    // 酒店使用绑定预订版本的二维码，换订即轮换。
    credential: "booking_qr_v1",
    retry: { max_attempts: 3, backoff_ms: 2000, timeout_ms: 8000 },
    retention_class: "hotel_register",
  },
  payment_network: {
    provider: "payment_network",
    label: "外卡支付网络",
    // 支付网络使用回调签名通知 + 幂等键，回调可重放。
    credential: "signed_callback",
    retry: { max_attempts: 4, backoff_ms: 1500, timeout_ms: 10000 },
    retention_class: "payment_ledger",
  },
  transport: {
    provider: "transport",
    label: "交通承运",
    credential: "booking_qr_v1",
    retry: { max_attempts: 3, backoff_ms: 3000, timeout_ms: 9000 },
    retention_class: "hotel_register",
  },
  attraction: {
    provider: "attraction",
    label: "景点门票",
    credential: "booking_qr_v1",
    retry: { max_attempts: 2, backoff_ms: 2000, timeout_ms: 6000 },
    retention_class: "session_working",
  },
  translation: {
    provider: "translation",
    label: "拍照翻译",
    // 翻译服务只拿图片内容（菜单），不拿身份凭证。
    credential: "none",
    retry: { max_attempts: 2, backoff_ms: 1000, timeout_ms: 12000 },
    retention_class: "translation_source",
  },
  tax_refund: {
    provider: "tax_refund",
    label: "退税服务",
    // 退税只拿资格断言与密封材料引用。
    credential: "eligibility_assertion",
    retry: { max_attempts: 2, backoff_ms: 2500, timeout_ms: 7000 },
    retention_class: "tax_refund_record",
  },
  orchestrator: {
    provider: "orchestrator",
    label: "省级编排平台",
    credential: "session",
    retry: { max_attempts: 1, backoff_ms: 0, timeout_ms: 0 },
    retention_class: "session_working",
  },
};

export function policyOf(provider) {
  const p = PROVIDER_POLICIES[provider];
  if (!p) throw new Error(`未登记的服务方：${provider}`);
  return p;
}
