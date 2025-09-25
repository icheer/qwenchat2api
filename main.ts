/**
 * Qwen API 转 OpenAI 标准代理 - 单文件 Deno Deploy/Playground 脚本
 *
 * @version 2.3
 * @description 本脚本作为代理服务器，将标准的 OpenAI API 请求转换为 `chat.qwen.ai`
 * 使用的专有格式，并将响应转换回标准的 OpenAI 格式。它集成了原始 Qwen2API Node.js
 * 仓库中的特定逻辑。
 *
 *
 * --- 部署说明 ---
 *
 * 1. **Deno Deploy / Playground 设置**：
 *    - 在 Deno Deploy 中创建新项目。
 *    - 复制并粘贴整个脚本到编辑器中。
 *
 * 2. **设置环境变量**：
 *    在您的 Deno Deploy 项目设置中，添加以下环境变量：
 *
 *    - `OPENAI_API_KEY`: （推荐）客户端访问此代理的密钥。
 *                        如果未设置，代理将对公众开放。
 *                        示例：`sk-my-secret-key-12345`
 *
 *    - `API_KEY`: 您的 Qwen 账户令牌，用于上游 API。可以提供多个令牌，
 *                 用逗号分隔。脚本会在它们之间轮换。
 *                 这是**必需**的变量。
 *                 示例：`ey...abc,ey...def`
 *
 *    - `SSXMOD_ITNA`: 上游 API 所需的特殊 cookie 值。
 *                     某些模型或功能可能需要此值。
 *                     示例：`mqUxRDBD...DYAEDBYD74G+DDeDixGm...`
 *
 * 3. **运行**：
 *    脚本将在部署后自动运行。
 *
 * --- 本地使用 ---
 *
 * 1. 将此文件保存为 `main.ts`。
 * 2. 在终端中设置环境变量：
 *    export OPENAI_API_KEY="your_secret_proxy_key"
 *    export API_KEY="your_qwen_token"
 *    export SSXMOD_ITNA="your_cookie_value"
 * 3. 运行脚本：
 *    deno run --allow-net --allow-env main.ts
 *
 * --- 关于 DENO ---
 * Deno 是现代化且安全的 JavaScript 和 TypeScript 运行时。
 * - 内置 TypeScript 支持，无需单独编译步骤。
 * - 对文件、网络和环境访问使用显式权限。
 * - 拥有标准库和使用 URL 的去中心化包管理系统。
 * 本脚本设计为可在 Deno 的无服务器平台 Deno Deploy 上轻松部署。
 */

// 导入 Oak Web 框架的核心组件
// Oak 是 Deno 的 HTTP 中间件框架，类似于 Node.js 的 Express
import {
  Application,
  Router,
  Context,
  Middleware
} from 'https://deno.land/x/oak@v12.6.1/mod.ts';
// 导入缓冲区相关工具（当前未使用，保留以备将来使用）
import { Buffer } from 'https://deno.land/std@0.177.0/io/buffer.ts';
// 导入轻量级 S3 客户端，用于阿里云 OSS 文件上传
import { S3Client } from 'https://deno.land/x/s3_lite_client@0.7.0/mod.ts';
// 导入 base64 解码工具，用于处理图片数据
import { decode } from 'https://deno.land/std@0.208.0/encoding/base64.ts';

// --- 1.5. Qwen OSS 上传逻辑 ---

// OSS 文件上传配置常量
const UPLOAD_CONFIG = {
  stsTokenUrl: 'https://chat.qwen.ai/api/v1/files/getstsToken', // STS 令牌获取 API 地址
  maxRetries: 3, // 最大重试次数
  timeout: 30000 // 超时时间（毫秒）
};

/**
 * 从 Qwen API 请求临时 STS 令牌用于文件上传
 * 模拟原始 `upload.js` 中 `requestStsToken` 的逻辑
 *
 * STS（Security Token Service）是阿里云提供的临时访问凭证服务
 * 允许应用程序获得临时的访问密钥来操作 OSS 存储桶
 *
 * @param filename 文件名
 * @param filesize 文件大小（字节）
 * @param filetype 文件类型（'image' 或 'file'）
 * @param authToken Qwen 认证令牌
 * @param retryCount 当前重试次数（用于递归重试）
 * @returns 包含 STS 凭证和 OSS 信息的对象
 */
