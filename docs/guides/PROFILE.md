# 群友档案 / 长记忆（PROFILE）

> 2026-10-19 落地（QQ 桌面命令 #17）。
> 一句话：机器人现在能记住「谁、在哪天、因为什么、说了什么」，并在下次跟这个人说话时自然带上，而不是只有几条随手写的便签。

---

## 一、三层记忆怎么分层

| 层 | 存在哪 | 谁写 | 存活时间 |
| --- | --- | --- | --- |
| **短期**「当前在聊什么」 | `state/social-v2.json` 的 `activeTopics`（既有机制，未改） | 桥接在每条消息后维护 | 分钟级，自动滚动 |
| **个人档案**「这个人是谁、在意什么」 | `state/profiles.json` → `people[QQ]` | AI 用 `qq_profile_write` 写；或桥接在对话告一段落后自动抽取 | 长期，权重随时间半衰期衰减（默认 30 天减半），低权重的过期内容自动清理 |
| **群文化**「这个群的黑话/梗/称呼」 | `state/profiles.json` → `groups[群号].terms` | AI 用 `qq_profile_write` + `groupId`/`term` 写 | 长期，靠 `count`（被提到次数）自然排前 |

这三层互不覆盖：短期层答「这轮在聊啥」，档案层答「这人什么情况」，群文化层答「群里的黑话是啥意思」。

---

## 二、只记具体事例，不贴标签

档案库在**入库时**就拦空泛评价，不靠事后自觉：

- `kind` 白名单：`event`（重要事件）/ `care`（在意的事）/ `avoid`（雷点）/ `topic`（常聊话题）/ `style`（说话风格）/ `nickname`（称呼）/ `note`（其它事例）。
- 文本 6–160 字；`evidence`（原话节选）≤ 80 字。
- **纯标签写法直接拒绝**：`他很温柔`、`挺可爱的`、`有点高冷` 这类会被 `looksLikeBareLabel()` 判为「只有形容词没有事实」，返回 `这像空泛评价/标签，请改成具体事例（谁在哪天做了什么、原话是什么）`。
- 正确写法举例：
  - ✅ `event`：`2026-10-19 说这周三要去医院复查膝盖，上周踢球扭伤了`
  - ✅ `avoid`：`明确说对猫毛过敏、以前被猫挠过，让人别老提猫`
  - ✅ `style`：`爱用括号补刀，例如「行吧（你开心就好）」`
  - ❌ `note`：`他人很好`

### 隐私：敏感信息不落库

入库前统一 `scrubSensitive()`，命中就替换成 `[已隐去]`：

| 类型 | 例子 |
| --- | --- |
| 手机号 / 座机 | `100000001`、`0379-12345678` |
| 身份证号 | `110101199001011234` |
| 邮箱 | `a.b@c.com` |
| 密码 / 验证码 / token | `密码: hunter2`、`验证码 123456` |
| 住址 / 快递单号 | `某小区 3 号楼`、`SF0000000000` |
| 银行卡 / QQ 密码类字段 | `卡号 6222…` |

整条全是敏感信息（有效内容 < 4 字）时**整条拒绝**，不会留下「[已隐去]」空壳记录。

---

## 三、自动抽取：对话告一段落再写

不是每条消息都记——那样会把自己的上下文喂成垃圾场。

**触发条件**（`sweepProfiles()`，每 60 秒扫一次）：

1. 该会话缓存的消息窗口里还有未被抽过的内容；
2. 未抽条数 ≥ `sliceMinMessages`（默认 6 条）；
3. 距离最后一条消息已安静 ≥ `settleIdleMs`（默认 6 分钟）；
4. 距离上次抽取 ≥ `extractCooldownMs`（默认 30 分钟）。

**抽取过程**：把这段窗口（最多 40 条）喂给 DSH 的一个**独立学习会话**（preset 用 `qq-chat-v2` 的严格子集，只允许读写档案，不给发送能力），要求它输出 JSON 数组；桥接自己再跑一遍入库校验（`parseProfileJson` → `validateRecordInput`），所以模型写歪了也进不了库。

- 单次最多写 8 条（`extractMaxRecords`），单窗口最多 40 条消息。
- 抽取失败不会清零待抽条数（下轮重试），`extractFailures` 累计。
- 抽取记录 `ok/failed` 都写进 `state/profiles.json` 的 `settle` 段，便于排查。

> 抽取用的模型 = DSH 的默认模型（当前 `deepseek-account/deepseek-flash`）；不额外走 ComfyUI 那条本地链路。

---

## 四、AI 侧：四个工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `qq_profile_write` | 写一条具体事例，或写群文化术语 | `key`、`token`、`personId`、`kind`、`text`、`at`、`evidence`；群文化用 `groupId`、`term`、`meaning`、`termKind`、`example` |
| `qq_profile_query` | 查某人的档案/某群的黑话 | `key`、`token`、`personId`、`kind?`、`limit?`、`groupId?` |
| `qq_profile_remove` | 删单条（`id`）或按内容（`text`）或整份（`all:true`，不可恢复） | `key`、`token`、`personId` |
| `qq_profile_clear` | 整体清空所有档案与群文化（不可恢复）：必须显式 `confirm:true` | `key`、`token`、`confirm` |

开关：`socialV2.profile.enabled !== false` 且 `socialV2.tools.profile !== false`。

**提示词注入**：唤醒时会自动把「档案纪要」拼进系统提示（`formatProfilesV2`）：

```
【档案 · 100000001】
  - 事件：说这周三要去医院复查膝盖，上周踢球扭伤了
  - 雷点：明确说对猫毛过敏、以前被猫挠过，让人别老提猫
  - 话题：2026-11-08 正在准备软考高项，11月8号考试
```

