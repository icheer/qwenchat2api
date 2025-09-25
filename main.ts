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
 *    - `OPENAI_API_KEY`: 客户端访问此代理的密钥。自签发,自行私下约定的密钥.并非上行密钥!
 *                        示例：`sk-my-secret-key-12345`
 *
 * 3. **运行**：
 *    脚本将在部署后自动运行。
 *
 * --- 本地使用 ---
 *
 * 1. 将此文件保存为 `main.ts`。
 * 2. 在终端中设置环境变量：
 *    export OPENAI_API_KEY="your_secret_proxy_key"
 * 3. 运行脚本：
 *    deno run --allow-net --allow-env --unstable-kv main.ts
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

// 应用程序配置对象，现在简化为只需要一个可选的环境变量
const config = {
  // OpenAI API 密钥，用于保护代理端点（可选）
  openaiApiKey: Deno.env.get('OPENAI_API_KEY') || ''
};

// --- 内存存储管理器 ---

/**
 * 令牌存储项数据结构
 */
interface TokenItem {
  id: string; // 唯一标识符
  value: string; // 令牌值（API_KEY 或 SSXMOD_ITNA）
  isValid: boolean; // 是否有效（false表示401/403等错误）
  createdAt: number; // 创建时间戳
  lastUsed?: number; // 最后使用时间戳
  errorCount: number; // 错误计数
}

/**
 * Cookie 存储结构
 */
interface CookieStore {
  apiKeys: TokenItem[]; // API_KEY (token字段) 数组
  ssxmodItnaTokens: TokenItem[]; // SSXMOD_ITNA 数组
}

/**
 * KV存储管理类 - 使用Deno.Kv进行持久化存储
 */
class KvStore {
  private kv: Deno.Kv | null = null;
  private readonly API_KEYS_KEY = ['tokens', 'apiKeys'];
  private readonly SSXMOD_KEYS_KEY = ['tokens', 'ssxmodTokens'];

  /**
   * 初始化KV存储连接
   */
  async init(): Promise<void> {
    try {
      this.kv = await Deno.openKv();
      console.log('✅ KV存储初始化成功');
    } catch (error) {
      console.error('❌ KV存储初始化失败:', error);
      throw error;
    }
  }

  /**
   * 获取所有API密钥
   */
  async getApiKeys(): Promise<TokenItem[]> {
    if (!this.kv) throw new Error('KV存储未初始化');
    const result = await this.kv.get<TokenItem[]>(this.API_KEYS_KEY);
    return result.value || [];
  }

  /**
   * 获取所有SSXMOD令牌
   */
  async getSsxmodTokens(): Promise<TokenItem[]> {
    if (!this.kv) throw new Error('KV存储未初始化');
    const result = await this.kv.get<TokenItem[]>(this.SSXMOD_KEYS_KEY);
    return result.value || [];
  }

  /**
   * 获取完整的存储数据
   */
  async getCookieStore(): Promise<CookieStore> {
    const [apiKeys, ssxmodItnaTokens] = await Promise.all([
      this.getApiKeys(),
      this.getSsxmodTokens()
    ]);
    return { apiKeys, ssxmodItnaTokens };
  }

  /**
   * 添加API密钥
   */
  async addApiKey(token: TokenItem): Promise<boolean> {
    if (!this.kv) throw new Error('KV存储未初始化');
    
    const apiKeys = await this.getApiKeys();
    
    // 检查是否已存在
    if (apiKeys.some(item => item.value === token.value)) {
      return false; // 已存在
    }

    apiKeys.push(token);
    await this.kv.set(this.API_KEYS_KEY, apiKeys);
    return true;
  }

  /**
   * 添加SSXMOD令牌
   */
  async addSsxmodToken(token: TokenItem): Promise<boolean> {
    if (!this.kv) throw new Error('KV存储未初始化');
    
    const ssxmodTokens = await this.getSsxmodTokens();
    
    // 检查是否已存在
    if (ssxmodTokens.some(item => item.value === token.value)) {
      return false; // 已存在
    }

    ssxmodTokens.push(token);
    await this.kv.set(this.SSXMOD_KEYS_KEY, ssxmodTokens);
    return true;
  }

  /**
   * 更新API密钥状态
   */
  async updateApiKey(tokenValue: string, updates: Partial<TokenItem>): Promise<boolean> {
    if (!this.kv) throw new Error('KV存储未初始化');
    
    const apiKeys = await this.getApiKeys();
    const tokenIndex = apiKeys.findIndex(item => item.value === tokenValue);
    
    if (tokenIndex !== -1) {
      apiKeys[tokenIndex] = { ...apiKeys[tokenIndex], ...updates };
      await this.kv.set(this.API_KEYS_KEY, apiKeys);
      return true;
    }
    return false;
  }

