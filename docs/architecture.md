# 入境游服务编排后端 —— 架构说明

本文说明服务编排后端如何以仓库既有领域契约（`contracts/domain.schema.json`）为**唯一消息边界**，
覆盖旅客在同一入口完成护照核验、酒店入住、外卡充值、行程规划、翻译与退税准备的全链路，
并逐条落实合规与可靠性要求。

## 1. 消息边界与契约纪律

- 所有跨服务交换都是 `DomainEvent` 信封（`event_id / event_type / aggregate_type / aggregate_id / occurred_at / version / summary`）。
- 枚举（事件 30 个、聚合 10 个、服务方 8 个）由三处同源维护并由测试锁定一致：
  `contracts/domain.schema.json`、`src/domain.ts`、`src/contracts.js`。
- **只追加、不复用、不改写**；信封新增字段一律可选。消费方对未知枚举值前向兼容
  （`validateEvent` 放行、`lintEvent` 告警），新版本生产方不会击穿旧消费方。
- **护照原件字段禁止出现在事件中**：`validator.findIdentityLeaks` 递归扫描 `payload`，
  命中 `passport_number / surname / date_of_birth / 证件影像` 等特征即拒绝落账。
  需要原件时，事件只携带 `payload.sealed_ref`（保险库密封件引用）。

## 2. 模块总览（`src/runtime/`）

| 模块 | 职责 |
| --- | --- |
| `event-store.js` | 仅追加事件存储；聚合版本乐观并发、event_id 与幂等键去重、订阅分发、按 correlation_id 追踪 |
| `identity-vault.js` | 护照原件密封保管；库内派生资格；访问审计；保留清理；法定留档保护 |
| `assertions.js` | 最小身份断言签发（布尔资格/入住化名）；授权撤回联动失效 |
| `sessions.js` | 旅客会话、服务授权授予/撤回（撤回是状态翻转，不是删除） |
| `reservations.js` | 预订占用（幂等占位）、二维码凭证签发/轮换/核销、酒店换订 |
| `itinerary.js` | 行程提案/确认版本化；已确认交通住宿锚点防静默替换；版本差异 |
| `payments.js` | 支付与外卡充值状态机；回调去重；补偿退款（幂等） |
| `policies.js` | 各服务方差异化的凭证形态、失败重试/超时策略、保留类别 |
| `orchestration.js` | Saga 引擎：按服务方策略重试、反向补偿、可恢复续跑、步骤可观测 |
| `translation.js` | 拍照翻译：原图来源/哈希、OCR 置信度、过敏原提示、人工更正追加留痕 |
| `tax-refund.js` | 退税资格断言、材料密封留档、授权撤回只阻断后续报送 |
| `views.js` | 游客进度视图、运维脱敏追踪视图 |
| `platform.js` | 装配根与便捷入口（核验、授权即断言、撤回级联、保留清理） |

## 3. 需求到机制的逐条对应

### 3.1 同一入口、不同服务方规则
入口 `Platform.verifyPassport` 只做一次护照核验并密封原件，开出 `traveler_session`。
之后各服务方通过**显式授权 + 最小断言**接入，凭证形态、重试策略、保留规则登记在
`policies.js`（如酒店用绑定占用版本的 `booking_qr_v1`，支付网络用 `signed_callback`，
翻译服务 `credential: none` 完全不碰身份）。

### 3.2 最小化身份断言（护照原件不扩散）
- 商户只需资格时只能申请 `entry_eligibility / adult_status / tax_refund_eligibility` 等，
  返回值是**布尔**；酒店得到的是 `hotel_registration_alias` 化名，不可逆出真实姓名。
- 判定在保险库内完成（`AssertionService.#evaluate`），原件不出库；事件中只有 `sealed_ref`。
- 每次密封访问写审计（服务方、用途、时间、放行/拒绝原因）；运维视图只能看到拒绝元数据。

### 3.3 授权撤回：阻断后续用途，不破坏法定留档
`revokeAuthorization` 做三件事：授权状态翻转为 `revoked`、该服务有效断言全部失效、
阻断退税后续报送。但：
- 撤回前已确认的预订、已扣款交易、已收集退税材料**原样保留**（`legal_hold`）；
- `AUTHORIZATION_REVOKED` 事件 payload 显式带 `retained: true`；
- 授权记录本身保留，游客可回看“何时授予、何时撤回”。

### 3.4 酒店换订与二维码失效
凭证与“具体一次占用”三元绑定：`reservation_id + occupancy_version + credential_id`。
- `rebook()` 产生新预订（版本号 +1，记录 `supersedes`），释放旧预订（留档保留），
  旧码立即置 `rotated`，再签发新码（`CREDENTIAL_ROTATED`）。
