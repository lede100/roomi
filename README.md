# Roomi

> **一个极简轻盈的 AI 伴侣空间：左屏日常对话，右屏是 TA 为你现场编写的可交互小组件看板。**

- **现做小组件**：在聊天里说一句「帮我做个早睡打卡卡 / 吃什么转盘 / 旅行倒计时 / 心情玻璃罐」，AI 会实时编写独立 HTML 小组件并挂载到右侧「小窝看板」。
- **双向感应**：组件运行在禁用了 `allow-same-origin` 且开启 CSP 断网隔离的沙盒 `iframe` 中，通过 `CompanionBridge` 持久化状态，并在你操作组件时向伴侣回传实时动态。
- **双极简主题**：内置 **白蓝极简（DeepSeek 风）** 与 **暖纸极简（Claude 风）**，顶栏一键切换。
- **BYOK 与零配置演示**：内置离线演示引擎打开即玩；填写任意 OpenAI 兼容 `Base URL` + `API Key` 后自动拉取 `/models` 可用列表，支持 SSE 流式输出与 IndexedDB 异步持久化。
- **免本地环境自动构建 APK**：集成 Capacitor 7 与 GitHub Actions（已开启 `CapacitorHttp` 绕过原生请求 CORS，并配置软键盘 `adjustResize`）。

## 云端自动打包 Android APK

1. Fork 或推送本仓库到你的 GitHub `main` 分支。
2. 打开仓库顶部的 **Actions** → **Build Roomi Android APK**。
3. 构建完成后在页面底部的 **Artifacts** 下载 `roomi-debug-apk` 解压安装即可。