  /**
   * 更新SSXMOD令牌状态
   */
  async updateSsxmodToken(tokenValue: string, updates: Partial<TokenItem>): Promise<boolean> {
    if (!this.kv) throw new Error('KV存储未初始化');
    
    const ssxmodTokens = await this.getSsxmodTokens();
    const tokenIndex = ssxmodTokens.findIndex(item => item.value === tokenValue);
    
    if (tokenIndex !== -1) {
      ssxmodTokens[tokenIndex] = { ...ssxmodTokens[tokenIndex], ...updates };
      await this.kv.set(this.SSXMOD_KEYS_KEY, ssxmodTokens);
      return true;
    }
    return false;
  }

  /**
   * 删除无效的令牌
   */
  async deleteInvalidTokens(): Promise<{ deletedApiKeys: number; deletedSsxmods: number }> {
    if (!this.kv) throw new Error('KV存储未初始化');
    
    const [apiKeys, ssxmodTokens] = await Promise.all([
      this.getApiKeys(),
      this.getSsxmodTokens()
    ]);

    const validApiKeys = apiKeys.filter(item => item.isValid);
    const validSsxmodTokens = ssxmodTokens.filter(item => item.isValid);

    const deletedApiKeys = apiKeys.length - validApiKeys.length;
    const deletedSsxmods = ssxmodTokens.length - validSsxmodTokens.length;

    await Promise.all([
      this.kv.set(this.API_KEYS_KEY, validApiKeys),
      this.kv.set(this.SSXMOD_KEYS_KEY, validSsxmodTokens)
    ]);

    return { deletedApiKeys, deletedSsxmods };
  }

  /**
   * 关闭KV连接
   */
  close(): void {
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
  }
}

// 创建KV存储实例
const kvStore = new KvStore();

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
async function addApiKey(value: string): Promise<void> {
  // 添加新的 API_KEY
  const newToken: TokenItem = {
    id: generateId(),
    value: value,
    isValid: true, // 新导入默认为 true
    createdAt: Date.now(),
    lastUsed: undefined,
    errorCount: 0
  };

  const added = await kvStore.addApiKey(newToken);
  if (added) {
    console.log(`已添加新的 API_KEY: ${maskTokenValue(value)}`);
  } else {
    console.log('API_KEY 已存在，跳过添加');
  }
}

/**
 * 添加 SSXMOD_ITNA 到存储中（自动去重）
 * @param value SSXMOD_ITNA 值
 */
async function addSsxmodItna(value: string): Promise<void> {
  // 添加新的 SSXMOD_ITNA
  const newToken: TokenItem = {
    id: generateId(),
    value: value,
    isValid: true, // 新导入默认为 true
    createdAt: Date.now(),
    lastUsed: undefined,
    errorCount: 0
  };

  const added = await kvStore.addSsxmodToken(newToken);
  if (added) {
    console.log(`已添加新的 SSXMOD_ITNA: ${maskTokenValue(value)}`);
  } else {
    console.log('SSXMOD_ITNA 已存在，跳过添加');
  }
}

/**
 * 轮换获取可用的 API_KEY（优先使用环境变量，然后是 KvStore）
 * @returns 可用的 API_KEY 值或 null
 */
async function getValidApiKey(): Promise<string | null> {
  const validTokens = (await kvStore.getApiKeys()).filter(token => token.isValid);
  console.log(`当前 API_KEY 存储状态: 共${validTokens.length}个有效令牌`);

  if (validTokens.length === 0) {
    return null;
  }

  // 简单轮换：按最少使用优先
  validTokens.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  const selectedToken = validTokens[0];

  // 更新使用时间
  await kvStore.updateApiKey(selectedToken.value, { lastUsed: Date.now() });

  return selectedToken.value;
}

/**
 * 获取可用的 SSXMOD_ITNA 值
 * @returns 可用的 SSXMOD_ITNA 值或 null
 */
async function getValidSsxmodItna(): Promise<string | null> {
  const validTokens = (await kvStore.getSsxmodTokens()).filter(
    token => token.isValid
  );

  if (validTokens.length === 0) {
    return null;
  }

  // 简单选择第一个可用的
  const selectedToken = validTokens[0];
  await kvStore.updateSsxmodToken(selectedToken.value, { lastUsed: Date.now() });

  return selectedToken.value;
}

/**
 * 标记令牌为无效（4xx错误时调用）
 * @param type 令牌类型：'apiKey' 或 'ssxmod'
 * @param value 令牌值
 */
