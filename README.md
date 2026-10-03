# 入境游服务编排（省级入境游平台 · 编排后端）

外国游客在**同一入口**完成护照核验、酒店入住、外卡充值、行程规划与退税准备，
而各服务方拥有**不同的身份凭证、失败重试与数据保留规则**。
本仓库以仓库既有领域契约（`contracts/domain.schema.json`）为**消息边界**，
实现事件溯源式的服务编排后端：旅客会话、最小化身份断言、服务授权、行程版本、
预订占用、支付状态、翻译请求与退税材料全部以领域事件表达。

## 设计原则与需求映射

| 需求 | 落地方式 |
| --- | --- |
| 护照原件不扩散给只需确认资格的商户 | 原件仅在 `IDENTITY_VERIFIED` 时进入隔离 vault；外发只经 `IDENTITY_ASSERTION_ISSUED`，字段由服务方白名单裁剪；酒店只收到姓名 + 签证资格结论（`visa_valid/adult`），收不到护照号、出生日期 |
| 撤回授权只阻断后续用途，不破坏法定留档 | `AUTHORIZATION_REVOKED` 只影响 `assertUsable` 的新用途；已完成交易以 `LEGAL_RECORD_HELD` 登记独立 `retain_until`，撤回不改写、不删除 |
| 客流/价格/营业时间可提新方案，已确认交通住宿不被静默替换 | 每次变化产出新的 `ITINERARY_PROPOSED` 修订版（逐行 added/removed/price_changed/time_changed/merchant_changed）；触及已确认交通/住宿标 `requires_confirmation`；游客 `accept` 才产生 `ITINERARY_UPDATED` 与 superseded 清单 |
| 一次换订不能让旧二维码继续有效 | 换订/取消先 `VOUCHER_REVOKED` 再签新码；任何核验点对已撤销二维码立即拒入 |
| 跨系统超时可恢复补偿，重复回调不二次扣款/占位 | Saga + 每服务方独立重试策略；三类故障区分：普通超时（安全重试）、**回执丢失（禁止盲目重发，挂起等 probe 对账）**、明确拒绝（不重试直接补偿）；幂等键 + 终态短路 + 补偿幂等三重去重 |
| 拍照翻译保留原图来源、置信度、人工更正 | `TRANSLATION_SUBMITTED` 存来源/设备/MIME/字节数/SHA-256（原图字节不入事件流）；`TRANSLATION_COMPLETED` 逐行存原文/机翻/置信度与过敏原 detected/needs_review；`TRANSLATION_CORRECTED` 只追加，原文永不覆盖 |
| 游客清楚看到每步由谁处理、失败如何继续 | `orchestrator.travelerView(flowId)`：每步处理方中文名、状态、下一步动作 |
| 运维可追踪跨服务故障但看不到完整身份资料 | `TraceView` 按 correlation/session 还原链路并给出诊断；vault 事件整体折叠为字段名，PII 键脱敏，资格中的非敏感项保留 |
| 各服务方留存规则不同 | `ServiceRegistry.retentionPolicy` 异构；`RetentionService.sweep()` 按各自天数清理，法定留档与菜单过敏原溯源素材豁免，清理本身记 `RETENTION_PURGED` |

## 结构

```
contracts/domain.schema.json   领域事件公共信封 + 稳定枚举（只可追加）
src/domain.ts                  事件/聚合枚举与 TypeScript 类型
src/validator.js               信封校验（枚举以 schema 为唯一来源）
src/platform/                  时钟、事件存储（乐观版本号+event_id 去重）、
                               入站幂等表、服务方注册表（身份/重试/留存策略）
src/identity/                  旅客会话、护照 vault、最小断言、服务授权与撤回、法定留档
src/booking/                   行程版本（提案/拒绝/接受）、预订占用与二维码生命周期
src/payment/                   外卡支付状态机、回调幂等、退款
src/translation/               拍照翻译溯源链（原图哈希/逐行置信度/过敏原/更正）
src/taxrefund/                 退税材料包（一次性护照读取 + 授权前置）
src/orchestration/             Saga 引擎：入队/执行/挂起/对账恢复/反向补偿/游客视图
src/ops/                       运维脱敏链路追踪、按服务方留存清理
src/app/platform.js            装配：服务方登记、内存事件存储、故障注入网络
src/app/flows.js               已登记流程：酒店预订、酒店换订（先立新后破旧）、外卡充值、菜单翻译、退税准备
tests/                         node:test 契约与不变量测试（46 个）
```

