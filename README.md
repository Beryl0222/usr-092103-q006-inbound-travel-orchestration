# 入境游服务编排

省级入境游平台的**服务编排后端**：以领域事件为消息边界，在同一入口下编排
护照核验、酒店入住、外卡充值、行程规划、拍照翻译与退税准备。

## 核心约束（由代码与测试保证）

- **护照原件不扩散**：原件核验时即密封，事件中只能出现 `sealed_ref`；只需资格的商户只拿到
  布尔断言或入住化名；契约校验递归拦截任何证件字段进入事件负载。
- **撤回只阻断后续用途**：授权撤回使断言失效、阻断退税报送，但已完成交易与法定留档原样保留。
- **换订即废码**：二维码绑定具体占用版本，酒店换订后旧码立即失效并签发新码。
- **已确认交通住宿不被静默替换**：行程分提案/确认版本，锚点受保护，变化只能由游客显式确认或换订。
- **重复不二次生效**：支付回调去重不二次扣款，占用幂等不重复占位；跨服务超时按各服务方策略重试，
  耗尽后进入可恢复的反向补偿，续跑不重复回退。
- **翻译可溯源**：保留原图来源/哈希、识别置信度、过敏原提示，人工更正追加留痕。
- **双端可见性分离**：游客看到每步由谁处理、失败如何继续；运维凭 correlation_id 跨服务追踪，
  视图脱敏，看不到超出职责的身份资料。

## 资料结构

- `contracts/domain.schema.json`：领域事件公共信封与稳定枚举（30 事件 / 10 聚合 / 8 服务方）。
- `src/domain.ts`：类型化契约（事件、聚合状态、断言范围、保留类别）。
- `src/contracts.js`：运行时枚举单一来源；`src/validator.js`：信封校验、身份扩散拦截、前向兼容告警。
- `src/runtime/`：事件存储、身份保险库、会话与授权、最小断言、预订与凭证、行程版本、
  支付与外卡充值、服务方策略、Saga 补偿引擎、翻译、退税、双端视图、平台装配。
- `tests/`：25 个用例，覆盖上述全部约束与三方契约一致性。
- `docs/architecture.md`：需求到机制的逐条架构说明。
- `examples/walkthrough.mjs`：端到端中文演示（含换订、重投回调、超时补偿、撤回）。
- `data/sample.json`：最初的最小业务事件样例（保持向后兼容，仍通过校验）。

## 本地检查

```bash
npm test                    # 全量测试
npx tsc                     # 类型检查
node examples/walkthrough.mjs
```

事件类型当前包括：IDENTITY_VERIFIED、IDENTITY_ASSERTION_ISSUED/REVOKED、SERVICE_AUTHORIZED、
AUTHORIZATION_REVOKED、RESERVATION_HELD/CONFIRMED/RELEASED、CREDENTIAL_ROTATED、
ITINERARY_PROPOSED/CONFIRMED/UPDATED、PAYMENT_*、CALLBACK_DEDUPED、
STEP_STARTED/SUCCEEDED/FAILED、COMPENSATION_STARTED/RESUMED/COMPLETED、
TOPUP_REQUESTED/COMPLETED、TRANSLATION_REQUESTED/CORRECTED、
TAXFREE_DOCUMENT_COLLECTED、DATA_RETENTION_EXPIRED/PURGED。
枚举只追加、不改写；未知值对消费方前向兼容。