async function markAsInvalid(type: string, value: string): Promise<void> {
  if (type === 'apiKey') {
    await kvStore.updateApiKey(value, { 
      isValid: false, 
      errorCount: await getTokenErrorCount(value, 'apiKey') + 1 
    });
  } else if (type === 'ssxmod') {
    await kvStore.updateSsxmodToken(value, { 
      isValid: false, 
      errorCount: await getTokenErrorCount(value, 'ssxmod') + 1 
    });
  } else {
    console.error(`无效的令牌类型: ${type}`);
    return;
  }
  
  console.log(`已标记 ${type} 为无效: ${maskTokenValue(value)}`);
}

/**
 * 获取令牌的错误计数
 */
async function getTokenErrorCount(value: string, type: string): Promise<number> {
  if (type === 'apiKey') {
    const tokens = await kvStore.getApiKeys();
    const token = tokens.find(item => item.value === value);
    return token ? token.errorCount : 0;
  } else if (type === 'ssxmod') {
    const tokens = await kvStore.getSsxmodTokens();
    const token = tokens.find(item => item.value === value);
    return token ? token.errorCount : 0;
  }
  return 0;
}

/**
 * 删除失效的令牌（仅限 isValid=false）
 * @param type 令牌类型：'apiKey' 或 'ssxmod'
 * @param maskedValue 掩码后的令牌值
 * @returns 是否成功删除
 */
async function deleteInvalidToken(type: string, maskedValue: string): Promise<boolean> {
  // 暂时使用KV存储的批量删除功能
  const result = await kvStore.deleteInvalidTokens();
  console.log(`已删除 ${result.deletedApiKeys} 个无效API密钥，${result.deletedSsxmods} 个无效SSXMOD令牌`);
  return result.deletedApiKeys > 0 || result.deletedSsxmods > 0;
}

/**
 * 显示令牌项数据结构
 */
interface DisplayTokenItem {
  id: string;
  maskedValue: string;
  isValid: boolean;
  createdAt: string;
  lastUsed: string;
  errorCount: number;
}

/**
 * 显示列表数据结构
 */
interface DisplayList {
  apiKeys: DisplayTokenItem[];
  ssxmod: DisplayTokenItem[];
}

/**
 * 获取用于显示的令牌列表（掩码处理）
 * @returns 包含掩码后令牌信息的显示列表
 */
async function getDisplayList(): Promise<DisplayList> {
  const cookieStoreData = await kvStore.getCookieStore();
  
  const apiKeysList = cookieStoreData.apiKeys.map(token => ({
    id: token.id,
    maskedValue: maskTokenValue(token.value),
    isValid: token.isValid,
    createdAt: new Date(token.createdAt).toLocaleString('zh-CN'),
    lastUsed: token.lastUsed
      ? new Date(token.lastUsed).toLocaleString('zh-CN')
      : '未使用',
    errorCount: token.errorCount || 0
  }));

  const ssxmodList = cookieStoreData.ssxmodItnaTokens.map(token => ({
    id: token.id,
    maskedValue: maskTokenValue(token.value),
    isValid: token.isValid,
    createdAt: new Date(token.createdAt).toLocaleString('zh-CN'),
    lastUsed: token.lastUsed
      ? new Date(token.lastUsed).toLocaleString('zh-CN')
      : '未使用',
    errorCount: token.errorCount || 0
  }));

  return {
    apiKeys: apiKeysList,
    ssxmod: ssxmodList
  };
}

// --- 初始化内存存储 ---

// 注意：环境变量中的 OPENAI_API_KEY 仅用于服务器端身份验证，
// 不会加入到 cookieStore 中，以确保安全性

// 显示初始化信息
if (!config.openaiApiKey) {
  console.warn('⚠️ 未设置 OPENAI_API_KEY。');
  console.warn(
    '   建议：通过环境变量设置默认密钥，或使用 /cookies 接口导入密钥。'
  );
  console.warn('   如果没有导入任何密钥，服务将无法正常工作。');
}

// --- Cookie 解析功能 ---

/**
 * 解析 Cookie 字符串，提取 token（API_KEY）和 ssxmod_itna 字段
 * @param cookieString 完整的 Cookie 字符串
 * @returns 解析结果对象 { token?: string, ssxmodItna?: string }
 */
