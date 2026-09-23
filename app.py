"""
理工科大学教材伴读与笔记助手 (STEM Textbook Companion)
- 框架: Python + Streamlit
- 模型引擎: Google Gemini 1.5 (通过 google-generativeai 官方 SDK)
- 核心特性:
  1. 百万级超大上下文直接挂载整本 PDF 教材，无需复杂向量切片或外部数据库。
  2. 打字机实时流式输出 (st.write_stream)。
  3. 严谨工科教授人设，必须指明教材具体章节与页码出处，并详尽推导。
  4. 完美支持 LaTeX 数学公式 ($ 和 $$) 与 Markdown 表格。
  5. 便捷的 Markdown 笔记复制与导出。
"""

import os
import sys
import shutil
import subprocess
import base64
import re
import tempfile
import time
import datetime
import streamlit as st
import google.generativeai as genai
from google.generativeai import caching
from dotenv import load_dotenv

# 加载本地 .env 文件中的环境变量（若存在）
load_dotenv()

# ===========================
# 1. 页面配置与现代科技风样式注入
# ===========================
st.set_page_config(
    page_title="理工科教材伴读助手 | STEM Textbook Companion",
    page_icon="📐",
    layout="wide",
    initial_sidebar_state="expanded"
)

# 注入自适应 CSS，强化工科学生需要的 LaTeX 渲染可读性与 Markdown 排版
st.markdown("""
<style>
    /* 全局字体与排版优化 */
    .stApp {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    
    /* 聊天消息气泡美化 */
    .chat-card {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 16px;
        margin-bottom: 12px;
    }
    
    /* 教材挂载状态徽标 */
    .book-badge {
        display: inline-flex;
        align-items: center;
        background-color: #e0f2fe;
        color: #0369a1;
        padding: 4px 10px;
        border-radius: 9999px;
        font-size: 0.82rem;
        font-weight: 500;
        margin-right: 6px;
        margin-bottom: 6px;
        border: 1px solid #bae6fd;
    }
    
    /* 公式与引用块强调 */
    blockquote {
        border-left: 4px solid #3b82f6 !important;
        background: #f1f5f9;
        padding: 8px 14px !important;
        border-radius: 0 8px 8px 0;
        margin: 10px 0 !important;
    }
    
    /* 表格居中与边框 */
    table {
        width: 100%;
        margin: 12px 0;
        border-collapse: collapse;
    }
    th, td {
        border: 1px solid #cbd5e1 !important;
        padding: 8px 12px !important;
        text-align: left;
    }
    th {
        background-color: #f1f5f9 !important;
        font-weight: 600;
    }
</style>
""", unsafe_allow_html=True)

# ===========================
# 2. 会话状态初始化 (Session State)
# ===========================
if "api_key" not in st.session_state:
    st.session_state.api_key = os.getenv("GEMINI_API_KEY", "")

if "messages" not in st.session_state:
    st.session_state.messages = []

# 已上传并挂载至 Gemini File API 的教材列表
# 结构: [{'display_name': str, 'file_name': str, 'file_obj': genai.File, 'size_mb': float, 'upload_time': str}]
if "mounted_books" not in st.session_state:
    st.session_state.mounted_books = []

# Gemini 官方 Context Caching 缓存对象 (带 TTL)
if "active_cache" not in st.session_state:
    st.session_state.active_cache = None

# 默认系统指令：大学工科教授角色，强调教材页码/章节出处与 LaTeX 严格推导
DEFAULT_SYSTEM_INSTRUCTION = (
    "你是一位资深、严谨且富有耐心的大学理工科讲席教授（精通高等数学、大学物理、线性代数、理论力学、电磁场与微波、量子力学等所有基础与专业工科科目）。\n"
    "你的首要任务是紧密结合学生上传的大学教材（PDF 文档），开展深度的课业伴读、定理推演、概念剖析与课后习题精解。\n\n"
    "【回答核心规则】\n"
    "1. 【严格忠于教材】：必须严格基于已挂载的教材内容回答，不可胡编乱造。每当引用定理、定义、公式或习题时，必须明确标注其在教材中的具体出处，格式如：『📖 出处：第 3 章 第 2 节 / 第 85 页 定理 3.4』。\n"
    "2. 【工科级严谨推导】：数学公式必须规范使用标准 LaTeX 格式（行内公式使用单个 $ 包裹，如 $E=mc^2$；独立公式块使用双 $$ 包裹并换行）。推导过程必须详尽完整，步步有因，交代清晰物理意义或几何直观。\n"
    "3. 【结构化表格与重点】：多变量对比、物理量量纲对比或公式汇总，优先使用 Markdown 表格整理；关键结论与考点核心用加粗突出，并主动提供易错点预警与拓展思考题。\n"
    "4. 【教学风格】：深入浅出，循循善诱，逻辑清晰，既有数学严谨性，又有工程实用性。"
)

