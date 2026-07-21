# AGENTS.md

本文件面向在本仓库中协作的 AI 编码代理和开发者。修改代码前请先阅读本文件，并优先遵循仓库现有模式。

## 项目概览

`cnbs-mcp-server` 是一个基于 TypeScript 的 MCP Streamable HTTP 服务，用于访问中国国家统计局及世界银行、IMF、OECD、BIS、普查和部门统计等数据源。

主要目录：

- `src/index.ts`：命令行入口和 HTTP 服务启动逻辑。
- `src/server.ts`：MCP Server 创建、资源注册和工具注册入口。
- `src/tools/`：MCP 工具定义与工具级业务逻辑。
- `src/services/`：API 客户端、缓存、错误处理、数据源等共享服务。
- `src/constants/`：常量、区域和数据源配置。
- `src/types/`：共享 TypeScript 类型。
- `src/__tests__/`：Jest 测试。
- `docs/`：设计文档和模块说明。

## 开发环境

- 使用 Node.js `>=22.12.0`。
- 项目使用 ESM，TypeScript 源码中的相对导入应保留 `.js` 后缀，例如 `import { x } from './foo.js'`。
- 构建产物输出到 `dist/`，不要手工修改 `dist/`。除非用户明确要求发布产物，否则代码改动应集中在 `src/`、测试和文档。

常用命令：

```bash
npm ci
npm run lint
npm test
npm run build
npm run dev
```

本地运行服务：

```bash
node dist/index.js --host 127.0.0.1 --port 12345
```

## 编码规范

- 保持 TypeScript `strict` 兼容，新增代码应尽量提供明确类型。
- 遵循现有 ESLint 配置；未使用参数请使用 `_` 前缀。
- 除非周边代码已有相同模式，否则不要新增全局状态。需要共享状态时优先放在 `services/` 并保持边界清晰。
- 新增 MCP 工具时，应在 `src/tools/` 中实现，并通过 `src/tools/index.ts` 统一注册。
- 工具入参使用 `zod` schema 描述，尽量在边界处完成输入归一化和校验。
- 工具返回值应符合 MCP content/structuredContent 模式；错误应通过 `createToolErrorResult` 或现有错误处理链路返回。
- 日志使用 `createLogger`，避免直接 `console.log`。
- 访问外部 API 时，应考虑超时、重试、限流、缓存、HTML/WAF 异常响应和上游格式变化。
- 缓存键必须稳定、可读、包含影响结果的关键参数。新增缓存策略时参考 `docs/cache-key-design.md` 和 `src/services/cache.ts`。

## 测试要求

改动后根据影响范围运行验证：

- 文档或注释变更：通常无需跑测试，除非文档包含可执行示例。
- 单个工具或服务变更：至少运行相关 Jest 测试。
- 共享错误处理、缓存、API 客户端、工具注册或入口逻辑变更：运行 `npm run lint`、`npm test` 和 `npm run build`。

新增功能应补充或更新测试，优先覆盖：

- schema 参数校验和类型归一化。
- 外部 API 异常、空数据、格式变化和重试失败。
- 缓存命中、过期、stale grace 和容量行为。
- MCP 工具错误返回结构。

## 文档约定

- 用户向文档优先更新 `README.md` 和 `README.zh-CN.md`。
- 技术方案都放在 `docs/plans/` 中。
- 工具列表、推荐查询流程或 LLM 使用提示发生变化时，同步检查 `llms.txt` 和 `src/tools/guide-content.ts`。
- 中文文档保持简洁、面向使用者；英文文档保持与中文版本的信息一致。

## CI/CD 流程

CI/CD 由 `.github/workflows/` 下的三个工作流组成，详情见 `.github/workflows/README.md`。

- `ci.yml`：在推送到 `main`/`master` 及相关 PR 时触发，使用 Node.js 22.x 和 24.x 矩阵依次执行 `npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:coverage`，并上传覆盖率到 Codecov。纯文档改动（`*.md`、`docs/**`、`llms.txt`、`License`）通过 `paths-ignore` 跳过。
- `docker.yml`：PR 仅构建镜像用于验证；推送到 `main`/`master`、语义化版本 tag 或预发布 tag 时，构建 `linux/amd64,linux/arm64` 多平台镜像并发布到 GitHub Container Registry（`ghcr.io/<owner>/<repo>`）。也支持 `workflow_dispatch` 手动触发。
- `release.yml`：推送语义化版本 tag（如 `1.2.0`）或预发布 tag（如 `1.2.0-beta.1`）时，自动生成 release notes 并创建 GitHub Release，预发布 tag 会标记为 prerelease。

代理修改工作流时须注意：

- 改动 `npm` 脚本名（`typecheck`、`lint`、`build`、`test:coverage`）需同步更新 `ci.yml`，避免 CI 步骤失效。
- 新增仅影响文档的路径时，同步维护各工作流的 `paths-ignore` 列表。
- 不要在工作流中打印或提交密钥；镜像发布依赖 `GITHUB_TOKEN`，无需额外硬编码凭据。

## 版本号管理机制

- 版本号遵循语义化版本（SemVer）`MAJOR.MINOR.PATCH`，以 `package.json` 的 `version` 字段为唯一权威来源。
- 发布通过推送与版本号一致的 Git tag 驱动：正式版形如 `1.2.0`，预发布形如 `1.2.0-beta.1`。tag 中包含 `-` 会被识别为预发布，并影响 Docker `major.minor` 标签和 Release 的 prerelease 标记。
- 版本递增约定：破坏性变更（工具契约、环境变量语义、返回结构等）递增 MAJOR；向后兼容的新功能递增 MINOR；修复和内部改进递增 PATCH。
- 打 tag 前须保证 `package.json` 的 `version` 已更新，且本地通过完整校验：

```bash
npm ci
npm run lint
npm run build
npm test -- --runInBand
```

- 代理不应擅自 bump 版本或创建 tag，除非用户明确要求发布。

## 变更边界

- 不要无关重构、格式化整个仓库或改动构建产物。
- 不要提交密钥、token、cookie、真实用户数据或本地日志。
- 不要默认放宽 TLS、安全、鉴权或请求体大小限制。涉及安全行为的变更必须在文档中说明。
- `CNBS_MCP_SERVER_AUTH_TOKEN`、`LOG_LEVEL`、`LOG_DIR`、`CNBS_INSECURE_TLS` 等环境变量行为变更需要同步更新 README。

## 提交前检查清单

- 代码通过 `npm run lint`。
- 测试通过 `npm test`。
- 项目可构建：`npm run build`。
- 新增或变更的工具已在指南和相关 README 中体现。
- 没有修改无关文件或手工编辑 `dist/`。