function parseCookieString(cookieString: string): {
  token?: string;
  ssxmodItna?: string;
} {
  const result: { token?: string; ssxmodItna?: string } = {};

  try {
    // 清理 Cookie 字符串（去掉前后空白）
    const cleanCookie = cookieString.trim();

    // 正则表达式匹配 token 字段（支持 sk- 开头或 JWT 格式）
    const tokenMatch = cleanCookie.match(/token=([^;]+)/);
    if (tokenMatch && tokenMatch[1]) {
      const tokenValue = decodeURIComponent(tokenMatch[1].trim());
      // 验证 token 格式（sk-开头 或 JWT格式 或 其他合理长度的token）
      if (
        (tokenValue.startsWith('sk-') && tokenValue.length > 10) ||
        (tokenValue.includes('.') && tokenValue.length > 50) || // JWT格式
        tokenValue.length > 20
      ) {
        // 其他格式的长token
        result.token = tokenValue;
      }
    }

    // 正则表达式匹配 ssxmod_itna 字段
    const ssxmodMatch = cleanCookie.match(/ssxmod_itna=([^;]+)/);
    if (ssxmodMatch && ssxmodMatch[1]) {
      const ssxmodValue = decodeURIComponent(ssxmodMatch[1].trim());
      // 验证 ssxmod_itna 格式（不为空）
      if (ssxmodValue.length > 0) {
        result.ssxmodItna = ssxmodValue;
      }
    }

    console.log(
      `Cookie 解析完成 - token: ${
        result.token ? '已提取' : '未找到'
      }, ssxmod_itna: ${result.ssxmodItna ? '已提取' : '未找到'}`
    );
  } catch (error) {
    console.error('Cookie 解析失败:', error);
  }

  return result;
}

/**
 * 批量解析 Cookie 字符串数组
 * @param cookieStrings Cookie 字符串数组
 * @returns 解析统计信息
 */
async function batchParseCookies(cookieStrings: string[]): Promise<{
  tokensAdded: number;
  ssxmodsAdded: number;
  totalProcessed: number;
}> {
  let tokensAdded = 0;
  let ssxmodsAdded = 0;
  
  // 获取处理前的数据
  const beforeApiKeys = await kvStore.getApiKeys();
  const beforeSsxmods = await kvStore.getSsxmodTokens();
  const beforeApiKeyCount = beforeApiKeys.length;
  const beforeSsxmodCount = beforeSsxmods.length;

  for (const cookieString of cookieStrings) {
    if (!cookieString || cookieString.trim().length === 0) {
      continue; // 跳过空字符串
    }

    const parsed = parseCookieString(cookieString);

    // 添加解析出的 token
    if (parsed.token) {
      await addApiKey(parsed.token);
    }

    // 添加解析出的 ssxmod_itna
    if (parsed.ssxmodItna) {
      await addSsxmodItna(parsed.ssxmodItna);
    }
  }
  
  // 获取处理后的数据并计算增量
  const afterApiKeys = await kvStore.getApiKeys();
  const afterSsxmods = await kvStore.getSsxmodTokens();
  tokensAdded = afterApiKeys.length - beforeApiKeyCount;
  ssxmodsAdded = afterSsxmods.length - beforeSsxmodCount;

  const result = {
    tokensAdded,
    ssxmodsAdded,
    totalProcessed: cookieStrings.length
  };

  console.log(
    `批量解析完成: 处理了 ${result.totalProcessed} 个 Cookie，新增 ${result.tokensAdded} 个 token，新增 ${result.ssxmodsAdded} 个 ssxmod_itna`
  );

  return result;
}

// 简单的令牌轮换器，用于上游 API 密钥轮换
let tokenIndex = 0;
/**
 * 获取下一个可用的上游 API 令牌
 * 现在使用KV存储管理的动态密钥轮换
 * @returns 当前轮换到的 API 令牌，如果没有可用密钥则返回空字符串
 */
