# video-pipeline Roadmap

## 目标定位

本项目后续不按“通用产品”规划，按“内部运维平台”规划。

最终目标：

- 稳定发现并处理指定 UP 的新视频
- 自动完成转写、总结、发布、巡检、补偿
- 在 Web 后台中完成观察、排障、重跑、发布控制和基础配置管理
- 让 CLI、scheduler、Web API 共用同一套业务能力，而不是各自复制逻辑

不追求的目标：

- 过早做成通用 SaaS
- 过早引入重型基础设施
- 为了界面而重写现有稳定流水线

## 目标形态

达到第二阶段后，项目应具备以下能力：

- 一个可常驻运行的 scheduler
- 一个可查看活跃任务、最近失败、历史运行和单视频详情的 Web 后台
- 一组可执行的管理操作：重跑、取消、补发、重新构建发布线程、手动触发 sweep
- 一套清晰的结构化事件、状态和审计记录
- 一套可被 CLI、scheduler、Web API 复用的 service 层

## 技术栈决策

按当前目标，技术栈固定为：

- 后端：`Fastify + TypeScript`
- 前端：`React + Vite`
- 前端数据层：`TanStack Query`
- 表格与筛选：`TanStack Table`
- 实时更新：`SSE`
- 参数校验：`zod`
- 数据库：继续使用 `SQLite`
- 样式：`Tailwind CSS`

暂不引入：

- `Next.js`
- `NestJS`
- `WebSocket`
- `Postgres`

## 架构演进原则

1. 先抽业务层，再做 Web 层

- 先把“运行流水线、触发发布、查询状态、重试任务”抽成 service
- CLI、scheduler、Web API 都只调用 service

2. 先做只读可观测，再做管理操作

- 先解决“看得清”
- 再解决“控得住”

3. 先做平台最小闭环，再补体验

- 优先补任务状态、失败恢复、审计链路
- 后补筛选、排序、批量操作、页面细节

4. 保持单机可维护

- 在明确撞到瓶颈前，继续以单机 `SQLite + Node scheduler` 为主
- 不因为“可能扩展”提前引入分布式复杂度

## 分阶段开发计划

### Phase 0：业务层收口

目标：把现有 CLI/scheduler 的核心能力整理成可复用 service，为 Web 接入做准备。

交付项：

- 抽出统一的 `pipeline service`
- 抽出统一的 `publish service`
- 抽出统一的 `scheduler control service`
- 抽出统一的 `pipeline query service`
- 明确 `runId`、`bvid`、`status`、`scope/action` 的状态模型
- 明确 Web 可调用的管理动作接口边界

建议目录：

- `packages/core/`
- `apps/api/`
- `apps/web/`

验收标准：

- CLI 仍可正常运行
- scheduler 仍可正常运行
- 不需要直接从 route 或 command 里拼业务 SQL

### Phase 1：可观测后台 MVP

目标：先上线只读后台，解决并发任务“无序、难看清、难定位”的问题。

交付项：

- `GET /api/dashboard/active-pipelines`
- `GET /api/dashboard/recent-runs`
- `GET /api/dashboard/pipeline/:bvid`
- `GET /api/dashboard/events/stream`
- Web 首页任务总览
- 活跃流水线表格
- 最近完成/失败列表
- 单视频详情页

页面最小范围：

- Dashboard
- Pipeline Detail
- Recent Failures

展示字段至少包括：

- `bvid`
- 视频标题
- 当前阶段
- 当前分 P
- 最近消息
- 开始时间
- 最近更新时间
- 运行状态
- 日志路径 / 产物路径

验收标准：

- 能稳定看到每条活跃流水线的一行状态
- 并发运行时不依赖滚动日志判断进度
- 失败任务能在页面中定位到视频、阶段和最近错误

### Phase 2：管理操作 MVP

目标：让后台不仅能看，还能做基本控制。

交付项：

- 手动触发 summary sweep
- 手动触发 publish sweep
- 重跑单条 pipeline
- 针对单视频重新发布
- 针对失败任务执行 retry
- 标记发布线程重建
- 查看当前 scheduler 运行状态

推荐 API：

