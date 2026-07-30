# 运行与故障处理

## 运行前检查

```bash
curl -s http://127.0.0.1:8317/v1/models -H 'Authorization: Bearer cliproxyapi-local' >/dev/null
curl -s http://127.0.0.1:8907/api/config
node scripts/generate-racks.mjs --batch config/my-batch.json --dry-run
```

预期图片路由：

```text
本项目 → 127.0.0.1:8907/api/image/generate
      → CPA 127.0.0.1:8317/v1/responses
      → Responses 模型
      → image_generation(gpt-image-2)
```

如果 `8907` 没启动，请在图片桥项目所在机器启动服务：

```bash
npm run serve
```

## 常见问题

### 色差明显

不要写价格。标记 `REPAIR_REQUIRED`，使用生成图作为第一张修复目标，再放 1–2 张 Yupoo 颜色基准，只修颜色。

### 多出翻盖、口袋或拼接

使用定点结构修复，明确“保留哪些部分、删除哪个错误结构”，并引用对应细节图。

### 价格牌有伪文字

不能进入成品。先修复为空白牌，再运行 `finalize-batch`。不要直接覆盖伪文字，否则底层痕迹会显得像 P 图。

### 自动找不到价格牌

确认橙色上联位于画面顶部约 18% 范围，并且黑色下联紧邻其下。必要时可单张使用：

```bash
npm run python -- src/product_image_workflow.py render-physical-sign \
  --input review.png --output final.jpg --cost 135 \
  --pricing config/pricing.json \
  --upper-box x1,y1,x2,y2 --lower-box x1,y1,x2,y2 \
  --category 外套 --category-en Outerwear
```

### 并发请求失败

查看 `runs/<run-id>/summary.json` 和 `responses/`。网络或上游错误可以重新跑失败任务；模型返回 fallback 预览时程序会按失败处理，不会当成成品。

## 每周维护

- 查看最近运行的失败与修复比例。
- 如果同类商品持续出现同一结构错误，把约束加入公共提示词规则。
- 保留实测通过的门店场景，淘汰导致颜色漂移或空展厅感的参考图。
- 定价规则变化时先改测试，再改 `config/pricing.json`。