async function getUpstreamToken(): Promise<string> {
  const apiKey = await getValidApiKey();
  if (!apiKey) {
    console.warn('警告：没有可用的 API 密钥！请通过 /cookies 接口导入密钥。');
    return '';
  }
  return apiKey;
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
  const model = openAIRequest.model || 'qwen3-max';

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
  const token = await getUpstreamToken();
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
  const token = await getUpstreamToken();
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

    // 如果有可用的 SSXMOD_ITNA，添加到请求头中
    const ssxmodItna = await getValidSsxmodItna();
    if (ssxmodItna) {
      headers['Cookie'] = `ssxmod_itna=${ssxmodItna}`;
    }

    // 打印信息用于离线调试
    console.log('url', 'https://chat.qwen.ai/api/chat/completions');
    console.log('headers', JSON.stringify(headers, null, 2));
    console.log('body', JSON.stringify(qwenRequest, null, 2));

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

      // 4xx 错误处理：标记相关令牌为失效状态
      if (upstreamResponse.status >= 400 && upstreamResponse.status < 500) {
        console.warn(
          `检测到 4xx 错误 (${upstreamResponse.status})，开始标记相关令牌为失效状态`
        );

        // 标记 API_KEY 为失效
        await markAsInvalid('apiKey', token);

        // 如果使用了 ssxmod_itna，也标记为失效
        if (ssxmodItna) {
          await markAsInvalid('ssxmod', ssxmodItna);
        }

        console.warn('令牌已标记为失效，后续请求将自动轮换至其他可用令牌');
      }

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
  const pathname = ctx.request.url.pathname;
  const method = ctx.request.method;
  
  // 跳过根路径的身份验证
  if (pathname === '/') {
    await next();
    return;
  }
  
  // Cookie管理路径的特殊处理
  if (pathname.startsWith('/cookies')) {
    // GET请求（查看状态）无需身份验证
    if (method === 'GET') {
      await next();
      return;
    }
    
    // DELETE /cookies/invalid（清理无效令牌）无需身份验证
    if (method === 'DELETE' && pathname === '/cookies/invalid') {
      await next();
      return;
    }
    
    // POST请求（导入）和其他DELETE请求需要身份验证
    if (method === 'POST' || method === 'DELETE') {
      // 如果服务器未配置密钥，禁止这些操作
      if (!config.openaiApiKey) {
        ctx.response.status = 503;
        ctx.response.body = { 
          success: false,
          error: '服务器未配置身份验证密钥，Cookie 导入功能不可用。' 
        };
        return;
      }

      // 验证客户端提供的 Authorization 头
      const authHeader = ctx.request.headers.get('Authorization');
      const clientToken = authHeader?.replace(/^Bearer\s+/, '');

      if (clientToken !== config.openaiApiKey) {
        ctx.response.status = 401;
        ctx.response.body = { 
          success: false,
          error: '身份验证失败。请检查 OPENAI_API_KEY 是否正确。' 
        };
        return;
      }
    }
    
    await next();
    return;
  }

  // 其他API路径的身份验证
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
 * 提供 Cookie 管理界面，用于导入和管理令牌
 */
router.get('/', (ctx: Context) => {
  ctx.response.headers.set('Content-Type', 'text/html; charset=utf-8');
  ctx.response.body = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Qwen2OpenAI 代理 - Cookie 管理</title>
    <script src="https://unpkg.com/sweetalert2@11/dist/sweetalert2.all.min.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }
        .card {
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 20px;
            margin-bottom: 20px;
        }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .status-item {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
            text-align: center;
            border-left: 4px solid #667eea;
        }
        .status-number {
            font-size: 24px;
            font-weight: bold;
            color: #667eea;
        }
        .import-section {
            border-top: 2px dashed #eee;
            padding-top: 20px;
        }
        textarea {
            width: 100%;
            height: 120px;
            padding: 12px;
            border: 2px solid #e1e5e9;
            border-radius: 6px;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            resize: vertical;
            box-sizing: border-box;
        }
        textarea:focus {
            outline: none;
            border-color: #667eea;
        }
        
        .auth-section {
            margin: 15px 0;
            padding: 15px;
            background: #f8f9ff;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
        }
        .auth-section label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #2d3748;
        }
        .auth-section input {
            width: 100%;
            padding: 10px;
            border: 1px solid #cbd5e0;
            border-radius: 4px;
            font-size: 14px;
            margin-bottom: 8px;
            box-sizing: border-box;
        }
        .auth-section input:focus {
            border-color: #667eea;
            outline: none;
        }
        .auth-help {
            font-size: 12px;
            color: #718096;
            font-style: italic;
        }
        
        .button {
            background: #667eea;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            margin: 5px;
            transition: background-color 0.2s;
        }
        .button:hover {
            background: #5a67d8;
        }
        .button:disabled {
            background: #a0aec0;
            cursor: not-allowed;
        }
        .button.danger {
            background: #e53e3e;
        }
        .button.danger:hover {
            background: #c53030;
        }
        .tokens-table {
            overflow-x: auto;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid #e2e8f0;
        }
        th {
            background: #f7fafc;
            font-weight: 600;
        }
        .token-valid {
            color: #38a169;
            font-weight: bold;
        }
        .token-invalid {
            color: #e53e3e;
            font-weight: bold;
        }
        .loading {
            display: inline-block;
            margin-left: 10px;
        }
        .help-text {
            color: #718096;
            font-size: 13px;
            margin-top: 8px;
        }
        .example-cookie {
            background: #f7fafc;
            padding: 10px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            margin: 10px 0;
            word-break: break-all;
        }
        .tabs {
            display: flex;
            margin-bottom: 20px;
            border-bottom: 2px solid #e2e8f0;
        }
        .tab-button {
            background: none;
            border: none;
            padding: 12px 20px;
            cursor: pointer;
            font-size: 14px;
            color: #718096;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }
        .tab-button.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }
        .tab-button:hover {
            color: #5a67d8;
            background: #f7fafc;
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .input-group {
            margin-bottom: 15px;
        }
        .input-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: 600;
            color: #2d3748;
        }
        .input-group input {
            width: 100%;
            padding: 10px;
            border: 2px solid #e1e5e9;
            border-radius: 6px;
            font-size: 14px;
            box-sizing: border-box;
            margin-bottom: 10px;
        }
        .input-group input:focus {
            outline: none;
            border-color: #667eea;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🤖 Qwen2OpenAI 代理服务</h1>
        <p>Cookie 令牌管理界面</p>
    </div>

    <div class="card">
        <h2>📊 当前状态</h2>
        <div class="status-grid" id="statusGrid">
            <div class="status-item">
                <div class="status-number" id="totalApiKeys">-</div>
                <div>API Keys 总数</div>
            </div>
            <div class="status-item">
                <div class="status-number" id="validApiKeys">-</div>
                <div>有效 API Keys</div>
            </div>
            <div class="status-item">
                <div class="status-number" id="totalSsxmod">-</div>
                <div>SSXMOD 总数</div>
            </div>
            <div class="status-item">
                <div class="status-number" id="validSsxmod">-</div>
                <div>有效 SSXMOD</div>
            </div>
        </div>
        <button class="button" onclick="refreshStatus()">🔄 刷新状态</button>
        <button class="button danger" onclick="clearInvalidTokens()">🗑️ 清理失效令牌</button>
    </div>

    <div class="card import-section">
        <h2>📥 导入令牌</h2>
        
        <!-- Cookie 导入选项卡 -->
        <div id="cookies-tab" class="tab-content active">
            <div class="help-text">
                请在下方文本框中粘贴完整的 Cookie 字符串，每行一个。系统会自动提取其中的 <code>token</code> 和 <code>ssxmod_itna</code> 字段。
            </div>
            <div class="example-cookie">
                示例格式：token=eyJhbGciOiJIUzI1NiIs...; ssxmod_itna=abc123...; other_field=value
            </div>
            <textarea id="cookiesInput" placeholder="请粘贴 Cookie 字符串，每行一个...&#10;例如：&#10;token=eyJhbGciOiJIUzI1NiIs...; ssxmod_itna=abc123...; path=/&#10;token=sk-789012...; ssxmod_itna=def456...; domain=.example.com"></textarea>
            
            <div class="auth-section">
                <label for="authKey">🔑 身份验证密钥</label>
                <input type="password" id="authKey" placeholder="请输入 OPENAI_API_KEY 进行身份验证" />
                <div class="auth-help">
                    此密钥用于验证您的身份，防止未授权的 Cookie 导入操作
                </div>
            </div>
            
            <div>
                <button class="button" onclick="importCookies()">📤 导入 Cookies</button>
                <button class="button" onclick="clearInput('cookiesInput')">🧹 清空输入</button>
                <span id="importLoading" class="loading" style="display: none;">导入中...</span>
            </div>
        </div>
    </div>

    <div class="card">
        <h2>🔍 令牌详情</h2>
        <div class="tokens-table" id="tokensTable">
            <p>点击"刷新状态"来加载令牌详情</p>
        </div>
    </div>

    <script>
        // 刷新状态
        async function refreshStatus() {
            try {
                const response = await fetch('/cookies');
                const result = await response.json();
                
                if (result.success) {
                    const data = result.data;
                    
                    // 更新状态数字
                    document.getElementById('totalApiKeys').textContent = data.apiKeys.total;
                    document.getElementById('validApiKeys').textContent = data.apiKeys.valid;
                    document.getElementById('totalSsxmod').textContent = data.ssxmodTokens.total;
                    document.getElementById('validSsxmod').textContent = data.ssxmodTokens.valid;
                    
                    // 更新令牌表格
                    updateTokensTable(data);
                } else {
                    Swal.fire('错误', result.message, 'error');
                }
            } catch (error) {
                Swal.fire('错误', '无法获取状态: ' + error.message, 'error');
            }
        }

        // 更新令牌表格
        function updateTokensTable(data) {
            const container = document.getElementById('tokensTable');
            
            let html = '<h3>API Keys</h3>';
            if (data.apiKeys.items.length > 0) {
                html += \`<table>
                    <thead>
                        <tr>
                            <th>掩码值</th>
                            <th>状态</th>
                            <th>创建时间</th>
                            <th>最后使用</th>
                            <th>错误次数</th>
                        </tr>
                    </thead>
                    <tbody>\`;
                
                data.apiKeys.items.forEach(token => {
                    html += \`<tr>
                        <td><code>\${token.maskedValue}</code></td>
                        <td class="\${token.isValid ? 'token-valid' : 'token-invalid'}">\${token.isValid ? '有效' : '失效'}</td>
                        <td>\${token.createdAt}</td>
                        <td>\${token.lastUsed}</td>
                        <td>\${token.errorCount}</td>
                    </tr>\`;
                });
                html += '</tbody></table>';
            } else {
                html += '<p>暂无 API Keys</p>';
            }
            
            html += '<h3>SSXMOD Tokens</h3>';
            if (data.ssxmodTokens.items.length > 0) {
                html += \`<table>
                    <thead>
                        <tr>
                            <th>掩码值</th>
                            <th>状态</th>
                            <th>创建时间</th>
                            <th>最后使用</th>
                            <th>错误次数</th>
                        </tr>
                    </thead>
                    <tbody>\`;
                
                data.ssxmodTokens.items.forEach(token => {
                    html += \`<tr>
                        <td><code>\${token.maskedValue}</code></td>
                        <td class="\${token.isValid ? 'token-valid' : 'token-invalid'}">\${token.isValid ? '有效' : '失效'}</td>
                        <td>\${token.createdAt}</td>
                        <td>\${token.lastUsed}</td>
                        <td>\${token.errorCount}</td>
                    </tr>\`;
                });
                html += '</tbody></table>';
            } else {
                html += '<p>暂无 SSXMOD Tokens</p>';
            }
            
            container.innerHTML = html;
        }

        // 导入 Cookies
        async function importCookies() {
            const input = document.getElementById('cookiesInput').value.trim();
            const authKey = document.getElementById('authKey').value.trim();
            
            if (!input) {
                Swal.fire('提示', '请先输入 Cookie 数据', 'warning');
                return;
            }
            
            if (!authKey) {
                Swal.fire('提示', '请输入身份验证密钥', 'warning');
                return;
            }

            const loading = document.getElementById('importLoading');
            loading.style.display = 'inline';

            try {
                const cookies = input.split('\\n').filter(line => line.trim().length > 0);
                
                const response = await fetch('/cookies', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': \`Bearer \${authKey}\`
                    },
                    body: JSON.stringify({ cookies })
                });

                const result = await response.json();
                
                if (result.success) {
                    Swal.fire({
                        title: '导入成功！',
                        html: \`
                            <p>处理了 <strong>\${result.data.import.processed}</strong> 个 Cookie</p>
                            <p>新增 <strong>\${result.data.import.tokensAdded}</strong> 个 API Key</p>
                            <p>新增 <strong>\${result.data.import.ssxmodsAdded}</strong> 个 SSXMOD 令牌</p>
                        \`,
                        icon: 'success'
                    });
                    
                    // 清空输入并刷新状态
                    document.getElementById('cookiesInput').value = '';
                    document.getElementById('authKey').value = '';
                    refreshStatus();
                } else {
                    Swal.fire('导入失败', result.message || '身份验证失败，请检查密钥是否正确', 'error');
                }
            } catch (error) {
                Swal.fire('错误', '导入过程中发生错误: ' + error.message, 'error');
            } finally {
                loading.style.display = 'none';
            }
        }

        // 清理失效令牌
        async function clearInvalidTokens() {
            const result = await Swal.fire({
                title: '确认删除',
                text: '将删除所有标记为失效的令牌，此操作无法撤销',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: '确认删除',
                cancelButtonText: '取消'
            });

            if (result.isConfirmed) {
                try {
                    const response = await fetch('/cookies/invalid', {
                        method: 'DELETE'
                    });

                    const data = await response.json();
                    
                    if (data.success) {
                        Swal.fire('删除成功', data.message, 'success');
                        refreshStatus();
                    } else {
                        Swal.fire('删除失败', data.message, 'error');
                    }
                } catch (error) {
                    Swal.fire('错误', '删除过程中发生错误: ' + error.message, 'error');
                }
            }
        }

        // 清空输入
        function clearInput(elementId = 'cookiesInput') {
            document.getElementById(elementId).value = '';
        }

        // 页面加载时自动刷新状态
        document.addEventListener('DOMContentLoaded', function() {
            refreshStatus();
        });
    </script>
</body>
</html>
  `;
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

/**
 * GET /cookies
 * 获取当前内存中存储的令牌列表（掩码显示）
 */
router.get('/cookies', async (ctx: Context) => {
  try {
    const displayList = await getDisplayList();
    const summary = {
      timestamp: new Date().toLocaleString('zh-CN'),
      apiKeys: {
        total: displayList.apiKeys.length,
        valid: displayList.apiKeys.filter(item => item.isValid).length,
        invalid: displayList.apiKeys.filter(item => !item.isValid).length,
        items: displayList.apiKeys
      },
      ssxmodTokens: {
        total: displayList.ssxmod.length,
        valid: displayList.ssxmod.filter(item => item.isValid).length,
        invalid: displayList.ssxmod.filter(item => !item.isValid).length,
        items: displayList.ssxmod
      }
    };

    ctx.response.status = 200;
    ctx.response.body = {
      success: true,
      message: 'Cookie 存储状态',
      data: summary
    };
  } catch (error) {
    console.error('获取 Cookie 列表失败:', error);
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: '获取 Cookie 列表失败',
      error: (error as Error).message
    };
  }
});

/**
 * POST /cookies
 * 批量导入 Cookie 字符串并解析其中的令牌
 */
router.post('/cookies', async (ctx: Context) => {
  try {
    const requestBody = await ctx.request.body({ type: 'json' }).value;

    // 验证请求格式
    if (!requestBody || !Array.isArray(requestBody.cookies)) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message:
          '请求格式错误。请提供 { "cookies": ["cookie1", "cookie2", ...] } 格式'
      };
      return;
    }

    // 批量解析 Cookie
    const result = await batchParseCookies(requestBody.cookies);
    const displayList = await getDisplayList();

    ctx.response.status = 200;
    ctx.response.body = {
      success: true,
      message: 'Cookie 导入完成',
      data: {
        import: {
          processed: result.totalProcessed,
          tokensAdded: result.tokensAdded,
          ssxmodsAdded: result.ssxmodsAdded
        },
        current: {
          totalApiKeys: displayList.apiKeys.length,
          totalSsxmods: displayList.ssxmod.length,
          validApiKeys: displayList.apiKeys.filter(item => item.isValid).length,
          validSsxmods: displayList.ssxmod.filter(item => item.isValid).length
        }
      }
    };
  } catch (error) {
    console.error('导入 Cookie 失败:', error);
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: '导入 Cookie 失败',
      error: (error as Error).message
    };
  }
});

/**
 * DELETE /cookies/invalid
 * 删除所有标记为失效的令牌
 */
router.delete('/cookies/invalid', async (ctx: Context) => {
  try {
    // 使用KV存储的批量删除功能
    const result = await kvStore.deleteInvalidTokens();
    const deletedCount = result.deletedApiKeys + result.deletedSsxmods;

    ctx.response.status = 200;
    ctx.response.body = {
      success: true,
      message: `已删除 ${deletedCount} 个失效令牌`,
      data: {
        deletedCount,
        deletedApiKeys: result.deletedApiKeys,
        deletedSsxmods: result.deletedSsxmods,
        remaining: await getDisplayList()
      }
    };
  } catch (error) {
    console.error('删除失效令牌失败:', error);
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: '删除失效令牌失败',
      error: (error as Error).message
    };
  }
});

