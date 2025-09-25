# Cookie 动态管理功能实施清单

## 📋 总体目标
实现基于 Web 界面的 Cookie 动态管理系统，支持多令牌轮换和自动失效检测。

## 🏗️ 架构变更

### 1. 环境变量简化
- [ ] 移除 `API_KEY` 和 `SSXMOD_ITNA` 环境变量的读取
- [ ] 保留 `OPENAI_API_KEY` 作为管理员验证密钥
- [ ] 更新文件头部的环境变量说明注释

### 2. 内存存储结构设计
- [ ] 定义 Token 数据结构
```typescript
interface TokenItem {
  id: string;           // 唯一标识符
  value: string;        // 完整的令牌值
  isValid: boolean;     // 可用性状态（新导入默认为 true）
  createdAt: number;    // 创建时间戳
  lastUsed?: number;    // 最后使用时间
  errorCount?: number;  // 错误次数统计
}

interface CookieStore {
  apiKeys: TokenItem[];      // API_KEY (token字段) 数组
  ssxmodItnaTokens: TokenItem[];  // SSXMOD_ITNA 数组
}
```
以上类型定义仅用来帮助理解，main.ts中并不需要引入类型定义，保持其代码简洁。

- [ ] 实现内存存储管理器
  - [ ] `addApiKey(value: string): void` - 添加且去重
  - [ ] `addSsxmodItna(value: string): void` - 添加且去重
  - [ ] `getValidApiKey(): string | null` - 轮换获取可用的 API_KEY
  - [ ] `getValidSsxmodItna(): string | null` - 获取可用的 SSXMOD_ITNA
  - [ ] `markAsInvalid(type: 'apiKey' | 'ssxmod', value: string): void` - 4xx错误时标记失效
  - [ ] `deleteInvalidToken(type: 'apiKey' | 'ssxmod', maskedValue: string): boolean` - 删除失效令牌
  - [ ] `removeDuplicates(): void` - 内部去重逻辑
  - [ ] `getDisplayList(): { apiKeys: DisplayItem[], ssxmod: DisplayItem[] }` - 获取掩码显示列表
  - [ ] `maskTokenValue(value: string): string` - 掩码函数（保留前后4位）

### 3. Cookie 解析功能
- [ ] 实现 Cookie 字符串解析函数
```typescript
function parseCookieString(cookieStr: string): {
  apiKey?: string;      // 从 token= 字段提取
  ssxmodItna?: string;  // 从 ssxmod_itna= 字段提取
  error?: string;
}
// 解析规则：
// token=eyJ... -> API_KEY
// ssxmod_itna=1-Qq0x9Q... -> SSXMOD_ITNA
```
- [ ] Cookie 格式验证和错误处理
- [ ] 支持分号分隔的标准 Cookie 格式解析

## 🎨 前端界面更新

### 4. HTML 页面重构
- [ ] 引入 SweetAlert2 (通过 unpkg)
```html
<script src="https://unpkg.com/sweetalert2@11"></script>
```
- [ ] 添加 "导入 Cookie" 按钮
- [ ] 设计 Token 状态显示表格
  - [ ] API Keys 表格（掩码显示）
  - [ ] SSXMOD_ITNA 表格（掩码显示）
  - [ ] 状态指示器（✅ 可用 / ❌ 不可用）
- [ ] 实现掩码显示函数（保留前后4位字符）

### 5. 交互功能实现
- [ ] SweetAlert2 弹窗配置
  - [ ] Cookie 输入框（textarea）
  - [ ] OPENAI_API_KEY 验证输入框
  - [ ] 表单验证逻辑
- [ ] AJAX 提交到新的 API 端点
- [ ] 成功/失败反馈处理
- [ ] 页面数据自动刷新

## 🔧 后端 API 扩展

### 6. 新增 API 端点
- [ ] `POST /admin/import-cookie` - Cookie 导入接口
  - [ ] 管理员身份验证（OPENAI_API_KEY）
  - [ ] Cookie 解析和存储
  - [ ] 重复值检测和合并
  - [ ] 成功/错误响应

- [ ] `GET /admin/tokens-status` - Token 状态查询接口
  - [ ] 返回掩码后的 Token 列表
  - [ ] 包含状态和统计信息