async function requestStsToken(
  filename: string,
  filesize: number,
  filetype: string,
  authToken: string,
  retryCount = 0
): Promise<any> {
  // 确保 Bearer 前缀存在
  const bearerToken = authToken.startsWith('Bearer ')
    ? authToken
    : `Bearer ${authToken}`;
  // 构建请求载荷
  const payload = { filename, filesize, filetype };

  try {
    // 向 Qwen API 请求 STS 令牌
    const response = await fetch(UPLOAD_CONFIG.stsTokenUrl, {
      method: 'POST',
      headers: {
        Authorization: bearerToken,
        'Content-Type': 'application/json',
        'x-request-id': crypto.randomUUID(), // 生成唯一请求 ID
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' // 模拟浏览器
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const stsData = await response.json();
      // 基本验证：检查必要的字段是否存在
      if (stsData.access_key_id && stsData.file_url && stsData.bucketname) {
        return stsData;
      }
      throw new Error('收到不完整的 STS 令牌响应。');
    }

    throw new Error(
      `获取 STS 令牌失败：${response.status} ${response.statusText}`
    );
  } catch (error) {
    // 指数退避重试逻辑
    if (retryCount < UPLOAD_CONFIG.maxRetries) {
      console.warn(
        `STS 令牌请求失败，正在重试 (${retryCount + 1}/${
          UPLOAD_CONFIG.maxRetries
        })...`,
        (error as Error).message
      );
      // 等待时间随重试次数指数增长
      await new Promise(res => setTimeout(res, 1000 * Math.pow(2, retryCount)));
      return requestStsToken(
        filename,
        filesize,
        filetype,
        authToken,
        retryCount + 1
      );
    }
    console.error('多次重试后仍无法获取 STS 令牌。', error);
    throw error;
  }
}

/**
 * 使用 STS 凭证将文件上传到 Qwen 的阿里云 OSS
 *
 * 工作流程：
 * 1. 根据文件扩展名确定 MIME 类型
 * 2. 请求 STS 临时凭证
 * 3. 使用 STS 凭证配置 S3 客户端
 * 4. 上传文件到 OSS
 * 5. 返回文件 URL 和 ID
 *
 * @param fileBuffer 文件内容的字节数组
 * @param originalFilename 原始文件名
 * @param qwenAuthToken Qwen 认证令牌
 * @returns 包含上传文件 URL 和 ID 的对象
 */
async function uploadFileToQwenOss(
  fileBuffer: Uint8Array,
  originalFilename: string,
  qwenAuthToken: string
): Promise<{ file_url: string; file_id: string }> {
  const filesize = fileBuffer.length;
  // 根据文件扩展名确定 MIME 类型
  const mimeType = originalFilename.endsWith('.png')
    ? 'image/png'
    : originalFilename.endsWith('.jpg') || originalFilename.endsWith('.jpeg')
    ? 'image/jpeg'
    : 'application/octet-stream'; // 默认二进制类型
  // 简化的文件类型分类，用于 STS 请求
  const filetypeSimple = mimeType.startsWith('image/') ? 'image' : 'file';

  // 1. 获取 STS 临时凭证
  const stsData = await requestStsToken(
    originalFilename,
    filesize,
    filetypeSimple,
    qwenAuthToken
  );

  // 2. 从 STS 响应中提取凭证信息
  const stsCredentials = {
    accessKeyID: stsData.access_key_id, // 访问密钥 ID
    secretKey: stsData.access_key_secret, // 访问密钥
    sessionToken: stsData.security_token // 会话令牌
  };
  // 3. 从 STS 响应中提取 OSS 信息
  const ossInfo = {
    bucket: stsData.bucketname, // OSS 存储桶名称
    endpoint: stsData.region + '.aliyuncs.com', // OSS 端点
    path: stsData.file_path, // 文件在 OSS 中的路径
    region: stsData.region // 阿里云区域
  };

  // 4. 使用 S3 兼容客户端上传到 OSS
  // 阿里云 OSS 兼容 S3 API，因此可以使用 S3 客户端
  const s3Client = new S3Client({
    accessKeyID: stsCredentials.accessKeyID,
    secretKey: stsCredentials.secretKey,
    sessionToken: stsCredentials.sessionToken,
    bucket: ossInfo.bucket,
    region: ossInfo.region,
    endpointURL: `https://${ossInfo.endpoint}`
  });

  // 5. 执行文件上传
  await s3Client.putObject(ossInfo.path, fileBuffer, {
    contentType: mimeType
  });

  // 6. 返回上传结果
  return {
    file_url: stsData.file_url, // 可访问的文件 URL
    file_id: stsData.file_id // Qwen 系统中的文件 ID
  };
}

// --- 1. 从环境变量读取配置 ---

// 应用程序配置对象，包含所有必要的环境变量
const config = {
  // OpenAI API 密钥，用于保护代理端点（可选）
  openaiApiKey: Deno.env.get('OPENAI_API_KEY') || '',
  // Qwen API 密钥数组，支持多个密钥轮换使用（必需）
  apiKeys: (Deno.env.get('API_KEY') || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean),
  // Qwen 特殊 cookie 值，某些功能可能需要（可选）
  ssxmodItna: Deno.env.get('SSXMOD_ITNA') || ''
};

// 检查必需的 API_KEY 环境变量是否设置
if (config.apiKeys.length === 0) {
  console.error(
    '致命错误：API_KEY 环境变量未设置或为空。这是访问上游 Qwen API 所必需的。'
  );
  Deno.exit(1);
}

// 如果未设置 OPENAI_API_KEY，发出警告（代理将对公众开放）
if (!config.openaiApiKey) {
  console.warn('警告：OPENAI_API_KEY 未设置。代理将对公众开放。');
}

// --- 内存存储管理器 ---

// 全局内存存储对象
const cookieStore = {
    apiKeys: [],        // API_KEY (token字段) 数组
    ssxmodItnaTokens: [] // SSXMOD_ITNA 数组
};

/**
 * 生成唯一标识符
 * @returns 唯一ID字符串
 */
function generateId(): string {
    return crypto.randomUUID();
}

/**
 * 掩码显示令牌值（保留前后4位字符）
 * @param value 完整的令牌值
 * @returns 掩码后的显示字符串
 */
function maskTokenValue(value: string): string {
    if (value.length <= 8) {
        return value; // 太短的值不掩码
    }
    const start = value.substring(0, 4);
    const end = value.substring(value.length - 4);
    const maskLength = Math.min(value.length - 8, 20); // 限制掩码长度
    const mask = '*'.repeat(maskLength);
    return `${start}${mask}${end}`;
}

/**
 * 添加 API_KEY 到存储中（自动去重）
 * @param value API_KEY 值
 */
function addApiKey(value: string): void {
    // 检查是否已存在
    const exists = cookieStore.apiKeys.find(item => item.value === value);
    if (exists) {
        console.log('API_KEY 已存在，跳过添加');
        return;
    }

    // 添加新的 API_KEY
    const newToken = {
        id: generateId(),
        value: value,
        isValid: true, // 新导入默认为 true
        createdAt: Date.now(),
        lastUsed: undefined,
        errorCount: 0
    };
    
    cookieStore.apiKeys.push(newToken);
    console.log(`已添加新的 API_KEY: ${maskTokenValue(value)}`);
}

/**
 * 添加 SSXMOD_ITNA 到存储中（自动去重）
 * @param value SSXMOD_ITNA 值
 */
function addSsxmodItna(value: string): void {
    // 检查是否已存在
    const exists = cookieStore.ssxmodItnaTokens.find(item => item.value === value);
    if (exists) {
        console.log('SSXMOD_ITNA 已存在，跳过添加');
        return;
    }

    // 添加新的 SSXMOD_ITNA
    const newToken = {
        id: generateId(),
        value: value,
        isValid: true, // 新导入默认为 true
        createdAt: Date.now(),
        lastUsed: undefined,
        errorCount: 0
    };
    
    cookieStore.ssxmodItnaTokens.push(newToken);
    console.log(`已添加新的 SSXMOD_ITNA: ${maskTokenValue(value)}`);
}

/**
 * 轮换获取可用的 API_KEY（跳过 isValid=false 的项目）
 * @returns 可用的 API_KEY 值或 null
 */
function getValidApiKey(): string | null {
    const validTokens = cookieStore.apiKeys.filter(token => token.isValid);
    
    if (validTokens.length === 0) {
        return null;
    }

    // 简单轮换：按最少使用优先
    validTokens.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    const selectedToken = validTokens[0];
    
    // 更新使用时间
    selectedToken.lastUsed = Date.now();
    
    return selectedToken.value;
}

/**
 * 获取可用的 SSXMOD_ITNA 值
 * @returns 可用的 SSXMOD_ITNA 值或 null
 */
function getValidSsxmodItna(): string | null {
    const validTokens = cookieStore.ssxmodItnaTokens.filter(token => token.isValid);
    
    if (validTokens.length === 0) {
        return null;
    }

    // 简单选择第一个可用的
    const selectedToken = validTokens[0];
    selectedToken.lastUsed = Date.now();
    
    return selectedToken.value;
}

/**
 * 标记令牌为无效（4xx错误时调用）
 * @param type 令牌类型：'apiKey' 或 'ssxmod'
 * @param value 令牌值
 */
function markAsInvalid(type: string, value: string): void {
    let tokenArray;
    if (type === 'apiKey') {
        tokenArray = cookieStore.apiKeys;
    } else if (type === 'ssxmod') {
        tokenArray = cookieStore.ssxmodItnaTokens;
    } else {
        console.error(`无效的令牌类型: ${type}`);
        return;
    }

    const token = tokenArray.find(item => item.value === value);
    if (token) {
        token.isValid = false;
        token.errorCount = (token.errorCount || 0) + 1;
        console.log(`已标记 ${type} 为无效: ${maskTokenValue(value)}`);
    }
}

/**
 * 删除失效的令牌（仅限 isValid=false）
 * @param type 令牌类型：'apiKey' 或 'ssxmod'
 * @param maskedValue 掩码后的令牌值
 * @returns 是否成功删除
 */
function deleteInvalidToken(type: string, maskedValue: string): boolean {
    let tokenArray;
    if (type === 'apiKey') {
        tokenArray = cookieStore.apiKeys;
    } else if (type === 'ssxmod') {
        tokenArray = cookieStore.ssxmodItnaTokens;
    } else {
        return false;
    }

    // 通过掩码值查找对应的无效令牌
    const tokenIndex = tokenArray.findIndex(item => 
        !item.isValid && maskTokenValue(item.value) === maskedValue
    );

    if (tokenIndex === -1) {
        return false; // 未找到匹配的无效令牌
    }

    // 删除令牌
    const deletedToken = tokenArray.splice(tokenIndex, 1)[0];
    console.log(`已删除失效的 ${type}: ${maskTokenValue(deletedToken.value)}`);
    return true;
}

/**
 * 获取用于显示的令牌列表（掩码处理）
 * @returns 包含掩码后令牌信息的显示列表
 */
function getDisplayList(): any {
    const apiKeysList = cookieStore.apiKeys.map(token => ({
        id: token.id,
        maskedValue: maskTokenValue(token.value),
        isValid: token.isValid,
        createdAt: new Date(token.createdAt).toLocaleString('zh-CN'),
        lastUsed: token.lastUsed ? new Date(token.lastUsed).toLocaleString('zh-CN') : '未使用',
        errorCount: token.errorCount || 0
    }));

    const ssxmodList = cookieStore.ssxmodItnaTokens.map(token => ({
        id: token.id,
        maskedValue: maskTokenValue(token.value),
        isValid: token.isValid,
        createdAt: new Date(token.createdAt).toLocaleString('zh-CN'),
        lastUsed: token.lastUsed ? new Date(token.lastUsed).toLocaleString('zh-CN') : '未使用',
        errorCount: token.errorCount || 0
    }));

    return {
        apiKeys: apiKeysList,
        ssxmod: ssxmodList
    };
}

// 简单的令牌轮换器，用于上游 API 密钥轮换
let tokenIndex = 0;
/**
 * 获取下一个可用的上游 API 令牌
 * 实现轮换逻辑以分散请求负载
 * @returns 当前轮换到的 API 令牌
 */
function getUpstreamToken(): string {
  if (config.apiKeys.length === 0) return '';
  const token = config.apiKeys[tokenIndex];
  tokenIndex = (tokenIndex + 1) % config.apiKeys.length;
  return token;
}

// --- 2. 核心转换逻辑（基于原始 Node.js 项目分析） ---

/**
 * 异步处理 OpenAI 消息以处理 Qwen 的多模态内容
 *
 * 此函数的主要职责：
 * 1. 检测 OpenAI 格式消息中的 base64 图像
 * 2. 将 base64 图像上传到 Qwen 的 OSS 存储
 * 3. 将上传后的图像 URL 转换为 Qwen 期望的格式
 * 4. 处理文本和图像的混合内容
 *
 * @param messages 来自 OpenAI 请求的消息数组
 * @param qwenAuthToken 与 Qwen 上传 API 认证所需的令牌
 * @returns 格式化为 Qwen 格式的新消息数组的 Promise
 */
async function processMessagesForQwen(
  messages: any[],
  qwenAuthToken: string
): Promise<any[]> {
  // 基本输入验证
  if (!messages || !Array.isArray(messages)) {
    return [];
  }

  const processedMessages = [];
  // 遍历每条消息进行处理
  for (const message of messages) {
    // 只处理用户消息且内容为数组格式的情况（多模态消息）
    if (message.role === 'user' && Array.isArray(message.content)) {
      const newContent = [];
      let hasImage = false; // 标记是否包含图像

      // 处理消息内容的每个部分
      for (const part of message.content) {
        // 处理 base64 图像数据
        if (
          part.type === 'image_url' &&
          part.image_url?.url?.startsWith('data:')
        ) {
          hasImage = true;
          const base64Data = part.image_url.url;
          // 解析 base64 数据格式：data:image/jpeg;base64,/9j/4AAQ...
          const match = base64Data.match(/^data:(image\/\w+);base64,(.*)$/);
          if (!match) {
            console.warn('跳过无效的 base64 图像数据。');
            newContent.push({ type: 'text', text: '[无效的图像数据]' });
            continue;
          }

          // 提取 MIME 类型和 base64 数据
          const [, mimeType, base64] = match;
          const fileExtension = mimeType.split('/')[1] || 'png'; // 默认为 PNG
          const filename = `${crypto.randomUUID()}.${fileExtension}`; // 生成唯一文件名
          const buffer = decode(base64); // 解码 base64 为字节数组

          try {
            // 上传图像到 Qwen OSS
            const uploadResult = await uploadFileToQwenOss(
              buffer,
              filename,
              qwenAuthToken
            );
            // 转换为 Qwen 期望的图像格式
            newContent.push({ type: 'image', image: uploadResult.file_url });
          } catch (e) {
            console.error('上传图像到 Qwen OSS 失败：', e);
            newContent.push({
              type: 'text',
              text: `[图像上传失败: ${(e as Error).message}]`
            });
          }
        } else if (part.type === 'image_url') {
          // 处理普通的图像 URL，转换为 Markdown 格式作为备用方案
          newContent.push({
            type: 'text',
            text: `![]( ${part.image_url.url} )`
          });
        } else {
          // 保持其他内容不变
          newContent.push(part);
        }
      }

      // 根据是否包含图像决定最终格式
      // Qwen API 期望：包含图像时内容为数组，纯文本时为字符串
      if (hasImage) {
        // 扁平化文本部分，将连续的文本合并为单个文本项
        const flattenedContent = [];
        let textParts = [];
        for (const item of newContent) {
          if (item.type === 'text') {
            textParts.push(item.text);
          } else {
            // 遇到非文本项时，先处理累积的文本
            if (textParts.length > 0) {
              flattenedContent.push({
                type: 'text',
                text: textParts.join('\n')
              });
              textParts = [];
            }
            flattenedContent.push(item);
          }
        }
        // 处理最后的文本部分
        if (textParts.length > 0) {
          flattenedContent.push({ type: 'text', text: textParts.join('\n') });
        }
        processedMessages.push({ ...message, content: flattenedContent });
      } else {
        // 无图像，将所有文本部分合并为单个字符串
        const combinedText = message.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('\n');
        processedMessages.push({ ...message, content: combinedText });
      }
    } else {
      // 非多模态消息，保持原样
      processedMessages.push(message);
    }
  }
  return processedMessages;
}

/**
 * 将 OpenAI 格式的请求体转换为 Qwen 专有格式
 *
 * 此函数模拟 `chat-middleware.js` 中 `processRequestBody` 的逻辑
 * 主要转换内容：
 * 1. 模型名称处理：移除特殊后缀，确定聊天类型
 * 2. 添加 Qwen 特有的字段：session_id, chat_id, feature_config 等
 * 3. 根据模型后缀设置不同的聊天类型和功能
 *
 * @param openAIRequest 传入的 OpenAI 格式请求体
 * @returns 转换后的 Qwen API 请求体
 */
function transformOpenAIRequestToQwen(openAIRequest: any): any {
  const model = openAIRequest.model || 'qwen-max';

  // 根据模型后缀确定聊天类型
  let chat_type = 't2t'; // 默认：文本到文本
  if (model.includes('-search')) chat_type = 'search'; // 搜索模式
  if (model.includes('-image')) chat_type = 't2i'; // 文本到图像
  if (model.includes('-video')) chat_type = 't2v'; // 文本到视频

  // 清理模型名称，移除特殊后缀
  const qwenModel = model.replace(/-search|-thinking|-image|-video/g, '');

  // 构建 Qwen API 格式的请求体
  const qwenBody = {
    model: qwenModel, // 清理后的模型名
    messages: openAIRequest.messages, // 消息已经预处理过
    stream: true, // 启用流式响应
    incremental_output: true, // 启用增量输出
    chat_type: chat_type, // 聊天类型
    session_id: crypto.randomUUID(), // 生成唯一会话 ID
    chat_id: crypto.randomUUID(), // 生成唯一聊天 ID
    feature_config: {
      // 功能配置
      output_schema: 'phase', // 输出架构类型
      thinking_enabled: model.includes('-thinking') // 是否启用思考模式
    }
  };

  return qwenBody;
}

/**
 * 创建转换流，将 Qwen SSE 响应流转换为 OpenAI 兼容的 SSE 流
 *
 * 此函数模拟 `chat.js` 中 `handleStreamResponse` 的逻辑
 *
 * 转换过程：
 * 1. 解析 Qwen 的 SSE 数据格式
 * 2. 处理特殊的 <think> 标签（思考模式）
 * 3. 转换为 OpenAI 标准的 chunk 格式
 * 4. 保持流的实时性和完整性
 *
 * @returns TransformStream，用于处理从 Qwen 到 OpenAI 格式的流转换
 */
function createQwenToOpenAIStreamTransformer(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const decoder = new TextDecoder(); // 解码器，将字节转换为文本
  const encoder = new TextEncoder(); // 编码器，将文本转换为字节
  let buffer = ''; // 缓冲区，存储不完整的数据行
  const messageId = crypto.randomUUID(); // 生成唯一的消息 ID

  return new TransformStream({
    // 转换函数：处理每个数据块
    transform(chunk, controller) {
      // 将新的数据块添加到缓冲区
      buffer += decoder.decode(chunk, { stream: true });

      // 按 SSE 格式分割行（双换行符分隔）
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || ''; // 保留最后一个不完整的行

      // 处理每一行数据
      for (const line of lines) {
        if (!line.startsWith('data:')) continue; // 跳过非数据行

        try {
          // 解析 Qwen 的 JSON 数据（移除 'data:' 前缀）
          const qwenChunk = JSON.parse(line.substring(5));
          if (!qwenChunk.choices || qwenChunk.choices.length === 0) continue;

          const delta = qwenChunk.choices[0].delta;
          if (!delta) continue;

          let content = delta.content || '';

          // 处理特殊的 <think> 标签（思考模式功能）
          if (delta.phase === 'think' && !buffer.includes('<think>')) {
            content = `<think>\n${content}`;
          }
          if (
            delta.phase === 'answer' &&
            buffer.includes('<think>') &&
            !buffer.includes('</think>')
          ) {
            content = `\n</think>\n${content}`;
          }

          // 构建 OpenAI 标准格式的数据块
          const openAIChunk = {
            id: `chatcmpl-${messageId}`, // OpenAI 格式的 ID
            object: 'chat.completion.chunk', // 对象类型
            created: Math.floor(Date.now() / 1000), // Unix 时间戳
            model: qwenChunk.model || 'qwen', // 模型名称
            choices: [
              {
                index: 0, // 选择索引
                delta: { content: content }, // 内容增量
                finish_reason: qwenChunk.choices[0].finish_reason || null // 结束原因
              }
            ]
          };

          // 发送转换后的数据块
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`)
          );
        } catch (e) {
          console.error('解析 Qwen 流数据块时出错：', e);
        }
      }
    },
    // 刷新函数：处理流结束
    flush(controller) {
      // 发送最终的完成标记
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
    }
  });
}

// --- 路由处理函数 ---

/**
 * 处理获取模型列表的逻辑
 * 从 Qwen API 获取模型列表并添加特殊变体
 *
 * 功能：
 * 1. 从上游 Qwen API 获取原始模型列表
 * 2. 基于模型能力自动生成特殊变体（如 -thinking、-search、-image）
 * 3. 返回 OpenAI 兼容的模型列表格式
 *
 * @returns 包含模型列表或错误信息的响应对象
 */
async function handleGetModels() {
  // 获取轮换的上游令牌
  const token = getUpstreamToken();
  if (!token) {
    return {
      status: 503,
      body: { error: '上游令牌未配置。' }
    };
  }

  try {
    // 从 Qwen API 获取模型列表
    const response = await fetch('https://chat.qwen.ai/api/models', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`获取模型失败：${response.statusText}`);
    }

    const originalModels = (await response.json()).data;
    const processedModels: any[] = [];

    // 处理每个原始模型，添加特殊变体
    for (const model of originalModels) {
      processedModels.push(model); // 添加原始模型

      // 基于原始项目逻辑添加特殊变体
      if (model?.info?.meta?.abilities?.thinking) {
        // 如果模型支持思考功能，添加 -thinking 变体
        processedModels.push({ ...model, id: `${model.id}-thinking` });
      }
      if (model?.info?.meta?.chat_type?.includes('search')) {
        // 如果模型支持搜索功能，添加 -search 变体
        processedModels.push({ ...model, id: `${model.id}-search` });
      }
      if (model?.info?.meta?.chat_type?.includes('t2i')) {
        // 如果模型支持文本到图像功能，添加 -image 变体
        processedModels.push({ ...model, id: `${model.id}-image` });
      }
    }

    // 返回 OpenAI 兼容格式的模型列表
    return {
      status: 200,
      body: { object: 'list', data: processedModels }
    };
  } catch (err) {
    console.error('获取模型时出错：', (err as Error).message);
    return {
      status: 502,
      body: { error: '从上游 API 获取模型失败。' }
    };
  }
}

/**
 * 处理聊天完成请求的逻辑
 *
 * 工作流程：
 * 1. 验证上游令牌可用性
 * 2. 解析 OpenAI 格式的请求
 * 3. 异步处理消息中的图像上传
 * 4. 将请求转换为 Qwen 格式
 * 5. 转发请求到 Qwen API
 * 6. 转换响应流为 OpenAI 格式
 * 7. 返回流式响应给客户端
 *
 * @param requestBody OpenAI 格式的请求体
 * @returns 包含流式响应或错误信息的响应对象
 */
async function handleChatCompletions(requestBody: any) {
  // 获取轮换的上游令牌
  const token = getUpstreamToken();
  if (!token) {
    return {
      status: 503,
      body: { error: '上游令牌未配置。' }
    };
  }

  try {
    // 异步处理消息以进行文件上传（在转换请求之前）
    requestBody.messages = await processMessagesForQwen(
      requestBody.messages,
      token
    );

    // 将 OpenAI 请求转换为 Qwen 格式
    const qwenRequest = transformOpenAIRequestToQwen(requestBody);

    // 构建请求头
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' // 模拟浏览器
    };

    // 如果配置了特殊 cookie，添加到请求头中
    if (config.ssxmodItna) {
      headers['Cookie'] = `ssxmod_itna=${config.ssxmodItna}`;
    }

    // 向上游 Qwen API 发送请求
    const upstreamResponse = await fetch(
      'https://chat.qwen.ai/api/chat/completions',
      {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(qwenRequest)
      }
    );

    // 检查上游响应是否成功
    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const errorBody = await upstreamResponse.text();
      console.error(`上游 API 错误：${upstreamResponse.status}`, errorBody);
      return {
        status: upstreamResponse.status,
        body: { error: '上游 API 请求失败', details: errorBody }
      };
    }

    // 将响应流转换并发送给客户端
    const transformedStream = upstreamResponse.body.pipeThrough(
      createQwenToOpenAIStreamTransformer()
    );

    // 返回流式响应配置
    return {
      status: 200,
      body: transformedStream,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      }
    };
  } catch (err) {
    console.error('聊天完成代理中出错：', (err as Error).message);
    return {
      status: 500,
      body: { error: '内部服务器错误' }
    };
  }
}

// --- 3. Oak 应用程序和路由 ---

// 创建 Oak 应用程序实例
const app = new Application();
// 创建路由器实例
const router = new Router();

// 用于日志记录和错误处理的中间件
app.use(async (ctx: any, next: any) => {
  try {
    await next(); // 执行下一个中间件
  } catch (err) {
    console.error(`未处理的错误：${(err as Error).message}`);
    ctx.response.status = 500;
    ctx.response.body = { error: '内部服务器错误' };
  }
  // 记录所有请求的日志
  console.log(
    `${ctx.request.method} ${ctx.request.url} - ${ctx.response.status}`
  );
});

// 身份验证中间件
const authMiddleware: Middleware = async (ctx: any, next: any) => {
  // 跳过根路径的身份验证（信息页面）
  if (ctx.request.url.pathname === '/') {
    await next();
    return;
  }

  // 如果服务器未配置密钥，允许请求但记录警告
  if (!config.openaiApiKey) {
    await next();
    return;
  }

  // 验证客户端提供的 Authorization 头
  const authHeader = ctx.request.headers.get('Authorization');
  const clientToken = authHeader?.replace(/^Bearer\s+/, '');

  if (clientToken === config.openaiApiKey) {
    await next(); // 验证通过，继续处理
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: '未授权。提供的 API 密钥无效。' };
  }
};

/**
 * GET / (根路径)
 * 提供简单的信息页面，显示代理服务器的基本信息和可用端点
 */
router.get('/', (ctx: Context) => {
  const htmlContent = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Qwen API 代理</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 40px; background-color: #121212; color: #E0E0E0; }
                h1, h2 { color: #BB86FC; border-bottom: 2px solid #373737; padding-bottom: 10px; }
                code { background-color: #333; padding: 2px 6px; border-radius: 4px; font-family: "Courier New", Courier, monospace; }
                p { line-height: 1.6; }
                a { color: #03DAC6; text-decoration: none; }
                a:hover { text-decoration: underline; }
                .container { max-width: 800px; margin: 0 auto; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 Qwen API 代理</h1>
                <p>此服务器作为代理，将标准的 OpenAI API 请求转换为 Qwen Chat API 的专有格式。</p>
                
                <h2>可用的 API 端点</h2>
                <ul>
                    <li><code>GET /v1/models</code> - 检索可用模型列表。</li>
                    <li><code>POST /v1/chat/completions</code> - 主要聊天端点，支持流式传输。</li>
                </ul>

                <h2>源代码</h2>
                <p>本项目的原始源代码可在以下地址找到：</p>
                <p><a href="https://github.com/highkay/qwenchat2api" target="_blank">https://github.com/highkay/qwenchat2api</a></p>
            </div>
        </body>
        </html>
    `;
  ctx.response.body = htmlContent;
  ctx.response.headers.set('Content-Type', 'text/html; charset=utf-8');
});

/**
 * GET /v1/models
 * 从 Qwen API 获取模型列表并添加特殊变体
 */
router.get('/v1/models', async (ctx: Context) => {
  const result = await handleGetModels();
  ctx.response.status = result.status;
  ctx.response.body = result.body;
});

/**
 * POST /v1/chat/completions
 * 主要的聊天代理端点
 */
router.post('/v1/chat/completions', async (ctx: Context) => {
  // 解析客户端的 OpenAI 格式请求
  const requestBody = await ctx.request.body({ type: 'json' }).value;

  const result = await handleChatCompletions(requestBody);

  ctx.response.status = result.status;
  ctx.response.body = result.body;

  // 如果有自定义头部，设置它们
  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) {
      ctx.response.headers.set(key, value);
    }
  }
});

// 应用中间件和路由
app.use(authMiddleware); // 应用身份验证中间件
app.use(router.routes()); // 应用路由
app.use(router.allowedMethods()); // 应用允许的 HTTP 方法

// --- 4. 启动服务器 ---

// 监听服务器启动事件，输出配置信息
app.addEventListener('listen', ({ hostname, port }: any) => {
  console.log(`🚀 服务器正在监听 http://${hostname ?? 'localhost'}:${port}`);
  console.log('正在读取环境变量...');
  if (config.openaiApiKey) {
    console.log('✅ OPENAI_API_KEY 已设置。身份验证已启用。');
  } else {
    console.log('⚠️ OPENAI_API_KEY 未设置。身份验证已禁用。');
  }
  console.log(
    config.apiKeys.length > 0
      ? '✅ API_KEY（用于上游）已设置。'
      : '❌ API_KEY（用于上游）未设置。'
  );
  console.log(
    config.ssxmodItna
      ? '✅ SSXMOD_ITNA（cookie）已设置。'
      : '⚠️ SSXMOD_ITNA（cookie）未设置。'
  );
});

// 启动服务器，监听端口 8000
await app.listen({ port: 8000 });
