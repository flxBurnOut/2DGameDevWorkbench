# Windows / macOS 兼容性

本文说明 Windows 与 macOS 的安装、配置、输入和导出行为。跨系统使用时请重新安装依赖并配置凭据。

## 平台行为

| 范围 | 当前行为 |
| --- | --- |
| 图片 API | Windows 使用当前用户 DPAPI；macOS 用钥匙串保管随机加密密钥，本地配置使用 AES-256-GCM。均支持重启恢复；macOS 读取旧本地格式时迁移 |
| 原图、序列帧与视觉服务凭据 | Windows 使用当前用户 DPAPI；macOS 用原生 Keychain 保存凭据，配置文件保存引用，替换/清除后清理旧引用。保存失败保留旧值 |
| 独立 SpritePipeline 数据 | Windows 默认 `%LOCALAPPDATA%/SpritePipeline`；macOS 新安装默认 `~/Library/Application Support/SpritePipeline`，仅旧目录存在时兼容 `~/.local/share/SpritePipeline`。显式目录配置继续有效；工作台两平台均使用 `work/sprite-pipeline` |
| 编辑器键盘 | 先处理明确支持的组合键，再屏蔽单键操作；中文输入法组合输入不触发编辑操作 |
| 字体 | 系统字体、PingFang SC 与 SFMono 回退，保留 Windows 字体 |
| 双平台验证 | 在 Windows/macOS 本机分别运行图片、HTTP、交互物、壳层、凭据、lint、typecheck 和 build（CI 不再运行功能测试） |

macOS 图片配置保存通过 `/usr/bin/security -i` 的标准输入提交短的十六进制加密密钥，API 密钥不进入命令参数；其交互解析方式依据 [Apple SecurityTool 源码](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c)。SpritePipeline 通过系统 Security framework 读取与写入凭据，无额外 Python 包依赖。钥匙串锁定或拒绝访问会报错，不回退到明文。

## 初始化与操作

- 初始化与启动均使用 Node.js 入口；Windows 使用 `.venv/Scripts/python.exe`，macOS 使用 `.venv/bin/python`，不复用跨系统虚拟环境。
- 服务默认绑定回环地址，已健康服务会复用；Windows 的进程树终止命令位于平台分支，macOS 使用信号。
- 导出与源包使用相对路径和 `/` 分隔符，运行时使用 Node/Python 路径 API；未发现主流程硬编码用户的 `C:` 或 `/Users/` 路径。
- 交互物与图片编辑的键盘操作遵循各自编辑器约定；在目标浏览器核对 Cmd/Ctrl、输入法与焦点行为。
- 文件导入导出使用网页文件输入和下载，未依赖 Chromium 专有的目录选择 API。

## 验证方式与边界

图片配置存储保留新进程恢复、密钥不进入 argv、认证密文防篡改和钥匙串失败保护。相关检查随图片设置与平台凭据测试运行；Windows DPAPI 和 macOS Keychain 的实际验证需在对应平台完成。

`npm run test:platform-credentials` 使用当前系统的项目 Python 环境验证旧凭据迁移、重启恢复、替换/清除和失败保留。原生 Keychain 测试在非 macOS 平台明确跳过。这些检查需在各平台本机运行，CI 不再包含桌面矩阵。

Mac 实际操作检查项目：

- 钥匙串首次授权、锁定后重试、关闭工作台再打开后的配置恢复。
- Safari 和 Chrome 的触控板捏合/滚动、空格拖动、Cmd 快捷键与中文输入法组合。
- Retina 缩放下的画布清晰度、字体排版和下载文件名。
- 从正常终端退出开发服务后是否完全释放端口。

跨平台移交应使用项目源代码和导出包，在目标机器重新运行安装命令并配置凭据。不要复制 `.venv`，也不要把操作系统账户绑定的凭据文件当作可移植配置。
