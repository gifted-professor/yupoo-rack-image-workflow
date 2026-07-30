# Yupoo 实体货架图工作流

把 Yupoo 相册当作商品事实来源，并发生成五张统一风格图片：**正面实体货架图**、**反面实体货架图**、**实体店试穿主图**、**实体店试穿近景**和**实体店试穿背面图**。其余详情图直接使用 Yupoo 原图，不重新生成。

当前版本已经固化 2026-07-20 的实测结论：CPA 并发 4 路稳定；两款商品共四张首轮生成约 107 秒。生成后必须经过色差与结构检查，合格图片才会被写入准确价格并进入最终目录。

## 不会遗漏的关键规则

- Yupoo 图片决定款式、颜色、Logo、面料和结构；门店图只决定场景。
- 每个视角最多 5 张参考图：1 张门店、1 张价格牌结构、最多 3 张商品图。
- 每个视角必须指定一张 `color_authority`，并且它必须包含在商品参考图中。
- 所有新生成图固定为竖版 `1080 × 1440`（宽:高 `3:4`）；完整主体放在安全区，必要时以模糊延展补足画布，不直接裁掉商品、价格牌或人物。
- AI 只生成空白的橙色上联、黑色下联实体牌，不让模型生成文字和数字。
- 拿货价必须确认。卖价为 `拿货价 / 0.6` 后向上取以 9 结尾的价格；135 → 229，60 → 109。
- 不显示建议零售价，不显示虚构折扣率。
- 首轮结果只进入 `runs/<run-id>/review/`。
- 只有状态为 `APPROVED_FOR_PRICE` 的图，才能自动写价格并进入 `outputs/`。
- 试穿图不写价格牌；只有状态为 `APPROVED_FOR_PUBLISH` 才能原样进入 `outputs/`。
- 色差、Logo、拼接线、口袋、拉链等任一项不对，标记 `REPAIR_REQUIRED`，走定点修复，不整张重做。

## 项目结构

```text
assets/                 门店场景与空白价格牌结构参考
config/                 定价、提示词、批次、修复、审核示例
docs/                   完整流程、运行手册和实测报告
examples/               已通过检查的成品与 Yupoo 示例参考
scripts/                并发生成和修复入口
src/                    相册抓取、宫格图、定价、价格牌程序
tests/                  定价、门禁、价格牌检测测试
work/items/<SKU>/       每个商品的 Yupoo 原图、宫格图和清单
runs/<run-id>/review/   待人工检查的生成图
outputs/                审核后正式成品
```

相册取证完成后，每个 SKU 还会生成两份发布资料：

- `product-facts.json`：人工确认过的品牌、品类、材质、功能、场景、尺码和证据来源。
- `publish-draft.json`：只使用上述事实生成的标题、商品简称、价格、标签和图片顺序。初始状态固定为 `DRAFT_REVIEW`，不能直接发布。

微商相册发布默认值集中在 `config/publishing.json`：每个颜色/尺码规格库存 10、使用“全国统一运费 10 元”、只从已经存在的标签白名单中匹配品牌和品类标签。Yupoo 标题中的 `S-XXL` 等尺码范围会自动展开；颜色没有文字或官方证据时保持待确认。

`classification.json` 中的 `facts.colors` 只表示买家能够选择的独立色号。衣服上的包边、Logo、条纹和拼接等装饰色不能拆成额外颜色规格；颜色或尺码任一项未确认时，发布草稿不生成规格组合，也不预填库存。

## Tailscale 商品发布审核台

审核台会实时读取 `work/items/` 与 `runs/*/review/`，按商品卡片展示货号、价格、目的地和审核状态。点开商品后可以统一检查五张生成图、发布文案、颜色尺码库存与运费，并为微购相册发出人工确认信号。

```bash
npm run dashboard -- --host <本机的 Tailscale IPv4> --port 8910
```

审核地址为 `http://<本机的 Tailscale IPv4>:8910/`。请绑定运行机器自己的 Tailscale 地址，不要使用 `0.0.0.0`，避免监听非预期网卡。目的地状态定义在 `config/destinations.json`：

- 微购相册当前连接器为 `dry_run_only`。点击确认会原子写入 `work/approval-signals/` 和 `work/publish-queue/`，队列状态为 `APPROVED_WAITING_FOR_CONNECTOR`，不会冒充已经发布。
- 小红书目前显示为待接入目的地，不能点击确认。
- 页面确认要求商品事实、价格、规格、运费和五张图片都已齐全；非人工审核类 blocker 仍会阻止入队。
- 接入真实发送器后，只有连接器状态明确改为 `active` 的目的地才会进入 `QUEUED_FOR_DISPATCH`。