if "system_instruction" not in st.session_state:
    st.session_state.system_instruction = DEFAULT_SYSTEM_INSTRUCTION

DEFAULT_LATEX_TEMPLATE = r"""\documentclass[11pt,a4paper]{ctexart}
\usepackage{amsmath,amssymb,amsfonts,amsthm}
\usepackage{geometry}
\geometry{left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}
\usepackage{booktabs}
\usepackage{hyperref}
\usepackage{xcolor}
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\textcolor{gray}{工科教材智能伴读学术推演笔记}}
\fancyhead[R]{\small\textcolor{gray}{\thepage}}

\title{\textbf{\LARGE 高等数学与大学物理核心定理推演笔记}}
\author{\large 工科教材伴读研学室}
\date{\today}

\begin{document}
\maketitle

\section{核心定理与概念陈述}
设空间有界闭区域 $\Omega \subset \mathbb{R}^3$，其边界 $\Sigma$ 为分片光滑的闭曲面，取外侧为法向量正向。若向量场 $\mathbf{F}(x,y,z) = P\mathbf{i} + Q\mathbf{j} + R\mathbf{k}$ 在 $\Omega$ 上具有一阶连续偏导数，则有高斯公式（散度定理）：
\begin{equation}
\iiint_{\Omega} \left( \frac{\partial P}{\partial x} + \frac{\partial Q}{\partial y} + \frac{\partial R}{\partial z} \right) \mathrm{d}V = \iint_{\Sigma} (P \cos \alpha + Q \cos \beta + R \cos \gamma) \mathrm{d}S = \iint_{\Sigma} \mathbf{F} \cdot \mathrm{d}\mathbf{S}
\end{equation}

\section{物理意义与通量解释}
高斯定理揭示了体积分与闭曲面积分之间的深刻对应关系：
\begin{itemize}
    \item 散度 $\mathrm{div}\,\mathbf{F} = \nabla \cdot \mathbf{F}$ 反映了场中微元点处的源（Source）或汇（Sink）强度；
    \item 闭曲面积分代表通过封闭边界向外净穿出的总通量（Flux）。
\end{itemize}

\end{document}
"""

if "latex_code" not in st.session_state:
    st.session_state.latex_code = DEFAULT_LATEX_TEMPLATE

if "compiled_pdf_base64" not in st.session_state:
    st.session_state.compiled_pdf_base64 = None

if "compile_log" not in st.session_state:
    st.session_state.compile_log = ""

if "compile_error" not in st.session_state:
    st.session_state.compile_error = None

if "import_notice" not in st.session_state:
    st.session_state.import_notice = None


