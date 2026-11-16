# PixelProp 像素物品转换器

离线、可复现地将图片转换为 64 或 128 像素物品。仅依赖 Python 3.11+ 与 Pillow 11–12，不依赖工作台、网络、Key 或用户数据目录。

```sh
pip install ./Tools/PixelProp
pixel-prop convert input.png -o prop.png --size 128 --colors 24 --report report.json --compare compare.png
pixel-prop convert input.png -o prop.png --recipe recipe.json
pixel-prop inspect prop.png
```

仓库内执行 `npm run sprite-pipeline:setup` 安装到项目 venv，再用 `npm run pixel-prop -- <参数>`。单独安装 SpritePipeline 时，先安装本地 PixelProp 包；依赖不从公共包仓库下载。

```python
from pixel_prop import Recipe, convert
result = convert(source_bytes, Recipe(size=128, colors=24))
# result.png、result.report、result.compare，均为内存结果
```

输入只接受单帧 PNG/WebP/JPEG，最长边 4096。无透明背景时须指定精确抠色，例如 `--background 'key:#ffffff'`；不提供语义抠图。空图及没有透明背景的输出会被拒绝。

默认配方：

```json
{"size":128,"padding":4,"fit":"contain","anchor":"bottom","resample":"area","alphaThreshold":128,"colors":24,"palette":null,"dither":false,"removeIsolated":true,"outline":"none","background":"alpha"}
```

`size` 为 64/128（工作台固定 128）；`padding` 0–16；`anchor` 为 bottom/center；`resample` 为 area（预乘 Alpha 面积平均）、dominant（对应源区最多的可见 RGBA，固定平局顺序）或 nearest（区域中心）。`alphaThreshold` 1–254；`colors` 为 0（不合并）或 2–64。`palette` 接受 #RRGGBB 列表或 JSON 列表路径；配方文件内路径相对配方目录。工作台另支持 `object:<PixelLab物品ID>`。

默认不抖动；`dither=true` 启用确定性 Floyd–Steinberg。`removeIsolated=true` 移除没有同色四邻的可见像素。`outline` 为 none/dark/#RRGGBB，添加外轮廓，保持内部像素。

处理顺序为可见包围盒裁切、等比放置与缩小、透明二值化、确定性中位切分及 OKLab 映射、清理、轮廓。PNG 固定压缩并去除继承元数据。报告记录源哈希、配方哈希、算法版本、输出哈希、尺寸、颜色数、半透明占比、包围盒与警告；对比图含源图和 4× 最近邻结果。

标准输出 JSON；退出码 0 成功、2 参数/配方错误、3 输入或文件 I/O 错误。帮助与 argparse 错误仍使用常规帮助/stderr。

`python -m pytest Tools/PixelProp/tests` 验证公开几何样例、确定性与边界。升级 Pillow 时先检查黄金样例；改变算法需增加版本。转换不能证明像素画质量或 PixelLab 动画效果，采用前请核对视角、初始状态、小部件、细线与透明背景。