- 商户扫旧码得到明确拒绝：“二维码已被换订轮换，请使用最新二维码”，不会放行。
- 同一预订重复签发也轮换旧码；预订释放会撤销其全部活跃凭证。

### 3.5 行程版本与锚点保护
- 客流、价格、营业时间变化只能先形成 `proposal`（`ITINERARY_PROPOSED`），
  游客确认后才是 `confirmation`。
- 已确认且绑定确认预订的交通/住宿在确认时冻结为 **anchor**。后续提案若删除锚点、
  替换其预订或改动核心安排，直接抛 `ANCHOR_PROTECTED`，要求游客走显式换订流程。
- 新增活动、并列替代不受限；`itinerary.diff()` 给出条目级 added/changed/removed 差异。

### 3.6 幂等：重复回调不二次扣款、不重复占位
- 支付：业务键 `client_payment_id` 发起幂等；回调以 `payment_id:callback_id` 去重，
  重投只回放首次结果并落 `CALLBACK_DEDUPED`；不同流水号的迟到成功通知也不入二账；
  “已扣款又收到失败通知”不改写状态，抛 `PAYMENT_CONFLICT` 挂起人工争议。
- 占用：`idempotency_key` 重放同一占用；同一活资源的新键抢占被拒。
- 事件存储层还有 `event_id` 与幂等键双重去重兜底。

### 3.7 跨系统超时与可恢复补偿
- 每个步骤采用所属服务方登记的 `max_attempts / backoff_ms / timeout_ms`（`policies.js`），
  尝试次数与错误全程写入 `orchestration_step`。
- 重试用尽不残留脏状态：逆序只补偿已成功步骤（`COMPENSATION_STARTED`）。
  补偿动作建立在幂等原语上（释放占用、原路退款均幂等）。
- 补偿中途受阻可 `resumeCompensation`（`COMPENSATION_RESUMED`），从断点续跑；
  已补偿步骤跳过，已完成实例再次续跑是空操作；全部结束落 `COMPENSATION_COMPLETED`。

### 3.8 拍照翻译溯源与过敏原
`translation.request` 记录原图来源（渠道、拍摄时间、SHA-256 哈希；不存可还原影像）、
OCR 文本、置信度、过敏原命中；置信度 < 0.85 给低置信度警示。
人工 `correct()` **追加**更正记录（更正人、时间、由→至），机器原文与置信度不被覆盖。

### 3.9 数据保留（按服务方不同规则）
保留类别：`session_working / hotel_register / payment_ledger / tax_refund_record / translation_source`。
`vault.sweep()` 只删除“已过期且无 legal_hold”的密封件（`DATA_PURGED`）；
法定留档即使保留期届满也继续留存（`DATA_RETENTION_EXPIRED`，`retained: true`），清理本身幂等。

### 3.10 双端可观测
- **游客视图** `views.travelerDashboard`：每步的处理方、状态、尝试次数、失败原因与中文
  “后续怎么办”，以及授权、断言（资格形式）、预订凭证、行程版本、支付、翻译更正、退税状态。
- **运维视图** `views.opsTrace(correlationId)`：跨服务事件时间线、失败步骤、重试/补偿/去重统计、
  被拒绝的身份访问；只下发排障元数据与中文摘要，**不下发 payload**，
  视图声明且由测试保证不含护照号、姓名、出生日期、影像或 `sealed_ref`。

## 4. 事件清单（本次新增，均为追加）

`IDENTITY_ASSERTION_ISSUED/REVOKED`、`AUTHORIZATION_REVOKED`、`RESERVATION_HELD/RELEASED`、
`CREDENTIAL_ROTATED`、`ITINERARY_PROPOSED/CONFIRMED`、
`PAYMENT_INITIATED/CAPTURED/REFUNDED/FAILED`、`CALLBACK_DEDUPED`、
`STEP_STARTED/SUCCEEDED/FAILED`、`COMPENSATION_RESUMED/COMPLETED`、
`TOPUP_REQUESTED/COMPLETED`、`TRANSLATION_REQUESTED/CORRECTED`、
`TAXFREE_DOCUMENT_COLLECTED`、`DATA_RETENTION_EXPIRED/PURGED`。

## 5. 验证

```bash
npm test          # 25 个用例：契约一致性/前向兼容/身份扩散、撤回语义、二维码轮换、
                  # 锚点保护、回调去重、超时补偿与续跑、翻译更正、保留清理、双视图脱敏
npx tsc           # src/domain.ts 类型检查
node examples/walkthrough.mjs   # 端到端中文演示
```