// 应用中间件和路由
app.use(authMiddleware); // 应用身份验证中间件
app.use(router.routes()); // 应用路由
app.use(router.allowedMethods()); // 应用允许的 HTTP 方法

// --- 4. 启动服务器 ---

// 初始化KV存储
console.log('初始化KV存储...');
await kvStore.init();

// 监听服务器启动事件，输出配置信息
app.addEventListener('listen', async ({ hostname, port }: any) => {
  console.log(`🚀 服务器正在监听 http://${hostname ?? 'localhost'}:${port}`);
  console.log('正在读取环境变量...');
  if (config.openaiApiKey) {
    console.log('✅ OPENAI_API_KEY 已设置。身份验证已启用。');
  } else {
    console.log('⚠️ OPENAI_API_KEY 未设置。身份验证已禁用。');
  }

  // 显示内存存储状态（仅显示通过 /cookies 接口导入的密钥）
  const displayList = await getDisplayList();
  console.log(
    displayList.apiKeys.length > 0
      ? `✅ Cookie API_KEY 存储：已导入 ${displayList.apiKeys.length} 个密钥`
      : '❌ Cookie API_KEY 存储：暂无导入密钥'
  );
  console.log(
    displayList.ssxmod.length > 0
      ? `✅ SSXMOD_ITNA 存储：已导入 ${displayList.ssxmod.length} 个令牌`
      : '⚠️ SSXMOD_ITNA 存储：暂无导入令牌'
  );
});

// 启动服务器，监听端口 8000
await app.listen({ port: 8000 });
