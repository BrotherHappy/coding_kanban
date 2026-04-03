# 安装与快速启动

这份文档面向第一次接触 `coding_kanban` 的用户，目标是让你**尽快安装并跑起来**。

如果你只想先看到页面，直接看下面的 **5 分钟快速开始**。

---

## 5 分钟快速开始

### 1. 准备环境

必需：

- Node.js：建议使用较新的 LTS 或当前稳定版
- pnpm：仓库当前使用 `pnpm@10.13.1`

可选但强烈建议：

- `tmux`：如果你要使用 tmux 创建、连接、恢复、扫描
- `ssh` 客户端：如果你要接入远端主机
- `openssl`：如果你要使用默认 HTTPS 开发模式

### 2. 克隆并安装依赖

```bash
git clone <your-repo-url>
cd coding_kanban
pnpm install
```

### 3. 一键启动

```bash
./scripts/restart-dev.sh
```

启动成功后，脚本会打印：

- 前端访问地址
- 局域网访问地址（可用时）
- 后端健康检查地址：`http://127.0.0.1:4000/api/health`

### 4. 打开页面

在浏览器中打开脚本输出的前端地址即可。

默认情况下：

- 前端：`https://localhost:3000`
- 后端：`http://127.0.0.1:4000`

---

## 安装要求

### 必需

#### Node.js

建议使用较新的 LTS 或当前稳定版本。仓库当前依赖 `node-pty@1.2.0-beta.12`，在较新的 Node 版本上更稳。

#### pnpm

建议安装与仓库一致的主版本：

```bash
npm install -g pnpm@10
```

### 可选依赖

#### tmux

macOS:

```bash
brew install tmux
```

Debian / Ubuntu:

```bash
sudo apt update
sudo apt install -y tmux openssh-client openssl
```

Fedora / RHEL:

```bash
sudo dnf install -y tmux openssh-clients openssl
```

---

## 推荐启动方式

### 方式一：`restart-dev.sh`（推荐）

```bash
./scripts/restart-dev.sh
```

这个脚本会自动帮你：

- 清理旧的开发进程
- 启动后端
- 启动前端
- 默认启用 HTTPS
- 生成或复用自签证书
- 打印最终可访问地址

适合：

- 第一次启动
- 本地开发
- 局域网调试
- 避免端口冲突

### 方式二：分别启动

如果你想自己控制前后端：

```bash
pnpm --filter server dev
pnpm --filter web dev
```

### 方式三：并发启动

```bash
pnpm dev
```

适合熟悉仓库结构的开发者。

---

## 常用命令

```bash
pnpm dev          # 并发启动前后端
pnpm dev:restart  # 用脚本清端口并重启
pnpm build        # 构建 shared/server/web
pnpm check        # 类型检查 + 生产构建
pnpm test         # 运行所有 workspace test 脚本
pnpm e2e          # 运行 Playwright E2E（自动拉起独立测试前后端）
pnpm format       # 格式化整个仓库
```

### 关于 `pnpm e2e`

现在的 `pnpm e2e` 会自动：

- 分配独立空闲端口
- 启动一套专用 backend / frontend
- 注入 Playwright 所需环境变量
- 跑完后自动清理

所以通常你**不需要先手动启动前后端**，就能直接跑 E2E。

---

## 第一次打开后可以做什么

### 新建一个本地会话

1. 点击顶部“新建会话”
2. 选择目标主机（通常选“本机”）
3. 填写显示名、类型、工作目录
4. 选择“直接创建”或“从 tmux 创建”
5. 点击“创建会话”

### 扫描已有 tmux / 会话

1. 点击顶部“扫描 tmux”或“扫描会话”
2. 选择本机或 SSH 主机
3. 输入目录
4. 在扫描结果里接入、恢复或连接

### 观察一个本地 VS Code 窗口

1. 点击顶部“添加 VS Code 窗口”
2. 选择要观察的窗口
3. 宫格里会新增一个观察卡片

---

## SSH 远端接入（可选）

如果你要管理远端主机，请在 `~/.ssh/config` 里先准备好主机：

```sshconfig
Host hm24
  HostName 10.30.0.24
  User your-user
  Port 10022
```

应用会自动把这些 Host 展示出来。

---

## HTTPS 说明

默认开发脚本会启用 HTTPS，这是为了更好兼容浏览器安全上下文需求（尤其是窗口捕获等能力）。

如果只是本机临时调试，你也可以关闭：

```bash
WEB_HTTPS=0 ./scripts/restart-dev.sh
```

如果你要让局域网内其他设备访问，建议保持 HTTPS 开启：

```bash
WEB_HTTPS=1 ./scripts/restart-dev.sh
```

---

## 常见问题

### 1. 页面打不开

先检查后端健康状态：

```bash
curl http://127.0.0.1:4000/api/health
```

再重新启动：

```bash
./scripts/restart-dev.sh
```

### 2. 看不到 SSH 主机

检查：

- `~/.ssh/config` 是否存在
- 是否写了明确的 `Host` 条目

### 3. tmux 功能不可用

检查：

- 本机是否安装了 tmux
- tmux 是否在 `PATH` 中

如果 tmux 不在标准路径，可以显式指定：

```bash
TMUX_BINARY=/your/path/to/tmux ./scripts/restart-dev.sh
```

### 4. 浏览器提示证书不受信任

这是开发环境自签证书的正常表现。首次访问时手动信任即可。

---

## 推荐的首次验证流程

安装完之后，建议你按这个顺序确认：

```bash
pnpm install
./scripts/restart-dev.sh
pnpm test
pnpm check
pnpm e2e
```

如果这几步都通过，说明本地环境已经基本可用了。
