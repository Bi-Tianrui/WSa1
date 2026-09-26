# WSa1

理工科教材伴读。在本地挂载 PDF，按目录定位章节，只把相关页交给模型，再把回答整理成可编译的 LaTeX 笔记。

本项目只支持能看见页面的多模态模型。教材的版面、插图、手写推导和扫描页都靠模型直接阅读，不做任何文字提取后的转述，因此纯文本模型（如 deepseek-chat）无法使用。

运行中的程序是 Express + React。开发与测试在 Ubuntu 上完成。`app.py`、`requirements.txt` 和 `run.sh` 是更早的 Streamlit 试验，界面第三个页签会展示这三份文件，服务并不由它们启动。

## 两条通道

两条通道送的都是页面本身，只是载体不同。

| 通道 | 载体 | 适用模型 |
| --- | --- | --- |
| Google Gemini 官方 | 切片后的原生 PDF | gemini-1.5-flash、gemini-1.5-pro |
| OpenAI / Claude 多模态兼容 | 切片页渲染成的 JPEG 影像 | gpt-4o、gpt-4o-mini、claude-3-5-sonnet |

图像通道使用 `image_url` 并固定 `detail: "high"`。低精度会把页面压成缩略图，正文就不再可读。

## 一次提问如何处理

教材页面只在第三步进入模型。

1. **入库。** 上传后在本地读取页数与目录，写入 `uploads/books/<id>_toc.json`。这一步不调用模型，也不把 PDF 发到云端。目录优先取原生书签，其次解析正文里的印刷目录页。
2. **路由。** 只把目录树交给较快的模型；模型不可用时退回本地关键词匹配。目录文本限制在 1,200 token 以内，实测约 430。
3. **切片。** 用 pdf-lib 从原文件截出目标页。Gemini 收到这段微型 PDF；图像通道再经 PDFium 渲染为 JPEG。
4. **输出。** 回答经 SSE 返回，每 15 秒一帧保活。瞬时失败会重试。前端若 90 秒没有新内容会断开，并可以手动停止。

单次上下文硬性限制在 25,000 token 以内。PDF 一页约 258 token，因此最多 30 页；渲染页一页约 1,100 token，因此最多 22 页，两者都在发包前按页数收敛。

### 没有书签的教材

扫描版教材常常既无书签，也无可解析的文字目录。这种情况下系统不会把全书按固定页数切成假章节，而是在**首次提问时**把前 12 页连同一张正文页交给模型，请它读出印刷目录，并用那张正文页上的印刷页码校正物理页偏移。结果写回本地索引，此后不再重复这一步。

这一步一次性消耗约 14k token，界面会明确提示。若该书确实没有印刷目录，系统会记录已尝试过，不再反复消耗。

## 目录

```
server.ts                  HTTP 路由
server/pipeline/           入库、路由、视觉建目录、切片与作答
server/pdf/                文档读取、目录、切片、页面渲染、本地索引
server/providers/          Gemini 与 OpenAI 兼容接口
server/budget.ts           页数与 token 上限
server/sse.ts              流式输出与保活
src/                       答疑、LaTeX 预览、源码页
```

## 运行

需要 Node.js。页面渲染由 WebAssembly 版 PDFium 完成，不需要额外安装系统组件。需要本机编译 PDF 时再安装 XeLaTeX：

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
```

## 限制

- 只能使用具备视觉能力的模型。选了纯文本模型时，端点通常会报错或忽略图像。
- 图像通道单次请求约 3-4 MB，链路较慢时首字延迟明显高于 Gemini 通道。
- 流式中断后不能从已输出的位置续写。
- 加密或结构异常的 PDF 可能无法建立目录索引。
- 教材留在 `uploads/books/`（已加入 `.gitignore`）。超过 15 MB 的文件按 6 MB 分块上传，单文件上限 60 MB。
