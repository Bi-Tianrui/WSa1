#!/usr/bin/env bash
# ==============================================================================
# 理工科教材伴读助手 (STEM Textbook Companion) - Ubuntu 原生一键启动脚本
# 功能: 自动检查环境、创建/激活虚拟环境 .venv、安装依赖、启动应用并自动打开浏览器
# ==============================================================================

set -e

# ANSI 终端彩色输出
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}==============================================================${NC}"
echo -e "${BLUE}    📚 理工科教材伴读助手 (STEM Companion) - 启动器           ${NC}"
echo -e "${BLUE}==============================================================${NC}"

# 获取脚本所在根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. 检测系统 Python 3 环境
echo -e "${YELLOW}[1/5] 检查系统 Python3 环境...${NC}"
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}错误: 未检测到 python3。请先在终端运行:${NC}"
    echo -e "  sudo apt update && sudo apt install -y python3 python3-pip python3-venv"
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1)
echo -e "${GREEN}✓ 已检测到: ${PYTHON_VERSION}${NC}"

# 2. 检查或自动创建 .venv 虚拟环境
echo -e "${YELLOW}[2/5] 检查 Python 虚拟环境 (.venv)...${NC}"
if [ ! -d ".venv" ]; then
    echo -e "正在创建虚拟环境 .venv..."
    if ! python3 -m venv .venv; then
        echo -e "${RED}错误: 创建虚拟环境失败，可能缺少 python3-venv 模块。请运行:${NC}"
        echo -e "  sudo apt update && sudo apt install -y python3-venv"
        exit 1
    fi
    echo -e "${GREEN}✓ 虚拟环境 .venv 创建成功！${NC}"
else
    echo -e "${GREEN}✓ 检测到已存在的虚拟环境 .venv${NC}"
fi

# 3. 激活虚拟环境
echo -e "${YELLOW}[3/5] 激活虚拟环境...${NC}"
source .venv/bin/activate
echo -e "${GREEN}✓ 当前环境 Python: $(which python)${NC}"

# 4. 安装/校验依赖项 (requirements.txt)
echo -e "${YELLOW}[4/6] 正在安装并同步项目依赖包...${NC}"
pip install --upgrade pip -q

if [ -f "requirements.txt" ]; then
    echo "正在根据 requirements.txt 安装依赖 (streamlit, google-generativeai 等)..."
    pip install -r requirements.txt -q
    echo -e "${GREEN}✓ 所有依赖安装/验证完毕！${NC}"
else
    echo -e "${RED}警告: 未找到 requirements.txt 文件。${NC}"
fi

# 5. 检查系统 XeLaTeX 编译引擎环境
echo -e "${YELLOW}[5/6] 检查 LaTeX 实时编译环境 (XeLaTeX)...${NC}"
if command -v xelatex &> /dev/null; then
    XELATEX_INFO=$(xelatex --version 2>&1 | head -n 1)
    echo -e "${GREEN}✓ 已就绪: ${XELATEX_INFO}${NC}"
else
    echo -e "${YELLOW}提示: 未在系统中检测到 xelatex。${NC}"
    echo -e "${BLUE}  如需启用原生离线 LaTeX 编译与高清 PDF 渲染，可在 Ubuntu 终端运行:${NC}"
    echo -e "  sudo apt update && sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra"
    echo -e "${YELLOW}  (注: 未安装时不影响教材伴读对话、公式渲染与 .tex 源码导出)${NC}"
fi

# 6. 启动 Streamlit 服务并自动调用 xdg-open 打开浏览器
PORT=8501
HOST="localhost"
APP_URL="http://${HOST}:${PORT}"

echo -e "${YELLOW}[6/6] 准备启动桌面级伴读 Web 应用...${NC}"
echo -e "${GREEN}服务地址: ${APP_URL}${NC}"

# 在后台启动一个延迟自动打开浏览器的子进程
(
    # 等待 Streamlit 启动就绪
    sleep 2
    if command -v xdg-open &> /dev/null; then
        echo -e "${BLUE}正在调用 Ubuntu 默认浏览器 (xdg-open) 访问应用...${NC}"
        xdg-open "$APP_URL" > /dev/null 2>&1 || true
    elif command -v sensible-browser &> /dev/null; then
        sensible-browser "$APP_URL" > /dev/null 2>&1 || true
    else
        echo -e "${YELLOW}提示: 未检测到 xdg-open，请在浏览器中手动访问: ${APP_URL}${NC}"
    fi
) &

echo -e "${GREEN}==============================================================${NC}"
echo -e "${GREEN}   ✨ 伴读助手已就绪！请按 Ctrl+C 可停止运行服务              ${NC}"
echo -e "${GREEN}==============================================================${NC}"

# 启动 Streamlit 应用 (保持前台运行)
exec streamlit run app.py \
    --server.port="$PORT" \
    --server.address="0.0.0.0" \
    --browser.serverAddress="$HOST" \
    --browser.gatherUsageStats=false \
    --theme.base="light" \
    --theme.primaryColor="#2563eb"
