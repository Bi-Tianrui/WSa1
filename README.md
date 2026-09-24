# WSa1

理工科教材伴读。在本地挂载 PDF，按目录定位章节，只把相关页交给模型，再把回答整理成可编译的 LaTeX 笔记。

运行中的程序是 Express + React。开发与测试在 Ubuntu 上完成。`app.py`、`requirements.txt` 和 `run.sh` 是更早的 Streamlit 试验，界面第三个页签会展示这三份文件，服务并不由它们启动。

## 界面

- **答疑。** 选择 Gemini，或填写任意 OpenAI 兼容地址（默认 DeepSeek）。模型列表从对应接口拉取，不在代码里写死型号。侧栏挂载教材后可以提问；未提问时上下文显示为 `目录索引待命 · 0 Token`，提问后显示本轮切片的估算开销。
- **LaTeX。** 答疑内容可导入 `ctexart` 文稿。本机有 `xelatex` 时由后端编译并预览 PDF；没有时退回浏览器侧生成。
- **源码。** 只读展示上述 Python 试验文件。

密钥保存在浏览器本地。Gemini 也可改用环境变量 `GEMINI_API_KEY`。

## 一次提问如何处理

教材正文只在切片这一步进入模型。

1. **入库。** 上传后在本地读取页数、书签或目录页，并探测文字层，结果写入 `uploads/books/<id>_toc.json`。这一步不调用模型，也不把 PDF 发到云端。目录按三层回退：原生书签、正文前部的印刷目录、按页数均匀分块。中文抽取使用 pdf.js 的 CMap。
2. **路由。** 只把目录树交给较快的模型；模型不可用时退回本地关键词匹配。目录文本限制在 1,200 token 以内。
3. **切片。** 用 pdf-lib 从原文件截出目标页，单次不超过 30 页、25,000 token。Gemini 收到这段微型 PDF。OpenAI 兼容接口先由 pdf.js 抽成纯文本，再放进普通文本请求。
4. **输出。** 回答经 SSE 返回，每 15 秒一帧保活。瞬时失败会重试。前端若 90 秒没有新内容会断开，并可以手动停止。Markdown 转 LaTeX 时配对列表环境、保护数学区间并转义特殊字符。

教材留在 `uploads/books/`（已加入 `.gitignore`），重启后仍然在。超过 15 MB 的文件按 6 MB 分块上传，单文件上限 60 MB。

## 目录

```
server.ts                  HTTP 路由
server/pipeline/           入库、路由、切片与作答
server/pdf/                文档读取、目录、切片、本地索引
server/providers/          Gemini 与 OpenAI 兼容接口
server/budget.ts           页数与 token 上限
server/sse.ts              流式输出与保活
src/                       答疑、LaTeX 预览、源码页
```

## 运行

需要 Node.js。需要本机编译 PDF 时再安装 XeLaTeX：

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

- 没有文字层的扫描版抽不出正文。纯文本模型会收到提示；这类书需要换成能直接阅读 PDF 的模型。本地没有 OCR。
- 抽成纯文本后，公式变成线性字符，表格和版面信息会丢失。
- 流式中断后不能从已输出的位置续写。
- 加密或结构异常的 PDF 可能无法建立目录索引。
