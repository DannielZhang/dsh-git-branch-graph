# Git 分支图（DSH 插件）

在开发任务中，为最近项目的只读 Git 分支图预留右侧布局轨道，对话列随之向左移动；同一会话涉及多个项目时提供项目切换。

## 行为

- 从会话工作目录以及最近的开发工具 `workdir`、文件路径识别项目。
- 根据用户开发请求或实际开发工具调用判断开发任务；不向模型发送额外提示，也不增加模型请求。
- 面板默认占用右侧布局轨道：首次展开宽度约 30% 窗口（上限 460px），对话列向左移动而不是与面板一起挤压；右侧栏的原生拖拽条可继续调整宽度，面板会跟随轨道。窄容器会隐藏哈希/日期并优先保留分支标签和提交标题。
- 收起面板会释放轨道；如果用户已经展开过右侧栏，则不再抢占轨道，面板退回浮动模式。右侧栏全屏或侧栏抽屉打开时面板隐藏。
- 一个会话可以同时跟踪多个项目：会话工作区、开发工具的 `workdir`/文件路径、`run_code` 内部命令，以及用户消息中的绝对路径都会形成候选项目；Host 会把候选目录归一化到实际 Git 仓库根，去重后按最近使用排序。面板顶部出现项目切换条，并自动跳到最近被修改的项目，最多保留 6 个。
- 远端项目也会被发现：从 `run_code`/`bash` 命令中的 `ssh` 调用、或本地 SSH 包装脚本（例如 `rssh.sh`）解析连接信息与远端路径，再通过同一条 SSH 连接执行固定的只读 Git 命令。远端项目只读展示，不提供仓库创建/推送；主机不可达时显示错误并允许重试。SSH 使用 BatchMode、严格主机密钥检查，且不会执行对话中的任意远端 shell。
- 每轮结束自动刷新；切换项目时自动展开新仓库；可随时折叠或手动刷新。
- 最多显示 80 个提交，包含拓扑连线、本地/远程分支、标签和 HEAD。
- 非 Git 目录显示“还未创建 Git，是否进行创建？”及创建入口；空仓库显示空状态；读取失败提供重试。
- 创建向导提供目录浏览器：列出下一级文件夹，支持上一级、回到工作区根目录和刷新；进入目录时自动预览文件，再填写 Git 身份和项目/仓库名，初始化仓库并创建首个提交。
- 若选择的是已经 `git init`、但还没有首个提交的仓库，向导会预览现有暂存/未跟踪文件，并在同一次操作中创建首个提交，再继续推送。
- 选择 GitHub/Gitee 时会自动发现并优先使用本机凭据：Git credential helper、`~/.git-credentials`、GitHub CLI (`~/.config/gh/hosts.yml`) 和 `GH_TOKEN`/`GITHUB_TOKEN`/`GITEE_TOKEN` 环境变量；有多个账号时显示下拉选择，找不到时才要求手动输入 Token。
- 本机凭据只在 Host 内存中存在，浏览器只收到账号和来源，不会收到 Token；切换平台会自动重新发现对应凭据并选中默认账号。
- 支持仅本地、推送到已有 `origin`、填写自建/已有仓库 URL，或新建 GitHub/Gitee 仓库并推送。
- 首个提交上限为 5000 个文件、单文件 20 MiB、总计 100 MiB；默认通过 `.git/info/exclude` 排除 `.env`、密钥、`node_modules`、虚拟环境、缓存和日志。暂存后还会强制检查路径，即使项目 `.gitignore` 用取反规则重新纳入这些文件，也会从首个提交中移除或拒绝提交。

## 安全与边界

Git 由 Host 的 `subprocess` 服务直接执行，不经过 shell。只读分支图仅运行 `rev-parse`、`symbolic-ref` 和 `log`。仓库操作只接受当前会话工作区内、经过 `realpath` 校验的相对子目录；不允许绝对路径、`..` 或符号链接逃逸。

