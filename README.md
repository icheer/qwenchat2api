# Qwen API 转 OpenAI 标准代理

本项目提供了一个轻量级的单文件代理服务器，设计为运行在 Deno 上。它将标准的 OpenAI API 请求转换为 `chat.qwen.ai` 使用的专有格式，并将响应转换回标准的 OpenAI 格式。

这使得您可以使用 OpenAI 兼容的客户端与 Qwen（通义千问）聊天服务进行交互。

## ✨ 功能特性

*   **OpenAI 兼容性：** 作为 OpenAI API 基础 URL 的直接替代品。
*   **请求转换：** 将 OpenAI 聊天完成请求转换为 Qwen 格式。
*   **流式转换：** 实时将 Qwen 的服务器发送事件（SSE）流转换为 OpenAI 格式。
*   **模型变体：** 基于上游模型能力自动创建特殊模型变体，如 `qwen-max-thinking` 和 `qwen-max-search`。
*   **令牌轮换：** 支持多个上游 `API_KEY` 并在每个请求中轮换使用。
*   **身份验证：** 使用 `OPENAI_API_KEY` 保护您的代理端点。
*   **零依赖（Deno）：** 作为单个脚本在 Deno Deploy 或本地运行，无需 `npm install`。
*   **多模态支持：** 支持图像上传和处理，自动将 base64 图像上传到 Qwen 的 OSS 存储。

## 🚀 部署（Deno Deploy）

1.  **创建 Deno Deploy 项目**：
    *   前往 [Deno Deploy](https://deno.com/deploy) 并创建一个新的 "Playground" 项目。
    *   复制 `main.ts` 的全部内容并粘贴到编辑器中。

2.  **设置环境变量**：
    在您的 Deno Deploy 项目的 "Settings" > "Environment Variables" 部分，添加以下变量：

    *   `OPENAI_API_KEY`：（推荐）客户端访问此代理的密钥。（例如：`sk-my-secret-key-12345`）
    *   `API_KEY`：您的 Qwen 账户令牌。可以提供多个令牌，用逗号分隔进行轮换。（例如：`ey...abc,ey...def`）
    *   `SSXMOD_ITNA`：上游 API 所需的特殊 cookie 值。

3.  **运行**：
    脚本将自动部署和运行。Deno Deploy 会提供您的端点 URL。

## 💻 本地使用

1.  **保存文件** 为 `main.ts`。

2.  **在终端中设置环境变量**：
    ```sh
    export OPENAI_API_KEY="your_secret_proxy_key"
    export API_KEY="your_qwen_token"
    export SSXMOD_ITNA="your_cookie_value"
    ```

3.  **运行脚本**：
    ```sh
    deno run --allow-net --allow-env main.ts
    ```
    服务器将在 `http://localhost:8000` 启动。

## ⚙️ 配置

服务器通过以下环境变量进行配置：

| 变量名             | 描述                                                         | 必需     | 示例                                   |
| ----------------- | ----------------------------------------------------------- | -------- | -------------------------------------- |
| `OPENAI_API_KEY`  | 保护代理端点的密钥 Bearer 令牌。如果未设置，代理将对公众开放。        | 否       | `sk-my-secret-key-12345`              |
| `API_KEY`         | 您的 Qwen 账户令牌用于上游 API。多个密钥用逗号分隔以实现轮换。        | 是       | `ey...abc,ey...def`                   |
| `SSXMOD_ITNA`     | `chat.qwen.ai` 所需的 `ssxmod_itna` cookie 值。               | 是       | `mqUxRDBD...DYAEDBYD74G+DDeDixGm...` |

## 🔌 API 端点

*   `GET /v1/models`
    *   检索可用 Qwen 模型列表，包括特殊变体如 `-thinking`、`-search` 和 `-image`。
*   `POST /v1/chat/completions`
    *   聊天的主要端点。接受标准的 OpenAI 聊天完成请求并支持流式响应。

## 📝 使用示例

一旦部署完成，您可以像使用 OpenAI API 一样使用该代理：

```bash
curl -X POST http://your-deno-deploy-url/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-openai-api-key" \
  -d '{
    "model": "qwen-max",
    "messages": [
      {
        "role": "user",
        "content": "你好，请介绍一下自己。"
      }
    ],
    "stream": true
  }'
```

### 多模态示例（图像处理）

```bash
curl -X POST http://your-deno-deploy-url/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-openai-api-key" \
  -d '{
    "model": "qwen-vl-max",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "这张图片里有什么？"
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
            }
          }
        ]
      }
    ]
  }'
```

## 🔑 如何获取必要的令牌

### 获取 API_KEY（Qwen 令牌）

1. 访问 [chat.qwen.ai](https://chat.qwen.ai)
2. 登录您的账户
3. 打开浏览器开发者工具（F12）
4. 转到 Network（网络）标签
5. 发送一条消息
6. 在网络请求中查找 `Authorization` 头部，复制 `Bearer` 后面的令牌

### 获取 SSXMOD_ITNA（Cookie 值）

1. 在同一个浏览器会话中
2. 转到 Application（应用）标签
3. 在 Cookies 部分找到 `chat.qwen.ai`
4. 复制 `ssxmod_itna` 的值

## 🎯 支持的模型变体

该代理支持以下模型变体：

*   `qwen-max` - 标准模型
*   `qwen-max-thinking` - 启用思考模式
*   `qwen-max-search` - 启用搜索功能
*   `qwen-vl-max-image` - 图像生成模式
*   `qwen-vl-max-video` - 视频生成模式

## 🛠️ 技术实现

该项目基于以下技术：

*   **Deno** - 现代化的 JavaScript/TypeScript 运行时
*   **Oak** - Deno 的 HTTP 中间件框架
*   **S3 Lite Client** - 用于文件上传到阿里云 OSS
*   **Server-Sent Events (SSE)** - 实时流式响应

### 核心功能

1. **请求转换**：将 OpenAI 格式的请求转换为 Qwen API 格式
2. **响应转换**：将 Qwen 的 SSE 流转换回 OpenAI 格式
3. **图像处理**：自动上传 base64 图像到 Qwen 的 OSS 存储
4. **令牌管理**：支持多个 API 密钥的轮换使用
5. **错误处理**：完整的错误处理和重试机制

## 🚨 注意事项

*   确保您的 Qwen 账户有足够的配额
*   `SSXMOD_ITNA` cookie 可能会定期过期，需要更新
*   建议设置多个 `API_KEY` 以提高可用性
*   代理服务器会记录请求日志，请注意隐私

## 📄 许可证

本项目基于原始 [qwenchat2api](https://github.com/highkay/qwenchat2api) 项目开发。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

**免责声明**：本项目仅供学习和研究用途。请遵守相关服务的使用条款。
