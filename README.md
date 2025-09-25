# Qwen API 转 OpenAI 标准代理

🚀 **单文件 Deno 脚本** | 🔄 **API 格式转换** | 🗄️ **KV 持久化存储** | 🌐 **Web 管理界面**

本项目提供了一个现代化的单文件代理服务器，将标准的 OpenAI API 请求转换为 `chat.qwen.ai` 使用的专有格式。内置 Web 管理界面，支持 Cookie 导入和令牌轮换管理。

## ✨ 功能特性

*   **🔄 OpenAI 兼容性：** 完全兼容 OpenAI API 格式的直接替代品
*   **🗄️ 持久化存储：** 基于 Deno KV 的令牌存储，支持多实例部署
*   **🌐 Web 管理界面：** 友好的 Cookie 导入和令牌状态管理界面
*   **🔐 身份验证保护：** 安全的 Cookie 导入身份验证机制
*   **🎯 智能轮换：** 自动令牌轮换和失效检测机制
*   **📊 状态监控：** 实时的令牌状态和使用情况监控
*   **🖼️ 多模态支持：** 支持文本和图像的混合内容处理
*   **⚡ 零依赖：** 单文件脚本，无需 npm install
*   **🎨 模型变体：** 自动创建特殊模型变体如 `qwen-max-thinking` 和 `qwen-max-search`

## 🚀 部署（Deno Deploy）

1.  **创建 Deno Deploy 项目**：
    *   前往 [Deno Deploy](https://deno.com/deploy) 并创建一个新的 "Playground" 项目。
    *   复制 `main.ts` 的全部内容并粘贴到编辑器中。

2.  **设置环境变量**：
    在您的 Deno Deploy 项目的 "Settings" > "Environment Variables" 部分，添加：
    *   `OPENAI_API_KEY`：（推荐）您自定义的代理访问密钥，用于保护 Cookie 导入功能
    *   示例：`sk-my-secret-key-12345`

3.  **部署完成**：
    脚本将自动部署和运行。访问您的部署 URL 进入 Web 管理界面。

## 💻 本地使用

1.  **保存文件** 为 `main.ts`。

2.  **在终端中设置环境变量**：
    ```bash
    export OPENAI_API_KEY="your_secret_proxy_key"
    ```

3.  **运行脚本**：
    ```bash
    deno run --allow-net --allow-env --unstable-kv main.ts
    ```
    服务器将在 `http://localhost:8000` 启动。

4.  **访问 Web 管理界面**：
    打开浏览器访问 `http://localhost:8000` 进行 Cookie 管理。

## ⚙️ 配置

服务器通过以下环境变量进行配置：

| 变量名             | 描述                                                         | 必需     | 示例                                   |
| ----------------- | ----------------------------------------------------------- | -------- | -------------------------------------- |
| `OPENAI_API_KEY`  | 您自定义的代理访问密钥，用于保护 Cookie 导入功能和 API 调用         | 推荐       | `sk-my-secret-key-12345`              |

> ⚠️ **重要**: `OPENAI_API_KEY` 是您自定义的密钥，**不是** Qwen 的上游密钥！

## 🌐 Web 管理界面

访问服务器根路径进入现代化的 Web 管理界面：

### Cookie 导入流程

1. **获取 Cookie 数据**：
   - 登录 [chat.qwen.ai](https://chat.qwen.ai)
   - 打开浏览器开发者工具 (F12)
   - 转到 Application > Cookies > chat.qwen.ai
   - 复制完整的 Cookie 字符串

2. **导入到系统**：
   - 在 Web 界面的文本框中粘贴 Cookie 字符串
   - 输入您设置的 `OPENAI_API_KEY` 进行身份验证
   - 点击"📤 导入 Cookies"按钮
   - 系统自动提取并保存 `token` 和 `ssxmod_itna` 字段

3. **管理功能**：
   - 📊 **状态监控**: 实时查看所有令牌状态
   - 🔄 **智能轮换**: 系统自动选择最优可用令牌
   - ❌ **失效检测**: 自动标记无效令牌
   - 🗑️ **批量清理**: 一键清理所有失效令牌

### 安全机制

- **Cookie 查看**: 无需身份验证 (GET 请求)
- **Cookie 导入**: 需要 `OPENAI_API_KEY` 身份验证
- **令牌清理**: 无需身份验证 (维护操作)
- **API 调用**: 需要身份验证 (如果配置了密钥)

## 🔌 API 端点

### 用户 API
*   `GET /v1/models` - 获取可用模型列表，包括特殊变体
*   `POST /v1/chat/completions` - 聊天完成端点，支持流式响应

### 管理 API
*   `GET /` - Web 管理界面
*   `GET /cookies` - 查看令牌状态 (无需身份验证)
*   `POST /cookies` - 导入 Cookie (需要身份验证)
*   `DELETE /cookies/invalid` - 清理失效令牌 (无需身份验证)

## 📝 使用示例

### Python 客户端

```python
import openai

client = openai.OpenAI(
    api_key="your_secret_proxy_key",  # 您设置的 OPENAI_API_KEY
    base_url="http://localhost:8000"  # 或您的 Deno Deploy URL
)

response = client.chat.completions.create(
    model="qwen-max",
    messages=[
        {"role": "user", "content": "你好，请介绍一下自己。"}
    ]
)

print(response.choices[0].message.content)
```

### cURL 示例

```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_secret_proxy_key" \
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

```python
response = client.chat.completions.create(
    model="qwen-vl-max",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "这张图片里有什么？"},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
                    }
                }
            ]
        }
    ]
)
```

## 🍪 Cookie 获取指南

### 方式一：通过浏览器开发者工具

1. **登录 Qwen**：
   - 访问 [chat.qwen.ai](https://chat.qwen.ai)
   - 完成登录流程

2. **获取完整 Cookie**：
   - 按 F12 打开开发者工具
   - 转到 "Application" (应用) 标签
   - 在左侧找到 "Cookies" > "https://chat.qwen.ai"
   - 复制整行 Cookie 数据

3. **获取请求头中的令牌**：
   - 转到 "Network" (网络) 标签
   - 发送一条聊天消息
   - 查找对 `chat/completions` 的请求
   - 复制 Request Headers 中的完整 Cookie 字符串

### 方式二：自动化脚本（推荐用于批量管理）

```javascript
// 在 chat.qwen.ai 页面的控制台中运行
const cookies = document.cookie;
console.log('Cookie 字符串:', cookies);