## 小红书四宫格封面

四宫格固定输出为竖版 `1080 × 1440`：上排使用已经写入售价的货架正面、货架背面，下排使用上身正面、上身背面。完整来源图会放入对应格子，不裁掉价格牌或服装主体。

```bash
npm run xhs-covers -- --sku IH1976-100
```

多个货号可以用逗号分隔。输出保存在 `work/items/<SKU>/xhs-cover/four-grid.jpg`，并保持 `REVIEW_PENDING`，不会自动发布。

## 飞书同链路同步

当前商品资料继续使用飞书多维表格“相册商品”作为唯一运营入口。主表会保存商品事实、完整平台文案、价格、规格、审核状态和发布包状态；正面/背面货架图、三张试穿图、小红书四宫格与 Yupoo 原图会作为附件挂在同一条 SKU 记录上。

先预览同步范围：

```bash
npm run push-status -- --dry-run --full
```

确认后执行同步：

```bash
npm run push-status -- --apply --full
```

同步只写入飞书资料和附件，不代表微购、闲鱼或小红书已经发布；外部发布仍必须由对应连接器返回真实发布编号。重复 SKU 行会同步文字，但图片只挂到该 SKU 的首条记录，避免附件重复。

## 第一次安装

macOS/Linux：

```bash
git clone https://github.com/gifted-professor/yupoo-rack-image-workflow.git
cd yupoo-rack-image-workflow
npm install
npm run setup
cp .env.example .env
npm test
```

Windows PowerShell：

```powershell
git clone https://github.com/gifted-professor/yupoo-rack-image-workflow.git
Set-Location yupoo-rack-image-workflow
npm install
npm run setup
Copy-Item .env.example .env
npm test
```

`npm run setup` 会在两种系统上创建正确结构的 Python 虚拟环境并安装依赖。实际生成前需要 `.env` 指向可访问的 CPA 图片桥；审核和 dry-run 不代表已经对外发布。

## 一次商品批次

### 1. 下载 Yupoo 原图并生成宫格图

先复制 `config/classification.example.json`，人工确认宫格里的正面、反面与细节编号，再执行：

```bash
npm run python -- src/product_image_workflow.py run \
  --album-url 'YUPOO_ALBUM_URL' \
  --classification config/AB1234-001.classification.json \
  --scenes config/store-scenes.json \
  --pricing config/pricing.json \
  --confirm-cost
```

不加 `--confirm-cost` 时，定价状态固定为 `BLOCKED_UNCONFIRMED_COST`。

### 2. 配置并发生成

复制 `config/batch.example.json` 为新批次，替换 SKU、成本、品类、参考图、正反面提示词和 `tryon_views`，并把 `enabled` 改为 `true`。同一 SKU 的五张图按全局并发值同时生成。

```bash
node scripts/generate-racks.mjs --batch config/my-batch.json --dry-run
node scripts/generate-racks.mjs --batch config/my-batch.json
```

程序会生成 `runs/<run-id>/review.json`，所有图片初始状态都是 `REVIEW_PENDING`。任一视角失败时进程以非零状态结束，但已成功图片仍保留，可通过 `enabled_views` 只重试缺失视角。

### 3. 检查与定点修复

按 [完整流程](docs/WORKFLOW.md) 的六项清单逐张检查。失败项复制到 `config/repairs.example.json` 后运行：

```bash
node scripts/repair-racks.mjs --batch config/my-repairs.json --dry-run
node scripts/repair-racks.mjs --batch config/my-repairs.json
```

### 4. 审核后写价格

货架图合格项改成 `APPROVED_FOR_PRICE`，试穿图合格项改成 `APPROVED_FOR_PUBLISH`，不合格项保持 `REPAIR_REQUIRED`：

```bash
npm run python -- src/product_image_workflow.py finalize-batch \
  --review runs/<run-id>/review.json \
  --pricing config/pricing.json \
  --report runs/<run-id>/finalize-summary.json
```

只有通过审核的图片会出现在 `outputs/`。

## 文档

- [完整工作流](docs/WORKFLOW.md)
- [已确认决策](docs/DECISIONS.md)
- [运行与故障处理](docs/RUNBOOK.md)
- [提示词规范](docs/PROMPT-RULES.md)
- [2026-07-20 并发实测](docs/VALIDATION-2026-07-20.md)