- `POST /api/actions/summary-sweep`
- `POST /api/actions/publish-sweep`
- `POST /api/actions/pipeline/:bvid/retry`
- `POST /api/actions/pipeline/:bvid/publish`
- `POST /api/actions/pipeline/:bvid/rebuild-publish-thread`
- `GET /api/scheduler/status`

操作要求：

- 每个管理操作都要有审计记录
- 每个操作都要有明确的成功/失败返回结构
- 高风险操作要有二次确认

验收标准：

- 常见人工补救动作不再需要手敲 CLI
- 管理动作执行后能在后台立刻看到状态变化
- 所有操作可回溯到触发时间、参数和结果

### Phase 3：运维闭环

目标：把“出错后人工排障”推进到“可恢复、可补偿、可复盘”。

交付项：

- 失败队列页
- 失败原因聚类
- 常见错误的自动重试策略
- 手动取消运行中任务
- 任务幂等保护
- 任务超时和僵尸任务识别
- 健康检查与运行指标页

重点能力：

- 区分“可自动重试”和“需人工介入”
- 对锁冲突、风控、字幕缺失、发布失败分别建模
- 让单视频详情页能看到完整时间线

验收标准：

- 同类失败能被快速聚合
- 人工排障成本显著下降
- scheduler 长时间运行后仍能自恢复

### Phase 4：配置与运营能力

目标：把日常维护动作从代码和环境变量移到后台。

交付项：

- `SUMMARY_USERS` 管理
- 并发数配置
- 时间窗口配置
- cron 计划可视化
- 模型参数与 prompt 配置入口
- 发布策略配置
- 缺段巡检和清理策略配置

边界要求：

- 第一版配置可以仍然落在本地文件或 `SQLite`
- 所有变更都要有变更记录
- 配置更新要有生效范围说明

验收标准：

- 常见运维参数不需要改 `.env` 或源码
- 配置变更可审计、可回滚、可解释

## 建议实施顺序

建议按下面顺序推进，不要并行铺太开：

1. 抽 `core service`，收口业务层
2. 补齐状态查询接口和事件聚合
3. 上线只读后台 MVP
4. 增加最关键的管理动作
5. 补失败队列、取消、重试和审计
6. 最后再做配置管理

## 数据与接口补强清单

为支持 Web 后台，建议补齐以下模型：

- 活跃任务快照
- 任务最终状态
- 任务取消状态
- 任务触发来源：`cli | scheduler | web`
- 操作审计记录
- 事件聚合视图

建议新增或明确的数据表：

- `pipeline_runs`
- `pipeline_run_state`
- `operation_audits`

说明：

- `pipeline_events` 继续保留，作为明细事件流
- 新表更偏“当前状态”和“管理操作”
- 不建议把所有页面查询都直接压在 `pipeline_events` 明细扫描上

## 风险与控制

### 风险 1：Web 直接绕过业务层

控制：

- route handler 只做校验和 service 调用
- 禁止在页面需求里临时拼业务 SQL

### 风险 2：状态模型不清导致页面和实际运行不一致

控制：

- 先定义有限状态集合
- 先定义事件到状态的聚合规则
- 把“当前状态”和“事件明细”分开

### 风险 3：管理操作破坏现有调度稳定性

控制：

- 所有管理操作先走单入口 service
- 引入幂等键和锁保护
- 高风险操作先串行

### 风险 4：过早做复杂权限系统

控制：

- 第二阶段先按单用户/内网工具设计
- 权限只保留最小预留点，不先做完整 RBAC

## 里程碑定义

### Milestone A：看得清

- Web 能展示活跃任务、最近失败、单视频详情
- 并发任务不再依赖滚动日志观察

### Milestone B：控得住

- Web 能触发重跑、补发、sweep
- 常见人工操作从 CLI 迁到后台

### Milestone C：能恢复

- 失败任务可聚合、可重试、可取消、可复盘
- 常驻运行稳定性明显提升

### Milestone D：好维护

- 常见配置和日常运维动作可在后台完成
- 代码层、调度层、管理层职责清晰

## 当前建议

如果接下来只做一件事，优先做：

- `Phase 0 + Phase 1`

原因：

- 这是后续所有管理能力的基础
- 先把状态模型和读接口打稳，后续增量最顺
- 如果业务层没收口，Web 很容易变成另一套拼接逻辑