// 也可以获取特定的值
const getCookie = (name) => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
};

console.log('token:', getCookie('token'));
console.log('ssxmod_itna:', getCookie('ssxmod_itna'));
```

### 重要提示

- **令牌有效期**: 令牌会定期过期，建议定期更新
- **多账户支持**: 可以导入多个账户的 Cookie 进行轮换
- **安全存储**: 系统使用 KV 存储确保数据持久化

## 🎯 支持的模型变体

该代理支持以下模型变体（基于上游模型能力自动生成）：

### 基础模型
*   `qwen-max` - 标准聊天模型
*   `qwen-plus` - 轻量级聊天模型  
*   `qwen-turbo` - 快速响应模型

### 特殊变体
*   `qwen-max-thinking` - 启用思考模式的深度推理
*   `qwen-max-search` - 启用实时搜索功能
*   `qwen-vl-max` - 视觉理解模型
*   `qwen-vl-max-image` - 图像生成模式
*   `qwen-vl-max-video` - 视频生成模式

## 🏗️ 架构设计

### 存储架构

```mermaid
graph TD
    A[Web 界面] --> B[Cookie 导入]
    B --> C[KV 存储]
    C --> D[令牌池]
    D --> E[智能轮换]
    E --> F[API 请求]
    F --> G{请求成功?}
    G -->|是| H[更新使用时间]
    G -->|否| I[标记令牌失效]
    I --> D
```

### 核心组件

1. **KvStore 类**: 基于 Deno KV 的持久化存储
   - 支持多实例部署
   - 自动数据恢复
   - 原子性操作

2. **智能轮换系统**: 
   - 优先使用环境变量密钥
   - 基于使用频率的负载均衡
   - 自动失效检测和恢复

3. **Web 管理界面**:
   - 实时状态监控
   - 安全的身份验证
   - 用户友好的操作界面

4. **请求处理流程**:
   - OpenAI 格式验证
   - Qwen 格式转换
   - 流式响应处理
   - 错误恢复机制

## � 故障排除

### 常见问题

**Q: Cookie 导入失败**
```
解决方案:
1. 确认 OPENAI_API_KEY 配置正确
2. 检查 Cookie 格式是否完整
3. 确认浏览器中已成功登录 chat.qwen.ai
4. 尝试重新获取最新的 Cookie
```

**Q: 令牌轮换不工作**
```
解决方案:
1. 检查 KV 存储是否正常初始化
2. 确认至少有一个有效令牌
3. 查看服务器日志了解详细错误
4. 重启服务触发重新初始化
```

**Q: API 请求失败**
```
解决方案:
1. 检查令牌是否过期
2. 确认网络连接正常
3. 验证请求格式是否符合 OpenAI 标准
4. 查看上游 API 返回的错误信息
```

### 日志监控

服务启动时会显示详细状态：

```
⚠️ 未设置 OPENAI_API_KEY。
   建议：通过环境变量设置默认密钥，或使用 /cookies 接口导入密钥。