Personal Access Token 仅保存在浏览器表单状态和单次请求内存中，不会写入磁盘、`.git/config`、remote URL 或命令行参数；推送时通过临时 `GIT_CONFIG_*` 环境配置作为 HTTP 认证头使用。Token 不记录日志，也不在响应中回显；后续推送不会复用该 Token，需要使用系统 Git 凭证或 SSH。自建/已有仓库支持 HTTPS、SSH 或 scp 风格地址，拒绝 `file:`、`ext:`、`http:`、查询参数、URL 内密码等不安全远端；已有 `origin` 的 fetch/push URL 也会做同样校验。

初始化和提交会拒绝 `.git` 符号链接、指向工作区外的 gitdir、以及 `objects`/`refs`/`hooks`/`info/exclude`/`config` 符号链接。实际初始化在项目内的临时目录完成，再把 `.git` 原子移入项目，并在移动前后复核目录 inode 和真实路径。提交和推送使用 `--no-verify`，并通过临时 `core.hooksPath` 指向空目录，避免项目或全局钩子读取 Token。

仓库远端会校验实际 fetch/push URL 的数量和协议；新建或修改 origin 后会清除旧 pushurl，并重新解析生效 URL，拒绝 `url.*.insteadOf` 等配置把安全 URL 重定向到外部。暂存后会再次强制检查受保护路径；即使 `.gitignore` 用取反规则重新纳入 `.env` 或 `.env/` 目录，也会从首个提交移除，无法安全移除时拒绝提交。创建向导通过 portal 渲染到应用最上层，避免被右侧栏浮动窗格遮挡。

仓库创建与首次提交是显式破坏性操作：向导在提交前显示文件数量、总大小和示例文件，超过上限会拒绝；已有仓库存在未提交改动时不会自动提交。空仓库会在同一次操作中预览现有文件并创建首个提交，不需要先手动提交。此流程不会自动创建 `.gitignore`，除非用户勾选；安全排除规则写入仓库本地 `.git/info/exclude`。

Host 端依赖当前 DSH 的 `sessionProjections`、`sessions`、`subprocess`、`connection` 服务。前端通过 `shell.overlay` 渲染面板，用 `conversation.input.dock` 中一个不可见的锚点测量对话列与右侧轨道，并通过 `ctx.layout.openRightbar` / `closeRightbar` 预留或释放右侧轨道；它只响应主对话，不会因子对话输入框而移动。插件面向 DSH 0.2.2-rc.3 的 API 实现。

## 文件

- `projection.js`：从持久会话事件推导开发状态、本地/远端项目候选和刷新版本。
- `git.js`：有超时和输出上限的本地及 SSH 只读 Git 读取。
- `remote.js`：SSH 命令/包装脚本解析与远端项目识别。
- `repo.js`：项目预览、Git 初始化、首个提交、远端创建与推送。
- `credentials.js`：Host 内存中的本机 GitHub/Gitee 凭据发现。
- `index.js`：注册投影、项目列表、分支图、仓库预览、目录浏览、凭据和仓库操作路由。
- `client.js`：本地化、可折叠/停靠面板、项目切换和 SVG 分支图。
- `market/index.json`：可选的自建 DSH 插件市场索引。
- `docs/`：市场详情页与预览图。

## 检查

```sh
npm run check
```

测试不需要安装 npm 依赖，覆盖会话折叠、Git 日志解析、图布局，以及带分支和合并提交的临时真实仓库。

## 安装

在 DSH 的 **Plugins → Add plugin** 中选择此目录，或使用插件管理工具安装此本地 bundle。也可以安装 Git bundle：

```sh
git+https://github.com/DannielZhang/dsh-git-branch-graph.git
```

安装后打开一个开发会话即可看到面板；历史会话需要其 Host 会话处于打开状态。

## 插件市场索引

DSH 没有官方公共索引；`market/index.json` 是一个可自托管的自定义索引。推送到 GitHub 后，在 **Plugins → Discover → Custom plugin indexes** 添加：

```text
https://raw.githubusercontent.com/DannielZhang/dsh-git-branch-graph/main/market/index.json
```

当前索引固定到 Git commit，详情页使用 `meta.detail` 与 `docs/preview.svg`。发布新版本时需同步更新 `package.json` 版本、索引版本与 commit，具体步骤见 [`market/README.md`](market/README.md)。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
