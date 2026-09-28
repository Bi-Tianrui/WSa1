# WSa1

本地教材伴读。上传时在侧栏选一种方式：教材按目录切章节；习题、PPT 扫描或短文整份送入模型。两种都可以同时挂载。再把回答整理成可编译的 LaTeX。

只支持能看见页面的模型。教材版面、插图、手写推导和扫描页都由模型直接阅读，不做 OCR 后再转述。纯文本模型无法使用。

当前程序是 Express + React。`app.py`、`requirements.txt`、`run.sh` 是更早的 Streamlit 试验，界面「源码」页签会展示这三份文件，服务并不由它们启动。

## 通道

两条通道送的都是页面本身，载体不同。千问走阿里云 DashScope 的 OpenAI 兼容接口，载体与 OpenAI 相同。

| 通道 | 载体 | 适用端点 |
| --- | --- | --- |
| Gemini | 切片后的原生 PDF | Google 官方，如 `gemini-flash-latest`、`gemini-3.8-flash` |
| 千问 | 页面渲染成的 JPEG | DashScope / QwenCloud 兼容模式。阿里云须选 VL 型号（`qwen-vl-max`、`qwen3-vl-plus`）；QwenCloud 的 `qwen3.7-plus` 本身带视觉 |
| OpenAI 兼容 | 页面渲染成的高精度 JPEG | OpenAI、Claude、XBCL、OpenRouter、本地 Ollama 等 |

图像通道使用 `image_url`。OpenAI 兼容端点固定 `detail: "high"`；千问 VL 按 DashScope 格式发送。纯文本千问（`qwen-plus`、`qwen-turbo` 等）看不见页面，不会被自动选中。

## 提问流程

页面只在切片之后进入模型。上传时由用户选定读法，程序不自动判断文档类型。

1. **入库。** 「按章节切片」建立目录索引，写入 `uploads/books/<id>_toc.json`。「整份阅读」只记页数，不建目录、不跑视觉识别。
2. **路由。** 仅对章节模式：先把目录树交给较快的模型；不可用时退回本地关键词匹配。目录文本限制在 1,200 token 以内。
3. **切片。** 整份文件优先占用本轮页数预算，剩余再给章节切片。Gemini 收到微型 PDF；图像通道再经 PDFium 渲染为 JPEG。
4. **输出。** 回答经 SSE 返回，每 15 秒保活一帧。前端若 90 秒没有新内容会断开，也可以手动停止。

单次最多 10 页（章节切片通常 6–10 页）。超过上限的整份文件会截断并提示。PDF 一页约 258 token，图像页约 1,100 token，都在 25,000 token 预算内。

## 目录索引

仅「按章节切片」会建目录。上传时按代价从低到高依次尝试，结果写入本地，识别只做一次。

1. **原生书签。** 解析 PDF Outline，不调用模型。
2. **正文印刷目录。** 无书签但有文字层时，扫描前 30 页匹配印刷目录。
3. **视觉识别。** 纯扫描版取前 15 页交给当前多模态模型，请它输出章节 JSON。只在上传时发生一次。

三层都失败时，退化为每 30 页一个逻辑块。侧栏会标为按页分块，此时章节定位只是按页数猜测。

若上传时尚未配置 API Key，第三层无法执行，该书会先落到逻辑块；首次提问时会补做一次识别，此后不再重复。

带书签或有文字层目录的教材入库不消耗 token。纯扫描版会在上传时产生一次性视觉识别开销。

## 界面

- **答疑：** 配置通道与密钥，用两个上传框分别挂载教材或整份文件，流式问答。回答可复制，或导入 LaTeX 编辑器。
- **LaTeX：** 左侧编辑 `document.tex`，右侧用 pdf.js 画布预览编译结果。本机有 XeLaTeX 时走原生编译。
- **源码：** 查看早期 Streamlit 试验文件。

提问前会探测当前密钥可用的模型，并避开文本-only、TTS、embedding 以及已下线的 Gemini 2.5 Flash。

## 目录结构

```
server.ts                  HTTP 路由
server/pipeline/           入库、路由、切片与作答
server/pdf/outline.ts      书签 / 文字层 / 视觉识别，以及等距兜底
server/pdf/                文档读取、切片、页面渲染、本地索引
server/providers/          Gemini 与 OpenAI 兼容接口
server/budget.ts           页数与 token 上限
server/models.ts           模型可用性与排序
server/sse.ts              流式输出与保活
src/                       答疑、LaTeX 预览、源码页
```

## 运行

需要 Node.js。页面渲染由 WebAssembly 版 PDFium 完成，不必额外安装系统组件。需要本机编译 PDF 时再安装 XeLaTeX：

```bash
sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra
```

```bash
git clone https://github.com/Bi-Tianrui/WSa1.git
cd WSa1
npm install
npm run dev
```

浏览器打开 http://localhost:3000 。

生产环境：

```bash
npm run build
NODE_ENV=production npm start
```

可选的 `.env`：

```
GEMINI_API_KEY=
DASHSCOPE_API_KEY=
```

## 限制

- 只能使用具备视觉能力的模型。选了纯文本模型时，端点通常会报错或忽略图像。
- 图像通道单次请求约 3–4 MB，链路较慢时首字延迟高于 Gemini。
- 流式中断后不能从已输出的位置续写。
- 加密或结构异常的 PDF 可能无法建立目录索引。
- 教材留在 `uploads/books/`（已加入 `.gitignore`）。超过 15 MB 的文件按 6 MB 分块上传，单文件上限 60 MB。