## 事件目录

枚举只可追加。聚合：`traveler_session`、`identity_vault`、`service_authorization`、
`itinerary_revision`、`reservation`、`payment`、`translation_request`、
`tax_refund_case`、`orchestration_step`。

- 身份/授权：`SESSION_OPENED`、`IDENTITY_VERIFIED`、`IDENTITY_ASSERTION_ISSUED`、
  `PASSPORT_ACCESS_GRANTED`、`PASSPORT_ACCESSED`、`SERVICE_AUTHORIZED`、
  `AUTHORIZATION_REVOKED`、`LEGAL_RECORD_HELD`
- 行程/预订：`ITINERARY_PROPOSED`、`ITINERARY_REJECTED`、`ITINERARY_UPDATED`、
  `RESERVATION_REQUESTED`、`RESERVATION_CONFIRMED`、`RESERVATION_REJECTED`、
  `RESERVATION_OFFER_EXPIRED`、`RESERVATION_CANCELLED`、`VOUCHER_ISSUED`、`VOUCHER_REVOKED`
- 支付：`PAYMENT_INITIATED`、`PAYMENT_SUCCEEDED`、`PAYMENT_FAILED`、`PAYMENT_REFUNDED`
- 翻译/退税：`TRANSLATION_SUBMITTED`、`TRANSLATION_COMPLETED`、`TRANSLATION_CORRECTED`、
  `TAX_REFUND_DOCUMENT_PREPARED`
- 编排：`STEP_ENQUEUED`、`STEP_STARTED`、`STEP_RETRY_SCHEDULED`、`STEP_SUSPENDED`、
  `STEP_RESUMED`、`STEP_SUCCEEDED`、`STEP_FAILED`、
  `COMPENSATION_STARTED`、`COMPENSATION_COMPLETED`
- 留存：`RETENTION_PURGED`

## 关键机制

### 服务方异构策略（`src/app/platform.js`）

每个服务方登记三张策略表：`identityPolicy.allowedFields`（可收护照字段白名单）、
`retryPolicy`（超时、最大尝试、退避基数）、`retentionPolicy`（留存天数、是否法定留档）。
例如：酒店白名单仅 `full_name`（90 天留存、3 次重试），铁路含 `nationality`（30 天、4 次），
收单方留存 180 天且法定留档，退税机构可经一次性授权读取证号并留档 365 天。

### 超时三态与对账恢复

- 普通超时（请求可能未送达）：按服务方退避自动重试，复用稳定幂等键；
- **回执丢失（副作用可能已发生）**：步骤标记 `await_reconciliation`，
  定时 `tick()` **不会**重发；只能由 `recover(flowId)` 经 `probe` 询问对端真实账本——
  `committed` 则以同一回调编号把结果幂等入账，`absent` 才重新发起，`unknown` 继续挂起；
- 明确业务拒绝（满房、拒卡）：不重试，已成功步骤反序补偿（取消占位/原路退款）。

换订流程遵循**先立新、后破旧**：新酒店占位 → 差价支付 → 新单确认发码 → 最后才取消旧单。
新侧任一环节失败时补偿只回退新侧，旧单原封不动；只有最后的旧单取消失败，才反向撤销已就绪的新单。
两种失败路径下游客都不会落到"新旧两空"。

### 幂等层次

1. `EventStore`：`event_id` 全局唯一 + 聚合乐观版本号；
2. `IdempotencyTable`：（服务方, 幂等键）首次结果固化并回放，覆盖发起支付、预订、回调、退款；
3. 终态短路：预订确认/支付终态后，即使对端换回调编号重发也不再产生第二张码/第二笔影响；
4. 补偿键稳定：补偿流程被重复触发不会退两次款、取消两次占位。

## 本地检查

```bash
npm test
```

要求 Node ≥ 22（运行时直接擦除 `src/domain.ts` 的类型注解，无需构建步骤）。
`tests/helpers.js` 提供 `freshPlatform()` 与故障注入网络（`timeoutOnce` /
`loseNextResponse` / `rejectOnce` / `alwaysTimeout`）用于复现跨服务故障场景。
