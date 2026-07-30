# 提示词规范

## 参考图职责必须分开

- Yupoo 商品图：决定颜色、款式、Logo 和结构。
- 门店场景图：只决定货架、灯光、陈列密度和手机拍摄感。
- 价格牌参考：只决定金属框、橙色上联和黑色下联的物理结构。

不能让门店图里的衣服影响目标商品颜色，也不能让商品图的白底改变门店场景。

## 每张图都必须写入的约束

基础约束集中在 `config/generation-prompt-rules.json`，批量程序自动拼接。商品提示词只写从 Yupoo 能确认的事实，例如：

```text
Show the exact SKU jacket FRONT-FACING on a black hanger.
Preserve the attached hood, center zipper, small left-chest logo,
curved color-block seam, elastic cuffs and straight hem.
```

不要用“高级、好看、时尚”等词代替结构描述。

## 颜色

每个视角明确指定 `color_authority`。提示词必须要求：

- 匹配色相、饱和度和明度。
- 不得荧光化、提亮、加红或加洋红。
- 前排主商品和后排重复陈列必须是同一色号。

初始提示词做颜色锁定，但不能代替生成后的色差检查。

## 正反面

- 正面明确写 `FRONT-FACING`，列出胸前 Logo、拉链和正面拼接。
- 反面明确写 `BACK-FACING`，列出帽子、背部拼接、网眼或反光结构。
- Yupoo 没展示的背面 Logo、通风口、口袋或裁片必须明确写 `do not invent`。

## 价格牌

生成阶段只要求：

```text
Place a real metal-framed sign on the same rack with a completely blank
orange upper panel and blank black lower panel. No letters, numbers,
logos, symbols, or pseudo-text.
```

准确中文和数字由 `finalize-batch` 后写，避免 AI 拼错字或生成黑色伪文字。

## 修复提示词

修复不是重做。先锁定不允许变化的内容，再只说一个错误：

```text
Targeted color correction only. Preserve camera, rack, blank sign,
garment construction, logo, crop and background. Correct only every
garment color to match the Yupoo color-authority references.
```

结构错误与颜色错误尽量拆成不同修复任务，减少连带变化。