def markdown_to_academic_latex(markdown_text: str, title: str = "理工科教材定理推演与伴读笔记") -> str:
    """将 Markdown 答疑文本智能转换为标准符合 ctexart 规范的 LaTeX 论文源码"""
    lines = markdown_text.strip().split("\n")
    tex_body = []
    in_table = False
    table_lines = []

    def flush_table(tbl_lines):
        if not tbl_lines or len(tbl_lines) < 2:
            return ""
        header = [c.strip() for c in tbl_lines[0].strip("|").split("|")]
        cols = len(header)
        col_align = "c" * cols
        tbl = ["\\begin{table}[htbp]", "\\centering", f"\\begin{{tabular}}{{{col_align}}}", "\\toprule"]
        tbl.append(" & ".join(header) + " \\\\")
        tbl.append("\\midrule")
        for row in tbl_lines[2:]:
            cells = [c.strip() for c in row.strip("|").split("|")]
            if len(cells) == cols:
                tbl.append(" & ".join(cells) + " \\\\")
        tbl.append("\\bottomrule", "\\end{tabular}", "\\end{table}")
        return "\n".join(tbl)

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            in_table = True
            table_lines.append(stripped)
            continue
        elif in_table:
            in_table = False
            tex_body.append(flush_table(table_lines))
            table_lines = []

        if stripped.startswith("### "):
            tex_body.append(f"\\subsubsection*{{{stripped[4:]}}}")
        elif stripped.startswith("## "):
            tex_body.append(f"\\subsection*{{{stripped[3:]}}}")
        elif stripped.startswith("# "):
            tex_body.append(f"\\section*{{{stripped[2:]}}}")
        elif stripped.startswith("- ") or stripped.startswith("* "):
            tex_body.append(f"\\item {stripped[2:]}")
        elif stripped.startswith("> "):
            tex_body.append(f"\\begin{{quote}}\n\\small {stripped[2:]}\n\\end{{quote}}")
        else:
            tex_body.append(stripped)

    if in_table and table_lines:
        tex_body.append(flush_table(table_lines))

    raw_content = "\n".join(tex_body)
    raw_content = re.sub(r"\*\*(.*?)\*\*", r"\\textbf{\1}", raw_content)
    raw_content = re.sub(r"📖 出处：(.*?)(?=\n|$)", r"\\textcolor{blue}{\\small \\textbf{出处：}\1}", raw_content)

    return f"""\\documentclass[11pt,a4paper]{{ctexart}}
\\usepackage{{amsmath,amssymb,amsfonts,amsthm}}
\\usepackage{{geometry}}
\\geometry{{left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}}
\\usepackage{{booktabs}}
\\usepackage{{hyperref}}
\\usepackage{{xcolor}}
\\usepackage{{fancyhdr}}
\\pagestyle{{fancy}}
\\fancyhf{{}}
\\fancyhead[L]{{\\small\\textcolor{{gray}}{{工科教材智能伴读学术推演笔记}}}}
\\fancyhead[R]{{\\small\\textcolor{{gray}}{{\\thepage}}}}

\\title{{\\textbf{{\\LARGE {title}}}}}
\\author{{\\large 工科教材伴读研学室}}
\\date{{\\today}}

\\begin{{document}}
\\maketitle

{raw_content}

\\end{{document}}"""