注入有硬预算：最多 `injectMaxPersons`（默认 3）人、整段 ≤ `injectMaxChars`（默认 900 字符），每人最多 4 条、每类最多 1 条，按 `权重 × 类别优先级` 取前几条。权重低/过期的记录不会挤进来。

---

## 五、配置（`config.json` → `socialV2.profile`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（关掉后不抽取、不注入，接口返回 503） |
| `settleIdleMs` | `360000` | 安静多久算「告一段落」（6 分钟） |
| `sliceMinMessages` | `6` | 至少攒够几条才抽 |
| `extractCooldownMs` | `1800000` | 同一会话两次抽取的最小间隔（30 分钟） |
| `injectMaxPersons` | `3` | 一次唤醒最多注入几个人的档案 |
| `injectMaxChars` | `900` | 档案注入的字符上限 |

代码里还有一批不常改的常量（`PROFILE_DEFAULTS`）：`maxPeople 200`、`maxRecordsPerPerson 80`、`maxTermsPerGroup 120`、`halfLifeDays 30`、`pruneWeight 0.12`、`pruneAfterDays 120`、`sweepIdleMs 60000`。

---

## 六、操作者（控制台）接口

全部要求 `x-console-token`；**带 `x-agent-token` 一律 403**（AI 只能走 `/api/socialV2/profile-*`）。

```bash
TOKEN=$(cat state/console-token)

# 查某人
curl -H "x-console-token: $TOKEN" "http://127.0.0.1:3100/api/profile?personId=100000001"

# 列所有人
curl -H "x-console-token: $TOKEN" "http://127.0.0.1:3100/api/profile"

# 手写一条（同样过校验与脱敏）
curl -X POST http://127.0.0.1:3100/api/profile/write \
  -H "x-console-token: $TOKEN" -H "content-type: application/json" \
  -d '{"personId":"100000001","kind":"event","text":"2026-10-19 说想要群友档案功能","at":"2026-10-19"}'

# 只删一条
curl -X POST http://127.0.0.1:3100/api/profile/remove \
  -H "x-console-token: $TOKEN" -H "content-type: application/json" \
  -d '{"personId":"100000001","id":"rec_xxxxxxxx"}'

# 删掉某人的整份档案（不可恢复）
curl -X POST http://127.0.0.1:3100/api/profile/remove \
  -H "x-console-token: $TOKEN" -H "content-type: application/json" \
  -d '{"personId":"100000001","all":true}'

# 一键清空全部档案与群文化（必须 confirm，不可撤销）
curl -X POST http://127.0.0.1:3100/api/profile/clear \
  -H "x-console-token: $TOKEN" -H "content-type: application/json" \
  -d '{"confirm":true}'

# 立即抽取某会话（不用等 6 分钟）
curl -X POST http://127.0.0.1:3100/api/profile/extract \
  -H "x-console-token: $TOKEN" -H "content-type: application/json" \
  -d '{"key":"private:100000001"}'
```

> 带中文的 body 用 `curl -d` 在 Windows 下容易被按 ANSI 编码；用 `--data-binary @body.json`（文件存 UTF-8）更稳。

---

## 七、存储与降权

`state/profiles.json` 结构：

```json
{
  "version": 1,
  "meta": { "createdAt": 0, "updatedAt": 0, "migratedImpressions": true },
  "people": {
    "100000001": {
      "personId": "100000001",
      "nicknames": ["管理员"],
      "scopes": ["private:100000001"],
      "records": [
        { "id": "rec_…", "kind": "event", "text": "…", "at": "2026-10-19",
          "weightBase": 0.72, "seenCount": 2, "createdAt": 0, "lastSeenAt": 0 }
      ]
    }
  },
  "groups": { "100000001": { "terms": [ { "term": "开盒", "count": 3 } ] } },
  "settle": { "private:100000001": { "pendingMessages": 0, "lastExtractAt": 0 } }
}
```

**权重**：`effectiveWeight = weightBase × 0.5^(天数/半衰期) + 提到次数加成`。类别基础权重 `avoid 0.9 / care 0.85 / event 0.75 / topic 0.65 / style 0.6 / nickname 0.7 / note 0.5`。

**清理**：权重 < `pruneWeight` 且超过 `pruneAfterDays` 的记录在每轮 sweep 里删掉；一个人删空后整条档案消失。

**旧数据迁移**：第一次启动时会把 `social-v2.json` 里既有的 `memberImpressions`（便签式印象）转成 `kind:'legacy'` 记录，标记 `migratedImpressions: true`，只迁一次。`legacy` 记录**不注入提示词**（避免把旧的空泛印象直接塞回去），但能查到、能删。

---

## 八、已知限制

- 抽取依赖 DSH 会话可用；DSH 挂了只会积压 `pendingMessages`，不会丢消息窗口之外的上下文（窗口本身是最近 40 条，更早的确实会丢）。
- 群文化术语目前只能由 AI 写、控制台删；没有「整群档案重置」以外的批量导入。
- 没有向量检索——查询是「按人 + 按类别 + 按权重」的确定性检索，规模到几千条仍然够用，真要做语义检索再谈。
- 不会主动对群友说「我记得你…」——注入只是让模型「知道」，说什么仍由模型自己决定，避免变成别扭的备忘录朗读。

---

## 九、自测

```bash
node scripts/test-profiles.mjs      # 31 项离线单测（存储/校验/脱敏/衰减/抽取解析/清理）
node scripts/test-mcp-servers-stdio.mjs   # 确认四个 qq_profile_* 工具已注册（应为 47 个工具）
```

端到端（需要桥接 + DSH 在跑）：控制台 `/api/profile/extract` 触发一次真实抽取，看 `state/profiles.json` 是否多出记录、以及唤醒提示里是否出现 `【档案 · QQ】` 段。