- [ ] `POST /admin/delete-invalid-token` - 删除失效 Token 接口
  - [ ] 管理员身份验证（OPENAI_API_KEY）
  - [ ] 接收掩码值和类型参数 `{ type: 'apiKey'|'ssxmod', maskedValue: string }`
  - [ ] 仅允许删除 `isValid: false` 的令牌
  - [ ] 返回删除结果

### 7. 核心逻辑更新
- [ ] 更新 `getUpstreamToken()` 函数
  - [ ] 从内存存储中获取可用 API_KEY
  - [ ] 实现智能轮换（跳过 isValid=false 的项目）
  - [ ] 记录使用时间和次数

- [ ] 更新 `handleChatCompletions()` 和 `handleGetModels()` 函数
  - [ ] 获取匹配的 SSXMOD_ITNA 值
  - [ ] 4xx 错误状态检测和自动标记逻辑
  - [ ] 仅在 4xx 错误时标记为无效（401、403、429 等）

## 🔍 错误处理和监控

### 8. 状态管理优化
- [ ] 实现 4xx 错误检测逻辑
  - [ ] 检测 401、403、429、400-499 状态码
  - [ ] 自动标记对应的 API_KEY 和 SSXMOD_ITNA 为失效
  - [ ] 记录失效时间和原因

- [ ] 添加使用统计
  - [ ] 请求成功/失败计数
  - [ ] 最后使用时间记录
  - [ ] 错误类型统计

### 9. 用户体验提升
- [ ] Token 管理界面增强
  - [ ] 手动删除失效 Token 按钮
  - [ ] Token 使用统计显示
  - [ ] 导入操作反馈优化
- [ ] 手动启用/禁用 Token 功能

## 🛡️ 安全和稳定性

### 10. 安全措施
- [ ] OPENAI_API_KEY 验证强化
- [ ] 防止 Cookie 注入攻击
- [ ] 限制导入频率（防滥用）
- [ ] 敏感信息掩码显示

### 11. 稳定性保障
- [ ] 优雅降级（无可用 Token 时的处理）
- [ ] 内存泄漏防护
- [ ] 异常情况的错误恢复
- [ ] 日志记录增强

## 🧪 测试计划

### 12. 功能测试
- [ ] Cookie 解析准确性测试
- [ ] 管理员验证流程测试  
- [ ] Token 轮换逻辑测试
- [ ] 状态标记和恢复测试
- [ ] 前端交互功能测试

### 13. 边界测试
- [ ] 大量 Token 处理性能测试
- [ ] 恶意输入防护测试
- [ ] 网络异常恢复测试
- [ ] 内存使用情况监控

## 📝 文档更新

### 14. 文档维护
- [ ] 更新 README.md 中的环境变量说明
- [ ] 添加新功能使用说明
- [ ] 更新部署指南
- [ ] 添加故障排除指南

---

## 🚀 实施优先级

**Phase 1 (核心功能)**：步骤 1-7
**Phase 2 (用户体验)**：步骤 8-9  
**Phase 3 (完善优化)**：步骤 10-14

## 💡 实施建议

1. **渐进式实施**：先完成核心的 Cookie 解析和存储功能
2. **向后兼容**：保持现有 API 的兼容性
3. **错误恢复**：确保在没有有效 Token 时系统仍能正常启动
4. **用户反馈**：在每个关键步骤都提供清晰的用户反馈

## ✅ 需求确认 (已明确)

1. **Cookie 解析格式**：
   - `token=eyJ...` → API_KEY  
   - `ssxmod_itna=1-Qq0x9Q...` → SSXMOD_ITNA

2. **失效策略**：仅根据 4xx 错误状态码判断失效

3. **删除功能**：通过 POST 接口删除失效令牌（仅限 isValid=false）

4. **默认状态**：新导入令牌默认 isValid=true

## 🔧 关键技术实现点

1. **Cookie 解析正则**：
```typescript
const tokenMatch = cookieStr.match(/token=([^;]+)/);
const ssxmodMatch = cookieStr.match(/ssxmod_itna=([^;]+)/);
```

2. **掩码显示算法**：保留前后4位，中间用 * 替换

3. **轮换逻辑**：跳过 isValid=false，优先使用最少使用的令牌

4. **错误处理**：在 4xx 响应时自动调用 markAsInvalid()

---

## 📋 实施准备就绪！
所有需求已明确，可以开始 Phase 1 的开发工作。核心架构清晰，技术路径确定，具备完整的实施指导。