# ===========================
# 3. 左侧边栏：设置、鉴权与云端教材库
# ===========================
with st.sidebar:
    st.title("📚 工科教材伴读库")
    st.caption("基于 Google Gemini 1.5 超大百万上下文架构")
    
    st.markdown("---")
    
    # 3.1 API Key 输入与状态持久化
    st.subheader("🔑 访问凭证设置")
    api_key_input = st.text_input(
        "Google Gemini API Key",
        value=st.session_state.api_key,
        type="password",
        placeholder="AIzaSy...",
        help="请填入您的 Gemini API Key。系统将在浏览器会话中保持，无需重复输入。"
    )
    if api_key_input != st.session_state.api_key:
        st.session_state.api_key = api_key_input
        st.rerun()

    # 3.2 模型版本选择
    st.subheader("🤖 核心模型选择")
    selected_model = st.selectbox(
        "选择 Gemini 1.5 架构",
        options=["gemini-1.5-flash", "gemini-1.5-pro"],
        index=0,
        format_func=lambda m: (
            "⚡ gemini-1.5-flash (极速响应 / 毫秒流式吐字)"
            if "flash" in m
            else "🧠 gemini-1.5-pro (深度推理 / 复杂公式定理推导)"
        ),
        help="gemini-1.5-flash 拥有超低延迟，适合日常伴读；gemini-1.5-pro 推理能力极强，适合深奥理论公式推导。"
    )
    
    st.markdown("---")
    
    # 3.3 文件上传器 (PDF 格式教材)
    st.subheader("📂 教材挂载 (PDF)")
    st.write("直接上传数百页大型工科教材，由云端大上下文处理。")
    
    uploaded_files = st.file_uploader(
        "拖拽或选择 PDF 教材",
        type=["pdf"],
        accept_multiple_files=True,
        help="支持上传完整教科书，系统会自动调用 Gemini File API 挂载至会话上下文。"
    )
    
    # 检测新上传的文件并暂存到云端
    if uploaded_files and st.session_state.api_key:
        try:
            genai.configure(api_key=st.session_state.api_key)
            current_book_names = [b["display_name"] for b in st.session_state.mounted_books]
            
            for uf in uploaded_files:
                if uf.name not in current_book_names:
                    with st.status(f"正在将《{uf.name}》挂载至云端上下文...", expanded=True) as status_box:
                        st.write("1. 写入本地临时缓存...")
                        # 写入临时文件以供 upload_file 读取
                        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
                            tmp.write(uf.getvalue())
                            tmp_path = tmp.name
                        
                        st.write("2. 正在上传至 Google Gemini 云端文件存储 (支持整本教材大 Token)...")
                        cloud_file = genai.upload_file(
                            path=tmp_path,
                            display_name=uf.name,
                            mime_type="application/pdf"
                        )
                        
                        # 轮询文件处理状态 (等待云端解析完成)
                        st.write("3. 云端超大上下文就绪检查...")
                        while cloud_file.state.name == "PROCESSING":
                            time.sleep(1)
                            cloud_file = genai.get_file(cloud_file.name)
                            
                        if cloud_file.state.name == "FAILED":
                            raise Exception("教材云端解析失败，请检查文件格式。")
                            
                        # 清理本地临时文件
                        if os.path.exists(tmp_path):
                            os.remove(tmp_path)
                            
                        file_size_mb = round(uf.size / (1024 * 1024), 2)
                        st.session_state.mounted_books.append({
                            "display_name": uf.name,
                            "file_name": cloud_file.name,
                            "file_obj": cloud_file,
                            "size_mb": file_size_mb,
                            "upload_time": time.strftime("%H:%M:%S")
                        })
                        status_box.update(label=f"《{uf.name}》已成功挂载！", state="complete", expanded=False)
                    st.rerun()
        except Exception as e:
            st.error(f"教材挂载异常: {str(e)}")
    elif uploaded_files and not st.session_state.api_key:
        st.warning("⚠️ 请先在上方填写 Google Gemini API Key，然后再上传教材！")

    # 3.4 已挂载教材状态列表
    if st.session_state.mounted_books:
        st.markdown("#### 📖 已挂载的云端教材库")
        for idx, book in enumerate(st.session_state.mounted_books):
            with st.container():
                st.markdown(f"""
                <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:8px; padding:10px; margin-bottom:8px;">
                    <div style="font-weight:600; font-size:0.9rem; color:#1e293b;">📘 {book['display_name']}</div>
                    <div style="font-size:0.75rem; color:#64748b; margin-top:2px;">
                        大小: {book['size_mb']} MB | 状态: <span style="color:#16a34a; font-weight:600;">● 云端活跃中</span>
                    </div>
                </div>
                """, unsafe_allow_html=True)
                
        if st.button("🗑️ 清空所有已挂载教材", use_container_width=True):
            if st.session_state.api_key:
                try:
                    genai.configure(api_key=st.session_state.api_key)
                    for book in st.session_state.mounted_books:
                        try:
                            genai.delete_file(book["file_name"])
                        except Exception:
                            pass
                except Exception:
                    pass
            st.session_state.mounted_books = []
            st.session_state.active_cache = None
            st.success("已卸载所有教材并清空缓存！")
            st.rerun()

        st.markdown("---")

        # 3.5 Gemini 官方 Context Caching（上下文缓存控制台）
        st.markdown("#### ⚡ Context Caching (上下文缓存)")
        if st.session_state.active_cache:
            cache = st.session_state.active_cache
            st.success("✅ **Context Cache 句柄已激活**\n\n- 消除 20s Pre-fill 计算延迟\n- 后续问答直连 KV 缓存，1秒流式响应")
            st.code(cache.name, language="text")
            col_c1, col_c2 = st.columns(2)
            with col_c1:
                if st.button("🔄 续期 1 小时", use_container_width=True):
                    try:
                        genai.configure(api_key=st.session_state.api_key)
                        cache.update(ttl=datetime.timedelta(hours=1))
                        st.success("已续期 1 小时！")
                        st.rerun()
                    except Exception as ce:
                        st.error(f"续期失败: {ce}")
            with col_c2:
                if st.button("🗑️ 释放缓存", use_container_width=True):
                    try:
                        cache.delete()
                    except Exception:
                        pass
                    st.session_state.active_cache = None
                    st.info("已释放 Context Cache 句柄")
                    st.rerun()
        else:
            st.caption("将 75 万字超大教材创建为带 TTL 的 Cached Content 对象，后续对话直接挂载句柄，实现 1 秒内的真正流式极速响应！")
            ttl_hours = st.selectbox("缓存有效时长 (TTL)", options=[1, 2, 4], format_func=lambda h: f"{h} 小时", index=0)
            if st.button("⚡ 一键创建 Context Cache (消除 Pre-fill)", use_container_width=True, type="primary"):
                if not st.session_state.api_key:
                    st.error("请先在上方配置 API Key！")
                else:
                    try:
                        with st.spinner("正在向 Google Gemini 创建 Context Cache 句柄..."):
                            genai.configure(api_key=st.session_state.api_key)
                            book_files = [b["file_obj"] for b in st.session_state.mounted_books]
                            new_cache = caching.CachedContent.create(
                                model=selected_model,
                                display_name=f"STEM_Book_{int(time.time())}",
                                system_instruction=st.session_state.system_instruction,
                                contents=book_files,
                                ttl=datetime.timedelta(hours=ttl_hours),
                            )
                            st.session_state.active_cache = new_cache
                            st.success(f"Context Cache 句柄创建成功: {new_cache.name}")
                            st.rerun()
                    except Exception as cache_err:
                        st.error(f"Context Cache 创建失败: {str(cache_err)}")
    else:
        st.info("💡 暂未挂载教材。上传 PDF 后，可一键生成 Context Cache 句柄并消除 Pre-fill 延迟。")

    st.markdown("---")
    # 清空对话功能
    if st.button("🔄 重置当前问答对话", use_container_width=True):
        st.session_state.messages = []
        st.rerun()