初始化KV存储...
✅ KV存储初始化成功
🚀 服务器正在监听 http://0.0.0.0:8000
✅ OPENAI_API_KEY 已设置。身份验证已启用。
✅ Cookie API_KEY 存储：已导入 3 个密钥
✅ SSXMOD_ITNA 存储：已导入 2 个令牌
```

## �🛠️ 技术栈

该项目基于现代化技术栈构建：

### 运行时环境
*   **Deno** - 安全的 TypeScript/JavaScript 运行时
*   **Deno KV** - 内置的持久化键值存储 (需要 `--unstable-kv`)

### Web 框架
*   **Oak** - Deno 的现代 HTTP 中间件框架
*   **Server-Sent Events (SSE)** - 实时流式响应处理

### 云服务集成
*   **S3 Lite Client** - 阿里云 OSS 文件上传支持
*   **Deno Deploy** - 边缘计算部署平台

### 核心特性
1. **协议转换**: OpenAI ↔ Qwen API 格式双向转换
2. **多模态处理**: 自动 base64 图像上传和处理
3. **令牌管理**: 智能轮换和失效恢复机制
4. **Web 界面**: 现代化的管理和监控界面
5. **安全认证**: 基于 Bearer Token 的身份验证

### 部署优势
- **零依赖**: 无需 npm install 或 package.json
- **单文件部署**: 便于维护和部署
- **边缘计算**: 支持全球 CDN 部署
- **自动扩展**: 无服务器架构，按需扩展

## 🚨 使用须知

### 重要提醒
*   **合规使用**: 请遵守 Qwen 服务的使用条款和政策
*   **账户安全**: 定期更新 Cookie 和令牌以确保安全性
*   **配额管理**: 确保您的 Qwen 账户有足够的使用配额
*   **数据隐私**: 代理服务器会记录基本请求日志，请注意敏感信息保护

### 生产环境建议
*   设置强密码的 `OPENAI_API_KEY`
*   定期监控令牌状态和使用情况
*   配置多个 Qwen 账户以提高可用性
*   使用 HTTPS 部署以确保传输安全

### 性能优化
*   **令牌预热**: 导入后发送测试请求验证令牌可用性
*   **负载均衡**: 多个令牌自动分担请求负载
*   **缓存机制**: KV 存储减少重复的令牌验证请求
*   **边缘部署**: 使用 Deno Deploy 实现全球就近访问

## 📦 依赖信息

### 运行时要求
- **Deno**: 1.37+ (支持 --unstable-kv 标志)
- **网络权限**: --allow-net (访问上游 API)
- **环境权限**: --allow-env (读取环境变量)

### 外部依赖 (通过 URL 导入)
- **Oak**: v12.6.1 (Web 框架)
- **Deno Standard Library**: v0.177.0+ (工具库)
- **S3 Lite Client**: v0.7.0 (文件上传)

## 🤝 贡献指南

欢迎为项目做出贡献！

### 贡献方式
1. **Bug 报告**: 通过 Issues 报告问题
2. **功能建议**: 提出新功能想法和改进建议
3. **代码贡献**: 提交 Pull Request
4. **文档改进**: 帮助完善使用文档

### 开发流程
1. Fork 项目仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 📜 版本历史

- **v2.3** - 添加 KV 持久化存储和 Web 管理界面
- **v2.2** - 增强多模态支持和令牌轮换机制
- **v2.1** - 添加身份验证和安全功能
- **v2.0** - 重构为基于 Deno 的单文件架构
- **v1.x** - 基础的协议转换功能

## 🔗 相关链接

- **[Deno 官网](https://deno.land/)** - 现代 JavaScript 运行时
- **[Deno Deploy](https://deno.com/deploy)** - 边缘计算部署平台  
- **[Qwen AI](https://chat.qwen.ai/)** - 通义千问聊天服务
- **[OpenAI API](https://platform.openai.com/docs/api-reference)** - API 格式参考

## 📄 许可协议

MIT License - 详见 [LICENSE](LICENSE) 文件

基于原始 [qwenchat2api](https://github.com/highkay/qwenchat2api) 项目开发和改进。

---

**💡 提示**: 本项目仅用于学习测试，请勿用于生产环境。