# 盐穴储氢全周期注采仿真与完整性评估引擎

纯后端 Node.js + TypeScript 工程服务，围绕盐穴储氢的组分守恒、周期注采、盐岩时效损伤、腔体测腔、地面站能力分配、井筒热压响应、仪表校准、泄漏证据融合、分层提取和参数不确定性计算组织业务。服务仅使用 Node.js 内置模块，可在本机直接运行，不需要 Docker、数据库、商业求解器或网络服务。

本项目用于软件工程与计算流程验证，内置状态方程、本构关系和示例常数不是现场认证模型。正式工程应用须由具备资质的专业人员按适用规范验证，并以经验证的物性、地质、设备和校准数据替换示例模型参数。

## 运行

要求 Node.js 22.12 或更新版本：

```bash
npm test
npm start
```

默认监听 `127.0.0.1:4317`，可用 `PORT` 设置端口。HTTP 使用 JSON 请求和响应，领域错误会返回稳定的 `code`、消息、状态码及可诊断的 `details`。

## API

- `GET /health`
- `POST /v1/inventory/transfer`：按事件时间与同刻序号确定性重放物料台账，重复载荷幂等、同号异载荷冲突，失败批次不留部分状态，返回含审计日志的库存摘要
- `POST /v1/inventory/reconcile`：按成分容差核对库存
- `POST /v1/dispatch/simulate`：按时间线积分注采、温度和压力状态并报告首次越界
- `POST /v1/facility/allocate`：在优先级、最小流量、权重与爬坡约束下分配站场能力
- `POST /v1/wellbore/evaluate`：计算分段液柱压力、热瞬态、环空压力与等效应力
- `POST /v1/monitoring/correct`：按样本时刻选用校准并传播测量不确定度
- `POST /v1/leak/fuse`：融合相关性分组后的泄漏证据与定位信息
- `POST /v1/purity/withdraw`：按工作气/垫底气约束执行连续分层提取和产品混配
- `POST /v1/uncertainty/sample`：生成可重复的相关参数样本与统计摘要
- `POST /v1/cavern/geometry`：积分测腔曲线并反解目标累计容积深度
- `POST /v1/geomechanics/history`：推进盐岩状态历史并计算随损伤收紧的压力窗口
- `POST /v1/gas/state`：求解给定混合气库存、体积和温度下的热力状态

## 代码组织

- `src/domain/inventory/`：量纲换算、组分转换、事务台账和库存核对
- `src/domain/dispatch/`：运行时间线、气体状态方程、约束判定和注采积分
- `src/domain/geomechanics/`：蠕变率、损伤状态推进、历史轨迹和压力包络
- `src/domain/geometry/`：测腔整理、几何积分、界面容积及深度反解
- `src/domain/facility/`：请求约束、优先级、水位分配与爬坡边界
- `src/domain/wellbore/`：液柱/摩阻、热瞬态、环空响应与应力计算
- `src/domain/monitoring/`、`leak/`、`purity/`、`uncertainty/`：校准、证据融合、分层产品和相关抽样
- `src/application/`：用例编排；`src/http/`：基于内置 `node:http` 的 JSON API
- `test/`：Node.js 内置测试运行器