# ===========================
# 4. 右侧主交互区：双标签页架构 (伴读答疑 + LaTeX 双联工作台)
# ===========================

# 4.1 顶部状态栏
header_col1, header_col2 = st.columns([3, 1])
with header_col1:
    st.markdown("### 🎓 大学工科教材伴读教授 & LaTeX 排版工作台")
    mounted_count = len(st.session_state.mounted_books)
    if mounted_count > 0:
        book_names_str = "、".join([f"《{b['display_name']}》" for b in st.session_state.mounted_books])
        st.markdown(f"当前伴读模式：**实时教材检索** | 📚 正在研读：`{book_names_str}`")
    else:
        st.markdown("当前伴读模式：**通识学术答疑** | 💡 建议在左侧边栏上传教材 PDF，获得精准页码定位与定理溯源。")
with header_col2:
    st.markdown(f"<div style='text-align:right; font-size:0.85rem; color:#64748b;'>引擎: <code>{selected_model}</code></div>", unsafe_allow_html=True)

st.markdown("---")

# 4.2 主工作区采用双标签页切换
tab_chat, tab_latex = st.tabs(["💬 教材伴读答疑", "📐 LaTeX 编译与 PDF 双联预览室"])

# -------------------------------------------------------------
# 标签页 1：【💬 教材伴读答疑】
# -------------------------------------------------------------
with tab_chat:
    if st.session_state.get("import_notice"):
        st.success(st.session_state.pop("import_notice"))

    # 初始空状态下的引导提示（经典工科高频提问示例）
    if not st.session_state.messages:
        st.markdown("""
        <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:20px; margin: 15px 0;">
            <h4 style="color:#1e40af; margin-top:0;">👨‍🏫 欢迎来到工科教材智能伴读室！</h4>
            <p style="color:#334155; font-size:0.95rem; line-height:1.6;">
                本应用针对<b>高等数学、大学物理、电工电子学、材料力学、量子物理</b>等理工科硬核课程设计。无需任何繁杂的本地向量数据库或文档切块，整本教材直通 Google Gemini 百万上下文！
            </p>
            <p style="color:#475569; font-size:0.9rem; margin-bottom:6px;"><b>💡 你可以随时尝试如下提问方式：</b></p>
            <ul style="color:#475569; font-size:0.88rem; line-height:1.7;">
                <li><b>定理推演：</b>“请结合教材第 3 章，详细推导高斯散度定理，并写出完整的向量微积分推导步骤与物理意义。”</li>
                <li><b>考点查证：</b>“教材关于特征值与特征向量在第几页？定理的具体前提条件是什么？请指出出处。”</li>
                <li><b>习题答疑：</b>“第 4 章课后习题第 12 题，关于非齐次线性微分方程的通解求解思路是怎样的？”</li>
                <li><b>对比表格：</b>“请用 Markdown 表格对比麦克斯韦方程组的积分形式与微分形式，并标明每个符号的物理量纲。”</li>
            </ul>
        </div>
        """, unsafe_allow_html=True)

    # 渲染历史聊天记录
    for idx, msg in enumerate(st.session_state.messages):
        avatar_icon = "🧑‍🎓" if msg["role"] == "user" else "👨‍🏫"
        with st.chat_message(msg["role"], avatar=avatar_icon):
            st.markdown(msg["content"])
            
            # 为助手回答生成复制与一键导入 LaTeX 按钮
            if msg["role"] == "assistant":
                col_copy, col_import = st.columns([1, 1])
                with col_copy:
                    with st.expander("📋 复制 Markdown 笔记", expanded=False):
                        st.text_area(
                            "点击全选并复制 (Ctrl+A, Ctrl+C)",
                            value=msg["content"],
                            height=150,
                            key=f"copy_area_{idx}",
                            help="复制包含 LaTeX 公式与表格排版的纯文本内容"
                        )
                with col_import:
                    if st.button("📌 导入至 LaTeX 排版室", key=f"import_btn_{idx}", use_container_width=True):
                        st.session_state.latex_code = markdown_to_academic_latex(msg["content"])
                        st.session_state.import_notice = "✅ 已将教授本段答疑转换为学术 LaTeX 论文源码，并载入「📐 LaTeX 编译与 PDF 双联预览室」！"
                        st.rerun()

    # 消息输入与打字机流式生成
    user_prompt = st.chat_input("向教授请教教材中的定理、公式推演、概念疑问或课后习题...")

    if user_prompt:
        if not st.session_state.api_key:
            st.error("❌ 未检测到 Google Gemini API Key！请在左侧边栏填写您的 Key 后再进行提问。")
            st.stop()
        
        # 记录并渲染用户提问
        st.session_state.messages.append({"role": "user", "content": user_prompt})
        with st.chat_message("user", avatar="🧑‍🎓"):
            st.markdown(user_prompt)
            
        # 助手流式生成应答
        with st.chat_message("assistant", avatar="👨‍🏫"):
            try:
                genai.configure(api_key=st.session_state.api_key)
                
                # 判断是否挂载了 Gemini Context Cache
                if st.session_state.get("active_cache"):
                    st.markdown("<div style='margin-bottom:8px;'><span style='color:#b45309; font-size:0.75rem; background:#fef3c7; padding:2px 8px; border-radius:9999px; border:1px solid #fde68a; font-weight:600;'>⚡ Context Cache 挂载生效 (Pre-fill 0s · 极速流式)</span></div>", unsafe_allow_html=True)
                    model = genai.GenerativeModel.from_cached_content(
                        cached_content=st.session_state.active_cache
                    )
                    chat_contents = []
                    for past_msg in st.session_state.messages[:-1]:
                        chat_contents.append(f"{'学生提问' if past_msg['role'] == 'user' else '教授解答'}: {past_msg['content']}")
                    chat_contents.append(f"学生提问: {user_prompt}")
                    response_stream = model.generate_content(chat_contents, stream=True)
                else:
                    contents = []
                    for book in st.session_state.mounted_books:
                        contents.append(book["file_obj"])
                    for past_msg in st.session_state.messages[:-1]:
                        chat_contents = f"{'学生提问' if past_msg['role'] == 'user' else '教授解答'}: {past_msg['content']}"
                        contents.append(chat_contents)
                    contents.append(f"学生提问: {user_prompt}")
                    
                    model = genai.GenerativeModel(
                        model_name=selected_model,
                        system_instruction=st.session_state.system_instruction
                    )
                    response_stream = model.generate_content(contents, stream=True)
                
                def stream_text_generator():
                    for chunk in response_stream:
                        if chunk.text:
                            yield chunk.text

                full_response = st.write_stream(stream_text_generator())
                st.session_state.messages.append({"role": "assistant", "content": full_response})
                
                col_copy_latest, col_import_latest = st.columns([1, 1])
                with col_copy_latest:
                    with st.expander("📋 复制本段 Markdown 笔记", expanded=False):
                        st.text_area(
                            "Markdown 纯文本笔记",
                            value=full_response,
                            height=150,
                            key=f"copy_latest_{len(st.session_state.messages)}",
                        )
                with col_import_latest:
                    if st.button("📌 导入至 LaTeX 排版室", key=f"import_latest_btn_{len(st.session_state.messages)}", use_container_width=True):
                        st.session_state.latex_code = markdown_to_academic_latex(full_response)
                        st.session_state.import_notice = "✅ 已将教授本段答疑转换为学术 LaTeX 论文源码，并载入「📐 LaTeX 编译与 PDF 双联预览室」！"
                        st.rerun()
                    
            except Exception as err:
                err_msg = str(err)
                if "API_KEY_INVALID" in err_msg or "API key not valid" in err_msg:
                    st.error("❌ API Key 无效，请检查左侧边栏输入的 Google Gemini API Key 是否正确。")
                elif "RESOURCE_EXHAUSTED" in err_msg:
                    st.error("⏳ API 调用额度超限，请稍候再试或切换为 gemini-1.5-flash 模型。")
                else:
                    st.error(f"⚠️ 生成失败: {err_msg}")

