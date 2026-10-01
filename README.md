# 野生菌采集鉴定图谱（gbfungiguide）

面向蘑菇野外调查爱好者与地方菌物名录整理者，把「采集点 → 形态描述 → 孢子印 → 菌褶/菌管着生方式 → 鉴定结论」整理成可对照的图谱条目，解决形态特征记不全、描述口径不一、鉴定结论缺乏依据留痕的问题。同时内置**称谓对账**：把名录中心下发的称谓表粘进来与鉴定留痕对账，并名与版本变动由鉴定人逐条认过，认过的攒成回执送回中心。**纯前端单页应用**，数据全部保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

> 免责声明：本工具仅用于采集记录与形态整理，**内容不可作为食用依据**；鉴定须与权威图鉴和专业人员复核。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21816>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbfungiguide
FRONTEND_PORT=21816
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21816
npm run build      # 类型检查 + 生产构建
```

## 四、目录结构

```
sologsb-1116/
├── docker-compose.yml          # 顶层 name: gbfungiguide，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # record.ts / spore.ts / point.ts / identify.ts / nomen.ts / index.ts
│       ├── stores/             # recordStore / sporeStore / pointStore / identifyStore / nomenStore（Zustand）
│       ├── components/common/  # SporePrintSwatch / TraitsSummary / GillAttachmentTag / GeoPointForm
│       ├── hooks/              # usePersistentStore / useCandidateMatch
│       ├── pages/              # AtlasPage / RecordDetailPage / PointsPage / IdentifyPage / NomenPage / ComparePage
│       ├── router/index.ts
│       └── utils/              # spore.ts / export.ts / id.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| FungusRecord 菌物条目 | 采集编号、暂定名、菌盖（直径/形状/边缘/质地）、菌肉厚度与变色反应、着生方式、菌褶密度、菌柄、菌环菌托、气味、关联树种 | `records` |
| SporePrint 孢子印 | 印色、印形、获取时长、观察日期、样本干湿度 | `spores` |
| CollectPoint 采集点 | 地点名、经纬度、海拔、植被类型、基物、伴生树种、日期、采集人 | `points` |
| IdentifyLog 鉴定结论 | 结论学名、依据、参考图鉴与页码、置信度、是否待复核、复核人、对齐的称谓版本 | `identifies` |
| NomenList 称谓表 | 中心下发的称谓版本、接受名与已并入的老名字（异名）清单 | `nomenLists` |
| ReconcileRun 对账运行 | 一轮对账的排队/进度/受影响与未收录统计（大批量分批执行） | `reconcileRuns` |
| ReconcileItem 对账条目 | 受影响条目与原有结论、并名/版本复核类型、待认→已认→送出→中心收/拒状态 | `reconcileItems` |
| ReceiptBatch 回执批次 | 认过的条目攒批、发送尝试与失败原因、送出时间 | `receipts` |

- 数据库名 `gbfungiguide`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史条目补齐「菌肉变色反应」默认值（不变色）；
- `version(3)` 升级迁移新增称谓对账四张表，并为历史鉴定结论补齐「称谓版本」字段（空串 = 未标注，待对账）；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/atlas` | 图谱总览：网格卡片展示菌盖形态要点、孢子印色块与鉴定状态，按印色/着生方式筛选并新建条目 |
| `/atlas/:id` | 条目详情：形态描述分区折叠、孢子印观察登记、采集点编辑（含坐标校验）、鉴定留痕 |
| `/points` | 采集点管理：经纬度格式校验、条目数与主要基物统计、删除前校验下级条目 |
| `/identify` | 鉴定工作页：左侧勾选形态特征与印色，右侧实时给出候选名录排序，确认后落鉴定结论 |
| `/nomen` | 称谓对账：粘贴中心称谓表排队分批对账，并名/改版结论由鉴定人逐条认过，认过攒回执送中心，拒收留本地写清理由 |
| `/compare` | 条目对比：并排最多 3 条，逐项对照菌盖/菌褶菌管/孢子印差异并高亮 |

## 七、称谓对账流程

1. **粘进来**：把中心下发的称谓表 JSON（`version` + `entries: [{accepted, synonyms[]}]`）粘贴导入，对账任务自动排队，按每批 200 条分批扫描鉴定留痕，几千条也不卡界面；
2. **对账**：结论学名是已并入的老名字 → 生成「并名」待确认；名字仍是接受名但称谓版本落后 → 生成「版本复核」待确认；中心未收录的结论只计数提示，不替鉴定人下结论；
3. **逐条认过**：鉴定人署名后逐条认过，认过才把结论改为接受名并对齐称谓版本，没认的照旧留着；中心再改版时未认完的按新表重新生成；
4. **回执**：认过的攒成回执批次，配了中心接口就 POST 送达，否则导出 JSON 人工转交；发送失败可从站侧重试，已认的条目不跟着退回；
5. **中心结果**：导入中心返回的收/拒结果，收下的标记完结，拒收的留在本地写清理由，可重新提交随下一张回执再送；
6. **待认可见**：图谱卡片与条目详情都会标出还在等认的结论，鉴定留痕表可看到每条结论对齐的称谓版本。

## 八、候选排序规则

- 权重：着生方式 26、孢子印 22、菌盖形状 12、表面质地 10、菌褶密度 10、菌盖边缘 8、菌肉反应 8、关联树种 4；
- 印色与条目着生方式若属于该印色的先验组合（如白色↔离生/弯生），计半分；
- 排序先比总分，总分相同则优先展示着生方式一致的条目。
