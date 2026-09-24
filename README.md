# WSa1：理工科教材伴读与学术排版助手

WSa1 是一个面向数理与工程学科的教材伴读 Web 应用。用户可以上传 PDF 教材、按目录定位内容，并通过 Google Gemini 或 OpenAI 兼容接口进行问答；回答还可以转换为 LaTeX 笔记并在工作台中预览、导出 PDF。

## 当前架构

项目当前的主应用是 React + TypeScript 前端和 Express + TypeScript 后端，开发时由同一个 `server.ts` 进程提供：

```text
浏览器
  │
  ├── React / Vite 前端（聊天、教材管理、LaTeX 工作台）
  │       └── /api/* 同源请求
  │
  └── Express API（端口 3000）
          ├── PDF 上传、页数识别和目录提取
          ├── 教材文件与目录元数据持久化到 uploads/books/
          ├── Gemini / OpenAI 兼容协议模型调用
          └── XeLaTeX 编译状态检测与服务端编译
```

教材上传后，服务端使用 `pdf-lib` 和 `pdf-parse` 读取页数及书签目录；没有可用书签时，会从前若干页尝试解析目录，最后按页数生成分段目录。大文件会由前端切成 6 MB 分块上传，服务端再合并。

前端支持两类模型服务：

- **Google Gemini**：使用 Gemini API，默认从 `GEMINI_API_KEY` 或浏览器设置中读取密钥。
- **OpenAI 兼容协议**：默认地址为 `https://api.deepseek.com/v1`，也可以填写其他兼容 `/models` 和 `/chat/completions` 的服务。

## 环境要求

- Node.js 18 或更高版本，推荐使用当前 LTS 版本
- npm
- 可选：XeLaTeX 及中文 LaTeX 宏包。未安装时，聊天、公式渲染和源码导出仍可用，LaTeX 工作台会使用浏览器端备用 PDF 引擎
- 至少一个可用的 Gemini 或 OpenAI 兼容协议 API Key

Python 不是当前 React/Express 主应用的启动依赖。仓库中的 `app.py` 和 `run.sh` 是旧版 Streamlit 实验入口，默认启动步骤不使用它们。

## 开发环境启动

在项目根目录执行。当前依赖树中的 `vite@8.3.0` 与 `esbuild@0.25.x` 存在 peer 依赖冲突，因此需要使用 `--legacy-peer-deps` 安装：

```bash
npm install --legacy-peer-deps
npm run dev
```

启动成功后访问：<http://localhost:3000>

`npm run dev` 会启动 `server.ts`。它内部创建 Vite 开发中间件，同时提供 Express API，因此开发时不需要再单独执行 `npm run preview` 或启动第二个前端服务。

### 配置 API Key

可以在项目根目录创建 `.env`，配置服务端默认使用的 Gemini Key：

```dotenv
GEMINI_API_KEY=your_gemini_api_key
```

也可以直接在页面左侧配置面板中填写 Gemini Key，或填写 OpenAI 兼容服务的 Base URL、API Key 和模型。浏览器端配置会保存到当前浏览器的 `localStorage`。不要把真实密钥提交到 Git 仓库。

启动后可以用以下接口确认后端是否正常：

```bash
curl http://localhost:3000/api/health
```

返回 JSON 中的 `status` 为 `ok` 即表示 Express 服务已启动；`hasEnvKey` 只反映服务端环境变量中是否存在 `GEMINI_API_KEY`，不代表浏览器中填写的密钥状态。

## 生产构建与启动

生产模式必须先构建前端和后端，再以 `NODE_ENV=production` 启动编译后的服务：

```bash
npm install --legacy-peer-deps
npm run build
NODE_ENV=production npm start
```

启动后访问 <http://localhost:3000>。生产模式下，Express 从 `dist/` 提供静态前端文件，并继续提供 `/api/*` 接口。服务监听地址由代码固定为 `0.0.0.0`，端口固定为 `3000`。

注意：生产启动命令中的 `NODE_ENV=production` 不可省略，否则编译后的服务仍会尝试创建 Vite 开发服务器。`npm run preview` 只用于预览 Vite 静态产物，不提供本项目的 Express API，因此不能代替 `npm start`。

## XeLaTeX（可选）

只有需要服务端原生 XeLaTeX 编译时才需要安装。Ubuntu/Debian 可执行：

```bash
sudo apt update
sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra
```

应用会通过 `GET /api/latex/status` 检测 `xelatex`。安装后重启 Node 服务，再在 LaTeX 工作台点击编译。

## 数据与文件

- `uploads/books/`：上传的 PDF、目录元数据和大文件上传临时分块
- `dist/`：`npm run build` 生成的生产构建产物
- `.env`：本地环境变量文件，不应提交到仓库

教材数据保存在本地文件系统，不会自动迁移到数据库。删除教材时，应用会同时删除对应 PDF 和目录元数据。

## 常用命令

```bash
npm run dev                    # 开发模式：Express + Vite，端口 3000
npm run lint                   # TypeScript 类型检查
npm run build                  # 构建 Vite 前端和 Express 服务端
NODE_ENV=production npm start  # 启动 dist/server.cjs
npm run clean                  # 删除 dist 和 server.js
```

## 目录概览

```text
server.ts                 Express API、模型调用和生产静态文件服务
server/pdfEngine.ts       PDF 页数、目录解析和教材文件管理
src/App.tsx               React 应用状态与主要页面编排
src/components/           侧边栏、聊天区、LaTeX 工作台和源码查看器
src/utils/latexParser.tsx Markdown/LaTeX 解析辅助逻辑
package.json              Node.js 依赖与启动脚本
app.py / run.sh           旧版 Streamlit 入口，不是当前主应用启动方式
```