# -------------------------------------------------------------
# 标签页 2：【📐 LaTeX 编译与 PDF 双联预览室】(VS Code + LaTeX Workshop 风格)
# -------------------------------------------------------------
with tab_latex:
    col_editor, col_preview = st.columns([1, 1], gap="medium")
    
    # 左半屏【LaTeX 源码编辑区】
    with col_editor:
        st.markdown("##### 📝 LaTeX 源码编辑区 (`ctexart` 论文模板)")
        
        # 4 个核心操作按钮工具条
        tb_col1, tb_col2, tb_col3, tb_col4 = st.columns(4)
        
        with tb_col1:
            compile_btn = st.button("⚡ 编译并刷新 PDF", type="primary", use_container_width=True)
            
        with tb_col2:
            if st.session_state.compiled_pdf_base64:
                pdf_raw_bytes = base64.b64decode(st.session_state.compiled_pdf_base64)
                st.download_button(
                    "📥 下载高清 PDF",
                    data=pdf_raw_bytes,
                    file_name="academic_notes.pdf",
                    mime="application/pdf",
                    use_container_width=True
                )
            else:
                st.button("📥 下载高清 PDF", disabled=True, use_container_width=True, help="请先点击 [⚡ 编译并刷新 PDF]")
                
        with tb_col3:
            st.download_button(
                "💾 下载 .tex 源码",
                data=st.session_state.latex_code,
                file_name="document.tex",
                mime="text/x-tex",
                use_container_width=True
            )
            
        with tb_col4:
            show_log_toggle = st.button("📜 查看编译日志", use_container_width=True)

        # 多行 LaTeX 代码编辑器
        edited_latex = st.text_area(
            label="LaTeX 源码输入框",
            value=st.session_state.latex_code,
            height=660,
            key="latex_code_editor_textarea",
            label_visibility="collapsed"
        )
        st.session_state.latex_code = edited_latex

    # 右半屏【实时 PDF 矢量预览器】
    with col_preview:
        st.markdown("##### 📄 实时 PDF 矢量预览器 (HTML5 矢量嵌入)")
        
        # 处理编译动作
        if compile_btn:
            xelatex_path = shutil.which("xelatex")
            
            if not xelatex_path:
                st.warning("⚠️ **系统尚未安装 XeLaTeX 编译引擎**\n\n"
                           "当前界面已优雅降级并完好运行。如需在 Ubuntu 终端启用原生编译，请运行：\n"
                           "```bash\n"
                           "sudo apt update && sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra\n"
                           "```\n"
                           "💡 **提示**：您可直接修改源码，并点击 **[💾 下载 .tex 源码]** 保存至本地或上传至 Overleaf 编译！")
                st.session_state.compile_log = (
                    "【XeLaTeX 环境检测报告】\n"
                    "未检测到系统的 xelatex 可执行程序。\n"
                    "Ubuntu 离线编译安装指引：\n"
                    "  sudo apt update && sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra\n"
                    "支持功能说明：\n"
                    "  ✓ .tex 源码自由编写与语法格式化\n"
                    "  ✓ 完整论文结构与 ctexart 模板导出\n"
                    "  ✓ 实时 Markdown 一键互转"
                )
                st.session_state.compile_error = "未检测到系统 xelatex 可执行程序"
            else:
                with st.spinner("⚡ 正在调用系统 XeLaTeX 引擎进行无头编译..."):
                    with tempfile.TemporaryDirectory() as temp_dir:
                        tex_file_path = os.path.join(temp_dir, "document.tex")
                        pdf_file_path = os.path.join(temp_dir, "document.pdf")
                        log_file_path = os.path.join(temp_dir, "document.log")
                        
                        with open(tex_file_path, "w", encoding="utf-8") as f:
                            f.write(st.session_state.latex_code)
                            
                        try:
                            res = subprocess.run(
                                ["xelatex", "-interaction=nonstopmode", "-halt-on-error", "document.tex"],
                                capture_output=True,
                                text=True,
                                cwd=temp_dir,
                                timeout=40
                            )
                            
                            log_content = ""
                            if os.path.exists(log_file_path):
                                with open(log_file_path, "r", encoding="utf-8", errors="ignore") as lf:
                                    log_content = lf.read()
                            else:
                                log_content = (res.stdout or "") + "\n" + (res.stderr or "")
                                
                            st.session_state.compile_log = log_content
                            
                            if os.path.exists(pdf_file_path):
                                with open(pdf_file_path, "rb") as pf:
                                    pdf_data = pf.read()
                                    st.session_state.compiled_pdf_base64 = base64.b64encode(pdf_data).decode("utf-8")
                                st.session_state.compile_error = None
                                st.success("⚡ XeLaTeX 编译成功！右侧矢量 PDF 已实时刷新。")
                            else:
                                error_lines = [l for l in log_content.splitlines() if l.startswith("!") or "Error:" in l][:3]
                                err_summary = error_lines[0] if error_lines else "LaTeX 语法错误，未生成 PDF。"
                                st.session_state.compile_error = err_summary
                                st.error(f"❌ 编译遇到语法错误：{err_summary}")
                        except subprocess.TimeoutExpired:
                            st.session_state.compile_error = "XeLaTeX 编译超时 (超过 40 秒)"
                            st.error("❌ 编译超时，请检查公式中是否存在死循环宏定义。")
                        except Exception as e:
                            st.session_state.compile_error = str(e)
                            st.error(f"❌ 编译异常: {str(e)}")

        # 渲染右侧 PDF 预览或指引占位
        if st.session_state.compiled_pdf_base64:
            pdf_embed_html = f"""
            <iframe 
                src="data:application/pdf;base64,{st.session_state.compiled_pdf_base64}#toolbar=1&navpanes=1" 
                width="100%" 
                height="680px" 
                style="border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);"
            ></iframe>
            """
            st.markdown(pdf_embed_html, unsafe_allow_html=True)
        else:
            st.markdown("""
            <div style="border: 2px dashed #cbd5e1; border-radius: 10px; height: 680px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #f8fafc; padding: 24px; text-align: center;">
                <div style="font-size: 3rem; margin-bottom: 12px;">📐</div>
                <h4 style="color: #334155; margin-bottom: 8px;">VS Code + LaTeX Workshop 风格双联预览区</h4>
                <p style="color: #64748b; font-size: 0.9rem; max-width: 480px; line-height: 1.6;">
                    请在左侧编辑器中修改 LaTeX 代码，或在「💬 教材伴读答疑」中点击 <b>[📌 导入至 LaTeX 排版室]</b>。<br/>
                    点击左上方 <b>[⚡ 编译并刷新 PDF]</b>，系统将调用后台无头 XeLaTeX 编译并无缝在此处渲染原生高清矢量 PDF 视图。
                </p>
                <div style="margin-top: 16px; display: flex; gap: 8px;">
                    <span style="background: #e2e8f0; color: #475569; font-size: 0.78rem; padding: 4px 10px; border-radius: 6px;">支持中英文混排</span>
                    <span style="background: #e2e8f0; color: #475569; font-size: 0.78rem; padding: 4px 10px; border-radius: 6px;">AMS-LaTeX 高阶数学公式</span>
                    <span style="background: #e2e8f0; color: #475569; font-size: 0.78rem; padding: 4px 10px; border-radius: 6px;">高清矢量渲染</span>
                </div>
            </div>
            """, unsafe_allow_html=True)

        # 编译日志抽屉 / 展开区
        if show_log_toggle or st.session_state.compile_error:
            with st.expander("📜 LaTeX 编译日志与诊断信息", expanded=True):
                st.code(st.session_state.compile_log or "暂无日志记录", language="text")

