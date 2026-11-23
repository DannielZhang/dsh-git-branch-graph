window.__ModuleLoader__.load({
  id: '@local/dsh-git-branch-graph',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = React
    const NS = 'gitBranchGraph'
    const ROW_HEIGHT = 46
    const LANE_WIDTH = 22
    const GRAPH_LEFT = 16
    // The line colors come from semantic theme tokens so light and dark themes
    // each receive their own contrast-calibrated palette.
    const COLORS = [
      'var(--dsh-gbg-branch-1)', 'var(--dsh-gbg-branch-2)', 'var(--dsh-gbg-branch-3)',
      'var(--dsh-gbg-branch-4)', 'var(--dsh-gbg-branch-5)',
    ]
    const HIDDEN_UNAVAILABLE = new Set(['not-development', 'no-project', 'session-not-live'])
    const EMPTY_PROJECTION = undefined

    function noopSubscribe() {
      return () => {}
    }

    function createExternalStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of listeners) listener()
        },
      }
    }

    function sameGeometry(left, right) {
      if (left === null || right === null) return left === right
      return left.left === right.left && left.right === right.right && left.top === right.top
        && left.bottom === right.bottom && left.width === right.width && left.height === right.height
        && left.contentWidth === right.contentWidth && left.viewportWidth === right.viewportWidth
    }

    /** Position the floating panel in the conversation's right gutter, or hide it when the gutter is too narrow. */
    function computeFloatingLayout(geometry, collapsed, viewportWidth) {
      if (geometry === null) return null
      const width = geometry.viewportWidth ?? viewportWidth
      const contentRight = geometry.left + (geometry.width + geometry.contentWidth) / 2
      const available = Math.min(340, geometry.right - 16 - (contentRight + 40))
      if (!Number.isFinite(available) || available < 160) return null
      return {
        top: Math.round(geometry.top + 16),
        right: Math.round(Math.max(16, width - geometry.right + 16)),
        width: Math.round(collapsed ? Math.min(220, available) : available),
        maxHeight: Math.max(160, Math.round(geometry.height - 32)),
      }
    }

    function useProjectionSnapshot(sessionId, getProjectionFace) {
      const face = useMemo(
        () => sessionId === undefined ? undefined : getProjectionFace(sessionId),
        [sessionId, getProjectionFace],
      )
      const subscribe = useMemo(
        () => face === undefined ? noopSubscribe : listener => face.subscribe(listener),
        [face],
      )
      const getSnapshot = useMemo(
        () => face === undefined ? () => EMPTY_PROJECTION : () => face.getSnapshot(),
        [face],
      )
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    const zh = {
      title: 'Git 分支图',
      expand: '展开 Git 分支图',
      collapse: '收起 Git 分支图',
      refresh: '刷新分支图',
      refreshing: '正在刷新分支图',
      loading: '正在读取仓库分支…',
      empty: '这个仓库还没有提交。',
      error: '无法读取 Git 分支图。',
      gitUnavailable: '未找到可用的 Git，无法读取分支图。',
      retry: '重试',
      commits: '{count} 个提交',
      commitOne: '1 个提交',
      truncated: '仅显示最近 {count} 个提交',
      truncatedOne: '仅显示最近 1 个提交',
      detached: 'HEAD 已分离',
      branch: '当前分支 {name}',
      moreRefs: '还有 {count} 个引用',
      repository: '仓库 {path}',
      gitMissing: '还未创建 Git，是否进行创建？',
      createGit: '创建 Git 仓库',
      manageRepo: '创建或管理 Git 仓库',
      repoWizardTitle: '创建 Git 仓库',
      manageWizardTitle: 'Git 仓库管理',
      close: '关闭',
      currentWorkspace: '当前工作区：{path}',
      projectSubdir: '项目子目录',
      projectSubdirHint: '浏览并进入要初始化的目录',
      preview: '预览',
      previewing: '正在预览…',
      previewFailed: '无法预览这个目录。',
      browseUp: '上一级',
      browseRoot: '工作区根目录',
      browseRefresh: '刷新目录',
      browseFailed: '无法读取目录列表。',
      browseLoading: '正在读取目录…',
      noSubdirectories: '没有可进入的子目录。',
      directoriesTruncated: '仅显示前 {count} 个子目录。',
      currentDirectory: '当前目录（将在其中创建 Git 仓库）',
      workspaceRootName: '工作区根目录',
      tooManyFiles: '文件过多（{count} 个，上限 {limit} 个）。请选择更小的子目录，或先添加 .gitignore。',
      tooManyFilesUnknown: '目录内容过多，无法安全预览。请选择更小的子目录。',
      totalTooLarge: '文件总大小 {size}，超过上限 {limit}。',
      fileTooLarge: '单个文件 {file} 为 {size}，超过上限 {limit}。',
      readyToCreate: '将提交 {count} 个文件，共 {size}。',
      noFiles: '没有可提交的文件。',
      ignoredHint: '默认排除 .env、密钥、node_modules、虚拟环境、缓存和日志；规则写入 .git/info/exclude，提交前还会强制检查暂存内容。',
      sampleFiles: '示例文件',
      existingRepo: '已是 Git 仓库',
      existingBranch: '分支 {name}',
      existingCommits: '{count} 个提交',
      existingDirty: '有 {count} 个未提交改动，不会被自动提交。',
      existingEmpty: '现有仓库尚无提交；确认下面选项后将自动创建首个提交。',
      remotes: '现有远端',
      noRemotes: '没有配置远端',
      projectName: '项目名称',
      repoName: '远端仓库名',
      authorName: 'Git 作者名',
      authorEmail: 'Git 作者邮箱',
      authorHint: '写入当前仓库的本地 Git 配置；留空则使用全局配置。',
      createGitignore: '如果缺少 .gitignore，创建基础版本',
      destination: '仓库目标',
      destNone: '仅创建本地仓库',
      destExisting: '推送到现有 origin',
      destGithub: 'GitHub 新建仓库并推送',
      destGitee: 'Gitee 新建仓库并推送',
      destCustom: '自建或已有仓库 URL',
      token: 'Personal Access Token',
      tokenHint: '需要仓库创建与推送权限；仅在本次请求的内存中使用，不保存，也不写入 .git/config。后续推送请使用系统 Git 凭证。',
      visibility: '可见性',
      public: '公开',
      private: '私有',
      remoteUrl: '远程仓库 URL',
      remoteUrlHint: 'HTTPS 或 SSH；不要包含用户名或密码。',
      createAndPush: '创建并推送',
      createLocal: '初始化并提交',
      createFirstCommit: '创建首个提交',
      pushExisting: '推送到 origin',
      pushRemote: '配置远端并推送',
      working: '正在创建并推送…',
      createdLocal: '本地仓库已创建，首个提交完成。',
      createdFirstCommit: '首个提交已创建。',
      pushed: '已推送 {branch} 到 {url}',
      createdRemote: '远端仓库已创建。',
      done: '完成',
      errorGeneric: '操作失败。',
      errorBlocked: '项目内容超过安全限制，请选择更小的子目录。',
      errorToken: 'Token 无效或权限不足。',
      errorRemoteExists: '远端仓库已存在，请更换名称，或改用“自建或已有仓库 URL”。',
      errorPush: '推送失败，请检查远端权限或凭证。',
      errorIdentity: '请填写有效的 Git 作者名和邮箱。',
      errorNoFiles: '没有可提交的文件。',
      errorRepoEmpty: '现有仓库没有可用的首个提交。',
      errorBusy: '已有仓库操作正在进行，请稍后重试。',
      errorUnsafeGitDir: '项目中的 .git 指向了工作区外部，已拒绝操作。',
      errorUnsafeFiles: '检测到受保护的文件（如 .env 或密钥）仍被暂存，已拒绝提交。',
      errorRemoteUrl: '远程仓库 URL 不安全或格式不受支持。',
      errorRemoteMissing: '当前仓库没有可推送的 origin 远端。',
      errorBodyTooLarge: '请求内容过大，已拒绝。',
      errorRemoteCreate: '创建远端仓库失败，请检查 Token 权限或仓库名称。',
      errorInvalidPath: '项目目录必须位于当前工作区内。',
      errorDirectoryMissing: '项目目录不存在。',
      errorUnsafePath: '该目录包含受保护的敏感路径，不能作为仓库根目录。',
      partialRemote: '远端仓库已创建，但后续操作失败。',
      partialLocal: '本地仓库已初始化，但后续步骤失败。',
      limits: '上限：{files} 个文件 / {size}',
      sampleMore: '还有 {count} 个文件…',
      tokenRequired: '请输入所选平台的 Personal Access Token。',
      repoNameRequired: '请输入远端仓库名称。',
      remoteUrlRequired: '请输入远程仓库 URL。',
    }
    const en = {
      title: 'Git branch graph',
      expand: 'Expand Git branch graph',
      collapse: 'Collapse Git branch graph',
      refresh: 'Refresh branch graph',
      refreshing: 'Refreshing branch graph',
      loading: 'Reading repository branches…',
      empty: 'This repository has no commits yet.',
      error: 'Could not read the Git branch graph.',
      gitUnavailable: 'Git is unavailable, so the branch graph cannot be read.',
      retry: 'Retry',
      commits: '{count} commits',
      commitOne: '1 commit',
      truncated: 'Showing only the latest {count} commits',
      truncatedOne: 'Showing only the latest commit',
      detached: 'Detached HEAD',
      branch: 'Current branch {name}',
      moreRefs: '{count} more refs',
      repository: 'Repository {path}',
      gitMissing: 'Git has not been created yet. Create it now?',
      createGit: 'Create Git repository',
      manageRepo: 'Create or manage Git repository',
      repoWizardTitle: 'Create Git repository',
      manageWizardTitle: 'Git repository settings',
      close: 'Close',
      currentWorkspace: 'Current workspace: {path}',
      projectSubdir: 'Project subdirectory',
      projectSubdirHint: 'Browse into the directory to initialize',
      preview: 'Preview',
      previewing: 'Previewing…',
      previewFailed: 'Could not preview this directory.',
      browseUp: 'Up one level',
      browseRoot: 'Workspace root',
      browseRefresh: 'Refresh directory',
      browseFailed: 'Could not read the directory list.',
      browseLoading: 'Reading directory…',
      noSubdirectories: 'No subdirectories to open.',
      directoriesTruncated: 'Showing the first {count} subdirectories.',
      currentDirectory: 'Current directory (the repository will be created here)',
      workspaceRootName: 'Workspace root',
      tooManyFiles: 'Too many files ({count}; limit {limit}). Choose a smaller subdirectory or add .gitignore first.',
      tooManyFilesUnknown: 'This directory is too large to preview safely. Choose a smaller subdirectory.',
      totalTooLarge: 'Total size is {size}, above the {limit} limit.',
      fileTooLarge: 'A single file, {file}, is {size}, above the {limit} limit.',
      readyToCreate: '{count} files will be committed, {size} total.',
      noFiles: 'There are no files to commit.',
      ignoredHint: '.env, keys, node_modules, virtual environments, caches, and logs are excluded by default; rules are written to .git/info/exclude and staged content is checked again before commit.',
      sampleFiles: 'Example files',
      existingRepo: 'Already a Git repository',
      existingBranch: 'Branch {name}',
      existingCommits: '{count} commits',
      existingDirty: '{count} uncommitted changes will not be committed automatically.',
      existingEmpty: 'This repository has no commit yet; the first commit will be created when you continue.',
      remotes: 'Existing remotes',
      noRemotes: 'No remote configured',
      projectName: 'Project name',
      repoName: 'Remote repository name',
      authorName: 'Git author name',
      authorEmail: 'Git author email',
      authorHint: 'Saved in this repository’s local Git config; leave blank to use global config.',
      createGitignore: 'Create a basic .gitignore if one is missing',
      destination: 'Repository destination',
      destNone: 'Create local repository only',
      destExisting: 'Push to the existing origin',
      destGithub: 'Create a GitHub repository and push',
      destGitee: 'Create a Gitee repository and push',
      destCustom: 'Self-hosted or existing repository URL',
      token: 'Personal access token',
      tokenHint: 'Needs repository creation and push permission. Used only in this request’s memory; not saved or written to .git/config. Later pushes use your system Git credentials.',
      visibility: 'Visibility',
      public: 'Public',
      private: 'Private',
      remoteUrl: 'Remote repository URL',
      remoteUrlHint: 'HTTPS or SSH; do not include a username or password.',
      createAndPush: 'Create and push',
      createLocal: 'Initialize and commit',
      createFirstCommit: 'Create the first commit',
      pushExisting: 'Push to origin',
      pushRemote: 'Configure remote and push',
      working: 'Creating and pushing…',
      createdLocal: 'The local repository was created and its first commit completed.',
      createdFirstCommit: 'The first commit was created.',
      pushed: 'Pushed {branch} to {url}',
      createdRemote: 'The remote repository was created.',
      done: 'Done',
      errorGeneric: 'The operation failed.',
      errorBlocked: 'The project exceeds the safety limits. Choose a smaller subdirectory.',
      errorToken: 'The token is invalid or lacks permission.',
      errorRemoteExists: 'The remote repository already exists. Choose another name or use a self-hosted/existing URL.',
      errorPush: 'Push failed. Check remote permissions or credentials.',
      errorIdentity: 'Enter a valid Git author name and email.',
      errorNoFiles: 'There are no files to commit.',
      errorRepoEmpty: 'The existing repository has no usable first commit.',
      errorBusy: 'Another repository operation is already running. Try again shortly.',
      errorUnsafeGitDir: 'The project’s .git points outside the workspace, so the operation was refused.',
      errorUnsafeFiles: 'Protected files such as .env or keys remained staged, so the commit was refused.',
      errorRemoteUrl: 'The remote repository URL is unsafe or unsupported.',
      errorRemoteMissing: 'This repository has no origin remote to push to.',
      errorBodyTooLarge: 'The request body is too large and was refused.',
      errorRemoteCreate: 'Could not create the remote repository. Check the token permission or repository name.',
      errorInvalidPath: 'The project directory must stay inside the current workspace.',
      errorDirectoryMissing: 'The project directory does not exist.',
      errorUnsafePath: 'A protected directory cannot be used as the repository root.',
      partialRemote: 'The remote repository was created, but a later step failed.',
      partialLocal: 'The local repository was initialized, but a later step failed.',
      limits: 'Limits: {files} files / {size}',
      sampleMore: '{count} more files…',
      tokenRequired: 'Enter a personal access token for the selected provider.',
      repoNameRequired: 'Enter a remote repository name.',
      remoteUrlRequired: 'Enter a remote repository URL.',
    }

    const CSS = `
      .dsh-gbg-root{position:fixed;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;min-height:0;overflow:hidden;container-type:inline-size;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-panel);backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);--dsh-gbg-branch-1:var(--dsw-alias-state-business-primary);--dsh-gbg-branch-2:var(--dsw-alias-state-done-primary);--dsh-gbg-branch-3:color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, black);--dsh-gbg-branch-4:color-mix(in srgb, var(--dsw-alias-state-warn-label) 78%, black);--dsh-gbg-branch-5:var(--dsw-alias-state-error-primary)}
      body[data-ds-dark-theme] .dsh-gbg-root{--dsh-gbg-branch-3:var(--dsw-alias-state-success-primary);--dsh-gbg-branch-4:var(--dsw-alias-state-warn-label)}
      .dsh-gbg-header{display:flex;align-items:center;gap:6px;min-height:38px;padding:5px 8px 5px 10px}
      .dsh-gbg-disclosure{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-sm)}
      .dsh-gbg-disclosure:hover .dsh-gbg-title{color:var(--dsw-alias-label-primary-bluish)}
      .dsh-gbg-disclosure:focus-visible,.dsh-gbg-icon-button:focus-visible,.dsh-gbg-retry:focus-visible{outline-style:solid;outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-width:var(--dsw-focus-ring-width,2px);outline-offset:2px}
      .dsh-gbg-branch-icon{display:grid;place-items:center;flex:none;width:18px;height:24px;color:var(--dsw-alias-label-tertiary)}
      .dsh-gbg-title{flex:none;font-size:13px;line-height:24px;font-weight:550;color:var(--dsw-alias-label-primary)}
      .dsh-gbg-title-short{display:none;flex:none;font-size:12px;line-height:24px;font-weight:550;color:var(--dsw-alias-label-primary)}
      .dsh-gbg-project{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .dsh-gbg-current{flex:none;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dsh-gbg-chevron{display:grid;place-items:center;flex:none;color:var(--dsw-alias-label-tertiary)}
      .dsh-gbg-header-error{display:grid;place-items:center;flex:none;width:18px;height:18px;color:var(--dsw-alias-state-error-primary)}
      .dsh-gbg-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .dsh-gbg-icon-button{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .dsh-gbg-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dsh-gbg-icon-button:active:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill)}
      .dsh-gbg-icon-button:disabled{cursor:default;opacity:.55}
      .dsh-gbg-spinning svg{animation:dsh-gbg-spin .9s linear infinite}
      .dsh-gbg-body{display:flex;flex-direction:column;min-height:0;overflow:hidden;border-top:1px solid var(--dsw-alias-border-l1)}
      .dsh-gbg-status{display:flex;align-items:center;justify-content:center;gap:10px;min-height:92px;padding:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);text-align:center}
      .dsh-gbg-error{color:var(--dsw-alias-state-error-primary)}
      .dsh-gbg-retry{padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
      .dsh-gbg-retry:hover{background:var(--dsw-alias-button-tool-bar-hover)}
      .dsh-gbg-inline-error{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-state-error-primary)}
      .dsh-gbg-scroll{flex:1 1 auto;min-height:0;max-height:min(460px,60dvh);overflow:auto;overscroll-behavior:contain}
      .dsh-gbg-graph-inner{display:grid;align-items:start;min-width:100%}
      .dsh-gbg-edges{display:block;overflow:visible}
      .dsh-gbg-list{margin:0;padding:0;list-style:none;min-width:0}
      .dsh-gbg-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:46px;min-width:0;padding:4px 12px 4px 4px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}
      .dsh-gbg-row:last-child{border-bottom:0}
      .dsh-gbg-refs{display:flex;align-items:center;gap:4px;flex:none;max-width:46%;overflow:hidden}
      .dsh-gbg-ref{display:inline-block;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:18px}
      .dsh-gbg-ref-head{border-color:var(--dsw-alias-border-selected);color:var(--dsw-alias-label-primary-bluish)}
      .dsh-gbg-subject{min-width:80px;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
      .dsh-gbg-hash{flex:none;color:var(--dsw-alias-label-tertiary);font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace}
      .dsh-gbg-date{flex:none;width:82px;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:11px}
      .dsh-gbg-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dsh-gbg-root-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
      .dsh-gbg-count{flex:none;white-space:nowrap}
      .dsh-gbg-missing{flex-direction:column;gap:10px;color:var(--dsw-alias-label-secondary)}
      .dsh-gbg-create,.dsh-gbg-primary,.dsh-gbg-secondary{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:4px 12px;border-radius:var(--dsw-radius-md);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
      .dsh-gbg-create,.dsh-gbg-primary{border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-on-color)}
      .dsh-gbg-create:hover,.dsh-gbg-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
      .dsh-gbg-primary:disabled,.dsh-gbg-secondary:disabled,.dsh-gbg-create:disabled{cursor:default;opacity:.55}
      .dsh-gbg-secondary{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary)}
      .dsh-gbg-secondary:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover)}
      .dsh-gbg-modal-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 32%, transparent)}
      .dsh-gbg-modal{box-sizing:border-box;display:flex;flex-direction:column;width:min(580px,100%);max-height:calc(100dvh - 48px);overflow:hidden;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
      .dsh-gbg-modal-header{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .dsh-gbg-modal-title{flex:1 1 auto;min-width:0;font-size:15px;line-height:22px;font-weight:600}
      .dsh-gbg-modal-body{min-height:0;overflow:auto;padding:14px 16px 16px}
      .dsh-gbg-form{display:flex;flex-direction:column;gap:14px}
      .dsh-gbg-section{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg)}
      .dsh-gbg-section-title{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
      .dsh-gbg-row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
      .dsh-gbg-field{display:flex;flex-direction:column;gap:4px;min-width:0}
      .dsh-gbg-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
      .dsh-gbg-input,.dsh-gbg-select{box-sizing:border-box;width:100%;min-height:30px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
      .dsh-gbg-input:focus-visible,.dsh-gbg-select:focus-visible{outline-style:solid;outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-width:var(--dsw-focus-ring-width,2px);outline-offset:1px}
      .dsh-gbg-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
      .dsh-gbg-dirbrowser{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-card-fill)}
      .dsh-gbg-dirbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .dsh-gbg-dirbar .dsh-gbg-secondary{min-height:24px;padding:2px 8px;font-size:11px;line-height:16px}
      .dsh-gbg-dirpath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary)}
      .dsh-gbg-dirlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:3px;margin:0;padding:0;list-style:none;max-height:184px;overflow:auto}
      .dsh-gbg-dirrow{display:flex;align-items:center;gap:6px;width:100%;min-width:0;padding:4px 7px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
      .dsh-gbg-dirrow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dsh-gbg-dirrow:focus-visible{outline-style:solid;outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-width:var(--dsw-focus-ring-width,2px);outline-offset:1px}
      .dsh-gbg-diricon{display:grid;place-items:center;flex:none;color:var(--dsw-alias-label-tertiary)}
      .dsh-gbg-dirname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-gbg-preview{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-card-fill);font-size:12px;line-height:18px}
      .dsh-gbg-preview-ok{color:var(--dsw-alias-label-secondary)}
      .dsh-gbg-preview-error{color:var(--dsw-alias-state-error-primary)}
      .dsh-gbg-preview-warn{color:var(--dsw-alias-state-warn-label)}
      .dsh-gbg-preview-success{color:var(--dsw-alias-state-success-primary)}
      .dsh-gbg-sample{margin:2px 0 0;padding:0;list-style:none;max-height:96px;overflow:auto;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary)}
      .dsh-gbg-remotes{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
      .dsh-gbg-path-actions{display:flex;align-items:flex-end;gap:8px}
      .dsh-gbg-path-actions .dsh-gbg-field{flex:1 1 auto}
      .dsh-gbg-check{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dsh-gbg-check input{margin:3px 0 0;accent-color:var(--dsw-alias-state-business-primary)}
      .dsh-gbg-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:4px}
      .dsh-gbg-form-error{padding:8px 10px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap}
      .dsh-gbg-success{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .dsh-gbg-success-link{word-break:break-all;color:var(--dsw-alias-link)}
      .dsh-gbg-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      @media (max-width:640px){.dsh-gbg-modal-backdrop{padding:12px}.dsh-gbg-modal{max-height:calc(100dvh - 24px)}.dsh-gbg-row2{grid-template-columns:1fr}}
      @keyframes dsh-gbg-spin{to{transform:rotate(360deg)}}
      @container (max-width:260px){.dsh-gbg-project,.dsh-gbg-current,.dsh-gbg-date{display:none}.dsh-gbg-refs{max-width:44%}.dsh-gbg-header{gap:5px;padding-inline:8px 6px}}
      @container (max-width:210px){.dsh-gbg-hash,.dsh-gbg-title{display:none}.dsh-gbg-title-short{display:inline}.dsh-gbg-refs{max-width:45%}.dsh-gbg-subject{min-width:0}.dsh-gbg-row{gap:6px;padding-right:8px}.dsh-gbg-header{gap:4px;padding-inline:6px 4px}.dsh-gbg-header-error{width:12px;height:12px}.dsh-gbg-branch-icon{width:16px}}
      @media (max-width:640px){.dsh-gbg-current{display:none}.dsh-gbg-date{display:none}.dsh-gbg-refs{max-width:40%}.dsh-gbg-scroll{max-height:300px}}
      @media (max-width:480px){.dsh-gbg-hash{display:none}.dsh-gbg-refs{max-width:52%}.dsh-gbg-row{gap:6px}.dsh-gbg-title{font-size:12px}}
      @media (prefers-reduced-motion:reduce){.dsh-gbg-spinning svg{animation:none}}
    `

    function icon(kind, size = 16) {
      const common = {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }
      if (kind === 'branch') {
        return h('svg', common,
          h('circle', { cx: 6, cy: 4, r: 2 }),
          h('circle', { cx: 6, cy: 16, r: 2 }),
          h('circle', { cx: 14, cy: 6, r: 2 }),
          h('path', { d: 'M6 6v8M14 8v1c0 3-8 1-8 5' }))
      }
      if (kind === 'refresh') {
        return h('svg', common,
          h('path', { d: 'M16 7a7 7 0 1 0 .2 5' }),
          h('path', { d: 'M16 3v4h-4' }))
      }
      if (kind === 'alert') {
        return h('svg', common,
          h('path', { d: 'M10 3 18 17H2L10 3Z' }),
          h('path', { d: 'M10 8v4M10 14.5v.1' }))
      }
      if (kind === 'repo') {
        return h('svg', common,
          h('rect', { x: 3, y: 4, width: 14, height: 12, rx: 2 }),
          h('path', { d: 'M7 7v6M7 10h3a2 2 0 0 0 2-2V7' }),
          h('circle', { cx: 7, cy: 7, r: 1 }),
          h('circle', { cx: 7, cy: 13, r: 1 }))
      }
      if (kind === 'folder') {
        return h('svg', common,
          h('path', { d: 'M2.5 6.5A1.5 1.5 0 0 1 4 5h4l2 2h6a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-8Z' }))
      }
      return h('svg', common, h('path', { d: kind === 'up' ? 'm5 12 5-5 5 5' : 'm5 8 5 5 5-5' }))
    }

    function normalizeGraph(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid graph response')
      if (value.status === 'unavailable') return value
      if (value.status !== 'ok' && value.status !== 'empty') throw new Error('Invalid graph response')
      if (typeof value.root !== 'string' || typeof value.projectName !== 'string' || !Array.isArray(value.commits)) {
        throw new Error('Invalid graph response')
      }
      for (const commit of value.commits) {
        if (typeof commit?.hash !== 'string' || !Array.isArray(commit.parents) || !Array.isArray(commit.refs)
          || typeof commit.subject !== 'string' || typeof commit.date !== 'string' || typeof commit.author !== 'string') {
          throw new Error('Invalid commit response')
        }
      }
      return value
    }

    /** Assign parent-expectation lanes, then connect actual rendered nodes. */
    function layoutGraph(commits) {
      const lanes = []
      const rows = []
      const byHash = new Map()
      for (const commit of commits) {
        const matches = []
        lanes.forEach((expected, index) => { if (expected === commit.hash) matches.push(index) })
        let lane = matches[0]
        if (lane === undefined) {
          lane = lanes.findIndex(expected => expected === null)
          if (lane < 0) lane = lanes.length
        }
        while (lanes.length <= lane) lanes.push(null)
        for (const match of matches) lanes[match] = null
        lanes[lane] = commit.parents[0] ?? null
        for (const parent of commit.parents.slice(1)) {
          if (lanes.includes(parent)) continue
          let target = lanes.findIndex((expected, index) => expected === null && index !== lane)
          if (target < 0) {
            target = lanes.length
            lanes.push(null)
          }
          lanes[target] = parent
        }
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
        const row = { commit, lane, index: rows.length }
        rows.push(row)
        byHash.set(commit.hash, row)
      }
      const edges = []
      for (const row of rows) {
        for (const parent of row.commit.parents) {
          const target = byHash.get(parent)
          if (target === undefined) continue
          const x1 = GRAPH_LEFT + row.lane * LANE_WIDTH
          const y1 = row.index * ROW_HEIGHT + ROW_HEIGHT / 2
          const x2 = GRAPH_LEFT + target.lane * LANE_WIDTH
          const y2 = target.index * ROW_HEIGHT + ROW_HEIGHT / 2
          const d = x1 === x2
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${y1 + ROW_HEIGHT}, ${x2} ${y2 - ROW_HEIGHT}, ${x2} ${y2}`
          edges.push({ key: `${row.commit.hash}-${parent}`, d, color: COLORS[row.lane % COLORS.length] })
        }
      }
      return {
        rows,
        edges,
        laneCount: Math.max(1, ...rows.map(row => row.lane + 1)),
        graphWidth: GRAPH_LEFT * 2 + Math.max(0, Math.max(1, ...rows.map(row => row.lane + 1)) - 1) * LANE_WIDTH,
        height: rows.length * ROW_HEIGHT,
      }
    }

    function shortDate(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const locale = typeof document === 'undefined' ? undefined : document.documentElement.lang || undefined
      return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
    }

    function commitCountLabel(graph, t) {
      const count = graph.commits.length
      if (graph.truncated) return count === 1 ? t('truncatedOne') : t('truncated', { count })
      return count === 1 ? t('commitOne') : t('commits', { count })
    }

    const REPO_OVERRIDE_PREFIX = 'dsh.git-branch-graph.repo.'

    function readRepoOverride(sessionId, cwd) {
      try {
        const raw = localStorage.getItem(`${REPO_OVERRIDE_PREFIX}${sessionId}`)
        if (raw === null) return ''
        const value = JSON.parse(raw)
        return value?.cwd === cwd && typeof value.path === 'string' ? value.path : ''
      } catch {
        return ''
      }
    }

    function writeRepoOverride(sessionId, cwd, path) {
      try {
        localStorage.setItem(`${REPO_OVERRIDE_PREFIX}${sessionId}`, JSON.stringify({ cwd, path }))
      } catch {
        // A private browsing or storage failure keeps the in-memory override only.
      }
    }

    function pathBase(path) {
      const parts = String(path).split(/[\\/]+/).filter(Boolean)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
      if (bytes < 1024) return `${Math.round(bytes)} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
    }

    function defaultRepoName(name) {
      const value = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)
      return value === '' ? 'project' : value
    }

    function repoErrorText(error, t) {
      const code = error?.code
      if (code === 'blocked') return t('errorBlocked')
      if (code === 'token-invalid' || code === 'token-required') return t('errorToken')
      if (code === 'remote-exists') return t('errorRemoteExists')
      if (code === 'push-failed') return t('errorPush')
      if (code === 'identity-required' || code === 'invalid-identity' || code === 'identity-failed') return t('errorIdentity')
      if (code === 'no-files') return t('errorNoFiles')
      if (code === 'repository-empty') return t('errorRepoEmpty')
      if (code === 'action-busy') return t('errorBusy')
      if (code === 'git-unavailable') return t('gitUnavailable')
      if (code === 'unsafe-git-dir') return t('errorUnsafeGitDir')
      if (code === 'unsafe-files') return t('errorUnsafeFiles')
      if (code === 'invalid-remote-url' || code === 'remote-redirect') return t('errorRemoteUrl')
      if (code === 'unsafe-path') return t('errorUnsafePath')
      if (code === 'remote-missing') return t('errorRemoteMissing')
      if (code === 'body-too-large') return t('errorBodyTooLarge')
      if (code === 'invalid-path') return t('errorInvalidPath')
      if (code === 'directory-not-found') return t('errorDirectoryMissing')
      if (code === 'remote-create-failed' || code === 'remote-create-timeout') return t('errorRemoteCreate')
      return typeof error?.message === 'string' && error.message !== '' ? error.message : t('errorGeneric')
    }

    function CommitRow({ row }) {
      const { commit } = row
      const allRefs = [...(commit.head ? ['HEAD'] : []), ...commit.refs.filter(ref => ref !== 'HEAD')]
      const refs = allRefs.slice(0, 3)
      const remaining = allRefs.length - refs.length
      const details = `${commit.head ? 'HEAD\n' : ''}${commit.hash}\n${commit.author}\n${commit.date}\n\n${commit.subject}`
      return h('li', { className: 'dsh-gbg-row', title: details },
        allRefs.length > 0 && h('span', { className: 'dsh-gbg-refs' },
          refs.map(ref => h('span', {
            key: ref,
            className: `dsh-gbg-ref${ref === 'HEAD' ? ' dsh-gbg-ref-head' : ''}`,
            title: ref,
          }, ref)),
          remaining > 0 && h('span', { className: 'dsh-gbg-ref', title: allRefs.join(', ') }, `+${remaining}`)),
        h('span', { className: 'dsh-gbg-subject' }, commit.subject || commit.hash.slice(0, 7)),
        h('span', { className: 'dsh-gbg-hash' }, commit.hash.slice(0, 7)),
        h('span', { className: 'dsh-gbg-date' }, shortDate(commit.date)))
    }

    function Graph({ graph }) {
      const layout = useMemo(() => layoutGraph(graph.commits), [graph.commits])
      return h('div', { className: 'dsh-gbg-graph-inner', style: {
        width: '100%',
        gridTemplateColumns: `${layout.graphWidth}px minmax(0, 1fr)`,
      } },
        h('svg', {
          className: 'dsh-gbg-edges', width: layout.graphWidth, height: layout.height,
          viewBox: `0 0 ${layout.graphWidth} ${layout.height}`, 'aria-hidden': true,
        },
          layout.edges.map(edge => h('path', {
            key: edge.key, d: edge.d, fill: 'none', stroke: edge.color, strokeWidth: 1.8,
          })),
          layout.rows.map(row => {
            const cx = GRAPH_LEFT + row.lane * LANE_WIDTH
            const cy = row.index * ROW_HEIGHT + ROW_HEIGHT / 2
            const color = COLORS[row.lane % COLORS.length]
            return h('g', { key: row.commit.hash },
              row.commit.head && h('circle', { cx, cy, r: 6.5, fill: 'var(--dsw-specific-menu)', stroke: color, strokeWidth: 1.5 }),
              h('circle', { cx, cy, r: row.commit.head ? 3.5 : 4, fill: color },
                h('title', null, `${row.commit.hash}\n${row.commit.subject}`)))
          })),
        h('ol', { className: 'dsh-gbg-list' }, layout.rows.map(row => h(CommitRow, { key: row.commit.hash, row }))))
    }

    /**
     * Invisible session-scoped anchor that publishes the main Conversation's
     * body geometry. It refuses embedded composer occurrences so a subagent
     * conversation can never reposition the main panel.
     */
    function BranchGraphGeometry({ useSession, getMounted, subscribeMounted, geometryStore }) {
      const sessionId = useSession(snapshot => snapshot.sessionId)
      const mounted = useSyncExternalStore(subscribeMounted, getMounted, getMounted)
      const anchorRef = useRef(null)
      const probeRef = useRef(null)

      useEffect(() => {
        if (mounted !== sessionId) return undefined
        const anchor = anchorRef.current
        const probe = probeRef.current
        const body = anchor === null ? null : anchor.closest('[data-conversation-content]')
        if (body === null) {
          geometryStore.set(null)
          return undefined
        }
        let frame = null
        let last = null
        const covered = () => body.closest('[data-rightbar-fullscreen], [data-sidebar-drawer]') !== null
        const measure = () => {
          frame = null
          if (covered()) {
            if (last !== null) {
              last = null
              geometryStore.set(null)
            }
            return
          }
          const rect = body.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) {
            if (last !== null) {
              last = null
              geometryStore.set(null)
            }
            return
          }
          // Resolve the centered content width through a real layout box: a
          // custom property holding `clamp(...)` is not a parseable px token.
          const measured = probe === null ? 0 : probe.getBoundingClientRect().width
          const next = {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            contentWidth: measured > 0 ? Math.min(measured, rect.width) : Math.min(920, Math.max(0, rect.width - 32)),
            viewportWidth: window.innerWidth,
          }
          if (last === null || !sameGeometry(last, next)) {
            last = next
            geometryStore.set(next)
          }
        }
        const schedule = () => {
          if (frame === null) frame = requestAnimationFrame(measure)
        }
        measure()
        const observer = new ResizeObserver(schedule)
        observer.observe(body)
        window.addEventListener('resize', schedule)
        const root = body.parentElement
        const mutations = new MutationObserver(schedule)
        mutations.observe(body, { attributes: true, attributeFilter: ['style', 'class'] })
        if (root !== null) mutations.observe(root, { attributes: true, attributeFilter: ['style', 'class'] })
        const coverage = new MutationObserver(schedule)
        coverage.observe(document.body, {
          attributes: true, subtree: true, attributeFilter: ['data-rightbar-fullscreen', 'data-sidebar-drawer'],
        })
        return () => {
          observer.disconnect()
          mutations.disconnect()
          coverage.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame !== null) cancelAnimationFrame(frame)
          if (last !== null) geometryStore.set(null)
        }
      }, [mounted, sessionId, geometryStore])

      return h(React.Fragment, null,
        h('span', { ref: anchorRef, hidden: true, 'aria-hidden': true }),
        // The clipping wrapper keeps the probe's used width measurable without
        // letting a minimum content width create horizontal scroll overflow.
        h('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            visibility: 'hidden',
            pointerEvents: 'none',
          },
        },
        h('span', {
          ref: probeRef,
          style: {
            display: 'block',
            width: 'var(--dsh-chat-content-width, min(920px, 100%))',
            height: 0,
          },
        })))
    }

    function RepoWizard({ sessionId, cwd, initialProjectName, initialPath = '', t, onClose, onDone }) {
      const id = useId()
      const dialogRef = useRef(null)
      const defaultsApplied = useRef(false)
      const projectTouched = useRef(false)
      const repoTouched = useRef(false)
      const [path, setPath] = useState(initialPath)
      const [previewTarget, setPreviewTarget] = useState({ path: initialPath, version: 0 })
      const [preview, setPreview] = useState({ status: 'loading' })
      const [browse, setBrowse] = useState({ status: 'loading' })
      const [projectName, setProjectName] = useState(initialProjectName)
      const [repoName, setRepoName] = useState(defaultRepoName(initialProjectName))
      const [authorName, setAuthorName] = useState('')
      const [authorEmail, setAuthorEmail] = useState('')
      const [createGitignore, setCreateGitignore] = useState(true)
      const [provider, setProvider] = useState('none')
      const [token, setToken] = useState('')
      const [privateRepo, setPrivateRepo] = useState(false)
      const [remoteUrl, setRemoteUrl] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [success, setSuccess] = useState(null)

      useEffect(() => {
        const controller = new AbortController()
        let active = true
        setPreview({ status: 'loading' })
        const query = new URLSearchParams({ sessionId, path: previewTarget.path })
        fetch(`api/git-branch-graph/repo?${query}`, { signal: controller.signal })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok) throw new Error(value?.message ?? `Repository preview returned ${response.status}`)
            if (!active) return
            setPreview(value)
            if (value.status !== 'ok') return
            const origin = Array.isArray(value.remotes)
              ? value.remotes.find(remote => remote.name === 'origin' && remote.usable !== false) : undefined
            if (!projectTouched.current) setProjectName(value.projectName)
            if (!repoTouched.current) setRepoName(defaultRepoName(value.projectName))
            if (value.identity?.name) setAuthorName(current => current || value.identity.name)
            if (value.identity?.email) setAuthorEmail(current => current || value.identity.email)
            if (!defaultsApplied.current) {
              defaultsApplied.current = true
              setProvider(current => origin === undefined && current === 'existing'
                ? 'none'
                : origin !== undefined && current === 'none' ? 'existing' : current)
            }
          })
          .catch(() => {
            if (active && !controller.signal.aborted) setPreview({ status: 'error', message: t('previewFailed') })
          })
        return () => {
          active = false
          controller.abort()
        }
      }, [sessionId, previewTarget, t])

      useEffect(() => {
        const controller = new AbortController()
        let active = true
        setBrowse({ status: 'loading' })
        const query = new URLSearchParams({ sessionId, path: previewTarget.path })
        fetch(`api/git-branch-graph/directories?${query}`, { signal: controller.signal })
          .then(async (response) => {
            const value = await response.json()
            if (!response.ok || value?.status !== 'ok') throw new Error('Directory listing failed')
            if (!active) return
            setBrowse(value)
          })
          .catch(() => {
            if (active && !controller.signal.aborted) setBrowse({ status: 'error' })
          })
        return () => {
          active = false
          controller.abort()
        }
      }, [sessionId, previewTarget])

      useEffect(() => {
        const first = dialogRef.current?.querySelector('[data-autofocus]')
          ?? dialogRef.current?.querySelector('input, select, textarea')
          ?? dialogRef.current?.querySelector('button')
        first?.focus()
      }, [success])

      useEffect(() => {
        if (success !== null) return
        const dialog = dialogRef.current
        if (dialog === null) return
        const controls = [...dialog.querySelectorAll('[data-browser-focus]')]
          .filter(element => !element.disabled)
        const firstDirectory = dialog.querySelector('.dsh-gbg-dirrow')
        ;(firstDirectory ?? controls[0] ?? dialog.querySelector('button'))?.focus()
      }, [browse, success])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!busy) onClose()
            return
          }
          if (event.key !== 'Tab' || dialogRef.current === null) return
          const focusable = [...dialogRef.current.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], textarea:not([disabled])',
          )]
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (!dialogRef.current.contains(active) || active === dialogRef.current) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus()
          } else if (event.shiftKey && active === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => { window.removeEventListener('keydown', onKeyDown) }
      }, [busy, onClose])

      const previewOk = preview.status === 'ok'
      const existing = previewOk && preview.isGit === true
      const parentPath = path === ''
        ? null
        : browse.status === 'ok'
          ? browse.parent
          : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const origin = existing && Array.isArray(preview.remotes)
        ? preview.remotes.find(remote => remote.name === 'origin' && remote.usable !== false) : undefined
      const canSubmit = previewOk && !busy && path === previewTarget.path
        && (!existing || preview.hasCommit === false || provider !== 'none')
        && (provider !== 'github' && provider !== 'gitee' || token.trim() !== '')
        && (provider !== 'github' && provider !== 'gitee' || repoName.trim() !== '')
        && (provider !== 'custom' || remoteUrl.trim() !== '')
      const primaryLabel = provider === 'none'
        ? existing && preview.hasCommit === false ? t('createFirstCommit') : t('createLocal')
        : provider === 'existing' ? t('pushExisting')
          : provider === 'custom' ? t('pushRemote') : t('createAndPush')

      const navigate = (nextPath) => {
        setPath(nextPath)
        setPreviewTarget(previous => ({ path: nextPath, version: previous.version + 1 }))
      }

      const refreshDirectory = () => {
        setPreviewTarget(previous => ({ path, version: previous.version + 1 }))
      }

      const submit = async (event) => {
        event.preventDefault()
        if (!canSubmit) return
        setError(null)
        setBusy(true)
        try {
          const response = await fetch('api/git-branch-graph/manage', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              path: previewTarget.path,
              projectName: projectName.trim(),
              authorName: authorName.trim(),
              authorEmail: authorEmail.trim(),
              createGitignore,
              provider,
              token: token.trim(),
              repoName: repoName.trim(),
              private: privateRepo,
              remoteUrl: remoteUrl.trim(),
            }),
          })
          const value = await response.json()
          if (!response.ok || value?.ok !== true) {
            setError(value?.error ?? { code: 'internal', message: t('errorGeneric') })
            return
          }
          setToken('')
          setSuccess(value.result)
        } catch {
          setError({ code: 'internal', message: t('errorGeneric') })
        } finally {
          setBusy(false)
        }
      }

      const field = (label, control, hint) => h('label', { className: 'dsh-gbg-field' },
        h('span', { className: 'dsh-gbg-label' }, label),
        control,
        hint !== undefined && h('span', { className: 'dsh-gbg-hint' }, hint))

      const portal = node => typeof document === 'undefined' ? node : createPortal(node, document.body)

      if (success !== null) {
        const successUrl = typeof success.remoteUrl === 'string' && /^https:\/\//.test(success.remoteUrl)
          ? success.remoteUrl : null
        return portal(h('div', {
          className: 'dsh-gbg-modal-backdrop',
          onMouseDown: (event) => { if (event.target === event.currentTarget) onDone(success) },
        },
          h('div', {
            ref: dialogRef, className: 'dsh-gbg-modal', role: 'dialog', 'aria-modal': 'true',
            'aria-labelledby': `${id}-title`, tabIndex: -1,
          },
            h('div', { className: 'dsh-gbg-modal-header' },
              h('span', { className: 'dsh-gbg-modal-title', id: `${id}-title` }, t('manageWizardTitle')),
              h('button', {
                type: 'button', className: 'dsh-gbg-icon-button', 'aria-label': t('close'),
                onClick: () => onDone(success),
              }, '×')),
            h('div', { className: 'dsh-gbg-modal-body' },
              h('div', { className: 'dsh-gbg-success' },
                h('div', { className: 'dsh-gbg-preview-success' },
                  success.pushed
                    ? t('pushed', { branch: success.branch ?? 'HEAD', url: success.remoteUrl ?? '' })
                    : success.committed && !success.initialized ? t('createdFirstCommit') : t('createdLocal')),
                success.remoteCreated && h('div', null, t('createdRemote')),
                success.remoteUrl && (successUrl === null
                  ? h('div', { className: 'dsh-gbg-success-link' }, success.remoteUrl)
                  : h('a', {
                    className: 'dsh-gbg-success-link', href: successUrl, target: '_blank', rel: 'noreferrer noopener',
                  }, successUrl)),
                h('div', { className: 'dsh-gbg-actions' },
                  h('button', {
                    type: 'button', className: 'dsh-gbg-primary', 'data-autofocus': true,
                    onClick: () => onDone(success),
                  }, t('done'))))))
        ))
      }

      return portal(h('div', {
        className: 'dsh-gbg-modal-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose() },
      },
        h('div', {
          ref: dialogRef, className: 'dsh-gbg-modal', role: 'dialog', 'aria-modal': 'true',
          'aria-labelledby': `${id}-title`, tabIndex: -1,
        },
          h('div', { className: 'dsh-gbg-modal-header' },
            h('span', { className: 'dsh-gbg-modal-title', id: `${id}-title` },
              existing ? t('manageWizardTitle') : t('repoWizardTitle')),
            h('button', {
              type: 'button', className: 'dsh-gbg-icon-button', 'aria-label': t('close'),
              disabled: busy, onClick: onClose,
            }, '×')),
          h('div', { className: 'dsh-gbg-modal-body' },
            h('form', { className: 'dsh-gbg-form', onSubmit: submit },
              h('div', { className: 'dsh-gbg-hint', title: cwd }, t('currentWorkspace', { path: cwd })),
              h('div', { className: 'dsh-gbg-dirbrowser' },
                h('div', { className: 'dsh-gbg-dirbar' },
                  h('button', {
                    type: 'button', className: 'dsh-gbg-secondary', 'data-browser-focus': true,
                    disabled: parentPath === null,
                    onClick: () => navigate(parentPath ?? ''),
                  }, `↑ ${t('browseUp')}`),
                  h('button', {
                    type: 'button', className: 'dsh-gbg-secondary', 'data-browser-focus': true,
                    disabled: path === '',
                    onClick: () => navigate(''),
                  }, t('browseRoot')),
                  h('button', {
                    type: 'button', className: 'dsh-gbg-secondary', 'data-browser-focus': true,
                    disabled: preview.status === 'loading',
                    onClick: refreshDirectory,
                  }, t('browseRefresh'))),
                h('div', { className: 'dsh-gbg-dirpath', title: path === '' ? '/' : path },
                  path === '' ? t('workspaceRootName') : path),
                h('div', { className: 'dsh-gbg-hint' }, t('currentDirectory')),
                browse.status === 'loading' && h('span', { className: 'dsh-gbg-hint' }, t('browseLoading')),
                browse.status === 'error' && h('span', { className: 'dsh-gbg-preview-error' }, t('browseFailed')),
                browse.status === 'ok' && browse.directories.length === 0
                  && h('span', { className: 'dsh-gbg-hint' }, t('noSubdirectories')),
                browse.status === 'ok' && browse.directories.length > 0 && h('ul', { className: 'dsh-gbg-dirlist' },
                  browse.directories.map(directory => h('li', { key: directory.path },
                    h('button', {
                      type: 'button', className: 'dsh-gbg-dirrow',
                      title: directory.path,
                      onClick: () => navigate(directory.path),
                    },
                      h('span', { className: 'dsh-gbg-diricon' }, icon('folder', 14)),
                      h('span', { className: 'dsh-gbg-dirname' }, directory.name))))),
                browse.status === 'ok' && browse.truncated
                  && h('span', { className: 'dsh-gbg-hint' },
                    t('directoriesTruncated', { count: browse.directories.length }))),

              h('div', { className: 'dsh-gbg-preview' },
                preview.status === 'loading' && h('span', null, t('previewing')),
                preview.status === 'error' && h('span', { className: 'dsh-gbg-preview-error' },
                  repoErrorText(preview, t)),
                preview.status === 'blocked' && h('span', { className: 'dsh-gbg-preview-error' },
                  preview.reason === 'file-count' && preview.fileCount !== null
                    ? t('tooManyFiles', { count: preview.fileCount, limit: preview.limits?.maxFiles ?? 5000 })
                    : preview.reason === 'file-size'
                      ? t('fileTooLarge', {
                        file: preview.largestFile?.path ?? '?',
                        size: formatBytes(preview.largestFile?.bytes ?? 0),
                        limit: formatBytes(preview.limits?.maxFileBytes ?? 0),
                      })
                      : preview.reason === 'total-size'
                        ? t('totalTooLarge', {
                          size: formatBytes(preview.totalBytes ?? 0),
                          limit: formatBytes(preview.limits?.maxTotalBytes ?? 0),
                        })
                        : preview.reason === 'preview-limit' ? t('tooManyFilesUnknown') : t('errorBlocked')),
                preview.status === 'ok' && (existing
                  ? h(React.Fragment, null,
                    h('span', { className: 'dsh-gbg-preview-ok' }, t('existingRepo')),
                    h('span', null, [
                      preview.branch ? t('existingBranch', { name: preview.branch }) : '',
                      t('existingCommits', { count: preview.commitCount ?? 0 }),
                    ].filter(Boolean).join(' · ')),
                    preview.hasCommit === false && h(React.Fragment, null,
                      h('span', { className: 'dsh-gbg-preview-warn' }, t('existingEmpty')),
                      preview.fileCount === 0
                        ? h('span', { className: 'dsh-gbg-preview-warn' }, t('noFiles'))
                        : h('span', { className: 'dsh-gbg-preview-ok' },
                          t('readyToCreate', { count: preview.fileCount, size: formatBytes(preview.totalBytes) })),
                      h('span', { className: 'dsh-gbg-hint' }, t('ignoredHint')),
                      preview.sampleFiles?.length > 0 && h('ul', { className: 'dsh-gbg-sample' },
                        preview.sampleFiles.map(file => h('li', { key: file }, file)),
                        preview.fileCount > preview.sampleFiles.length && h('li', null,
                          t('sampleMore', { count: preview.fileCount - preview.sampleFiles.length }))),
                      h('span', { className: 'dsh-gbg-hint' }, t('limits', {
                        files: preview.limits?.maxFiles ?? 5000,
                        size: formatBytes(preview.limits?.maxTotalBytes ?? 0),
                      }))),
                    (preview.dirtyCount ?? 0) > 0 && h('span', { className: 'dsh-gbg-preview-warn' },
                      t('existingDirty', { count: preview.dirtyCount })),
                    h('div', { className: 'dsh-gbg-hint' }, t('remotes')),
                    preview.remotes?.length > 0
                      ? h('ul', { className: 'dsh-gbg-remotes' }, preview.remotes.map(remote => h('li', { key: remote.name },
                        `${remote.name}  ${remote.url}`,
                        remote.pushUrl && remote.pushUrl !== remote.url
                          && h('div', null, `push  ${remote.pushUrl}`))))
                      : h('span', { className: 'dsh-gbg-hint' }, t('noRemotes')))
                  : h(React.Fragment, null,
                    preview.fileCount === 0
                      ? h('span', { className: 'dsh-gbg-preview-warn' }, t('noFiles'))
                      : h('span', { className: 'dsh-gbg-preview-ok' },
                        t('readyToCreate', { count: preview.fileCount, size: formatBytes(preview.totalBytes) })),
                    h('span', { className: 'dsh-gbg-hint' }, t('ignoredHint')),
                    preview.sampleFiles?.length > 0 && h('ul', { className: 'dsh-gbg-sample' },
                      preview.sampleFiles.map(file => h('li', { key: file }, file)),
                      preview.fileCount > preview.sampleFiles.length && h('li', null,
                        t('sampleMore', { count: preview.fileCount - preview.sampleFiles.length }))),
                    h('span', { className: 'dsh-gbg-hint' }, t('limits', {
                      files: preview.limits?.maxFiles ?? 5000,
                      size: formatBytes(preview.limits?.maxTotalBytes ?? 0),
                    }))))),

              preview.status === 'ok' && h(React.Fragment, null,
                h('div', { className: 'dsh-gbg-section' },
                  h('h3', { className: 'dsh-gbg-section-title' }, t('projectName')),
                  h('div', { className: 'dsh-gbg-row2' },
                    field(t('projectName'), h('input', {
                      id: `${id}-project`, className: 'dsh-gbg-input', value: projectName, maxLength: 120,
                      onChange: (event) => { projectTouched.current = true; setProjectName(event.target.value) },
                    })),
                    (provider === 'github' || provider === 'gitee') && field(t('repoName'), h('input', {
                      id: `${id}-repo`, className: 'dsh-gbg-input', value: repoName, maxLength: 100,
                      onChange: (event) => { repoTouched.current = true; setRepoName(event.target.value) },
                    }), t('repoNameRequired')))),
                (!existing || preview.hasCommit === false) && h('div', { className: 'dsh-gbg-row2' },
                  field(t('authorName'), h('input', {
                    id: `${id}-author`, className: 'dsh-gbg-input', value: authorName, maxLength: 200,
                    autoComplete: 'name', onChange: (event) => { setAuthorName(event.target.value) },
                  })),
                  field(t('authorEmail'), h('input', {
                    id: `${id}-email`, className: 'dsh-gbg-input', type: 'email', value: authorEmail, maxLength: 320,
                    autoComplete: 'email', onChange: (event) => { setAuthorEmail(event.target.value) },
                  }))),
                (!existing || preview.hasCommit === false) && h('div', { className: 'dsh-gbg-hint' }, t('authorHint')),

                h('div', { className: 'dsh-gbg-section' },
                  h('h3', { className: 'dsh-gbg-section-title' }, t('destination')),
                  field(t('destination'), h('select', {
                    id: `${id}-provider`, className: 'dsh-gbg-select', value: provider,
                    onChange: (event) => { setProvider(event.target.value); setToken('') },
                  },
                    h('option', { value: 'none' }, t('destNone')),
                    origin !== undefined && h('option', { value: 'existing' }, t('destExisting')),
                    h('option', { value: 'github' }, t('destGithub')),
                    h('option', { value: 'gitee' }, t('destGitee')),
                    h('option', { value: 'custom' }, t('destCustom')))),
                  provider === 'existing' && origin !== undefined
                    && h('div', { className: 'dsh-gbg-hint' }, origin.pushUrl ?? origin.url),
                  (provider === 'github' || provider === 'gitee') && h(React.Fragment, null,
                    field(t('token'), h('input', {
                      id: `${id}-token`, className: 'dsh-gbg-input', type: 'password', value: token,
                      autoComplete: 'off', spellCheck: false, onChange: (event) => { setToken(event.target.value) },
                    }), t('tokenHint')),
                    field(t('visibility'), h('select', {
                      id: `${id}-visibility`, className: 'dsh-gbg-select', value: privateRepo ? 'private' : 'public',
                      onChange: (event) => { setPrivateRepo(event.target.value === 'private') },
                    },
                      h('option', { value: 'public' }, t('public')),
                      h('option', { value: 'private' }, t('private'))))),
                  provider === 'custom' && field(t('remoteUrl'), h('input', {
                    id: `${id}-remote`, className: 'dsh-gbg-input', value: remoteUrl, spellCheck: false,
                    placeholder: 'https://git.example.com/team/project.git',
                    onChange: (event) => { setRemoteUrl(event.target.value) },
                  }), t('remoteUrlHint')),
                  (!existing || preview.hasCommit === false) && h('label', { className: 'dsh-gbg-check' },
                    h('input', {
                      type: 'checkbox', checked: createGitignore,
                      onChange: (event) => { setCreateGitignore(event.target.checked) },
                    }),
                    h('span', null, t('createGitignore'))))),

              error !== null && h('div', { className: 'dsh-gbg-form-error', role: 'alert' },
                repoErrorText(error, t),
                error.details?.remoteCreated && h('div', null, t('partialRemote')),
                error.details?.initialized && h('div', null, t('partialLocal')),
                error.details?.remoteUrl && h('div', { className: 'dsh-gbg-success-link' }, error.details.remoteUrl)),

              h('div', { className: 'dsh-gbg-actions' },
                h('button', { type: 'button', className: 'dsh-gbg-secondary', disabled: busy, onClick: onClose }, t('close')),
                h('button', {
                  type: 'submit', className: 'dsh-gbg-primary',
                  disabled: !canSubmit || preview.fileCount === 0 && !existing,
                }, busy ? t('working') : primaryLabel))))
      )))
    }

    function BranchGraphDock({
      getMounted, subscribeMounted, getProjectionFace, getSessionRetention, geometryStore, subscribeReset, t,
    }) {
      const sessionId = useSyncExternalStore(subscribeMounted, getMounted, getMounted)
      // A selected Session may become retained just after `mounted` publishes.
      // Observing its reference count re-renders this component when that
      // binding appears, so the projection face is not missed.
      const retention = useMemo(
        () => sessionId === undefined ? undefined : getSessionRetention(sessionId),
        [sessionId, getSessionRetention],
      )
      const subscribeRetention = useMemo(
        () => retention === undefined ? noopSubscribe : listener => retention.subscribe(listener),
        [retention],
      )
      const readRetention = useMemo(
        () => retention === undefined ? () => undefined : () => retention.getSnapshot(),
        [retention],
      )
      useSyncExternalStore(subscribeRetention, readRetention, readRetention)
      const projection = useProjectionSnapshot(sessionId, getProjectionFace)
      const geometry = useSyncExternalStore(
        geometryStore.subscribe, geometryStore.getSnapshot, geometryStore.getSnapshot,
      )
      const development = projection?.development === true
      const cwd = typeof projection?.cwd === 'string' ? projection.cwd : null
      const revision = projection?.revision ?? 0
      const requestKey = `${sessionId}\n${cwd ?? ''}`
      const bodyId = useId()
      const manageButtonRef = useRef(null)
      const [repoPath, setRepoPath] = useState('')
      const [collapsed, setCollapsed] = useState(false)
      const [requestVersion, setRequestVersion] = useState(0)
      const [manageOpen, setManageOpen] = useState(false)
      const [result, setResult] = useState({ phase: 'idle', key: '', data: null })

      useEffect(() => { setCollapsed(false) }, [sessionId, cwd])
      useEffect(() => {
        setRepoPath(sessionId === undefined || cwd === null ? '' : readRepoOverride(sessionId, cwd))
      }, [sessionId, cwd])
      useEffect(() => subscribeReset(() => { setRequestVersion(value => value + 1) }), [subscribeReset])
      useEffect(() => {
        if (!development || cwd === null || sessionId === undefined) {
          setResult({ phase: 'idle', key: requestKey, data: null })
          return
        }
        const controller = new AbortController()
        let active = true
        setResult(previous => ({
          phase: previous.key === requestKey && previous.phase === 'unavailable' ? 'unavailable' : 'loading',
          key: requestKey,
          data: previous.key === requestKey ? previous.data : null,
        }))
        const timer = setTimeout(async () => {
          try {
            const query = new URLSearchParams({ sessionId })
            if (repoPath !== '') query.set('path', repoPath)
            const response = await fetch(`api/git-branch-graph?${query}`, {
              signal: controller.signal,
            })
            const value = await response.json()
            if (!response.ok) throw new Error(`Git route returned ${response.status}`)
            const graph = normalizeGraph(value)
            if (!active) return
            if (graph.status === 'unavailable') {
              setResult({ phase: 'unavailable', key: requestKey, data: graph })
            } else {
              setResult({ phase: 'ready', key: requestKey, data: graph })
            }
          } catch {
            if (active && !controller.signal.aborted) {
              setResult(previous => ({ phase: 'error', key: requestKey, data: previous.data }))
            }
          }
        }, 120)
        return () => {
          active = false
          clearTimeout(timer)
          controller.abort()
        }
      }, [sessionId, development, cwd, repoPath, revision, requestVersion, requestKey])

      if (!development || cwd === null || sessionId === undefined || result.phase === 'idle') return null
      const graph = result.data
      const hiddenUnavailable = result.phase === 'unavailable' && HIDDEN_UNAVAILABLE.has(graph?.reason)
      if (hiddenUnavailable) return null
      const layout = computeFloatingLayout(geometry, collapsed, typeof window === 'undefined' ? 0 : window.innerWidth)
      if (layout === null) return null
      const loading = result.phase === 'loading'
      // Avoid a loading flash for a non-Git workspace: the first probe stays
      // invisible until it has an answer.
      if (loading && !graph) return null

      const viewable = graph && (graph.status === 'ok' || graph.status === 'empty')
      const notGit = result.phase === 'unavailable' && graph?.reason === 'not-git'
      const gitUnavailable = result.phase === 'unavailable' && graph?.reason === 'git-unavailable'
      const hasError = !notGit && (result.phase === 'error' || gitUnavailable
        || (result.phase === 'unavailable' && !hiddenUnavailable))
      const empty = viewable && (graph.status === 'empty' || graph.commits.length === 0)
      const projectName = viewable ? graph.projectName : notGit ? pathBase(cwd) : ''
      const current = viewable ? graph.currentBranch : null
      const disclosureLabel = [
        collapsed ? t('expand') : t('collapse'),
        t('title'),
        projectName,
        current ? t('branch', { name: current }) : viewable ? t('detached') : '',
      ].filter(Boolean).join(' · ')
      const refreshLabel = hasError ? t('retry') : loading ? t('refreshing') : t('refresh')
      const panel = h('section', {
          className: 'dsh-gbg-root',
          role: 'complementary',
          'aria-label': t('title'),
          'aria-busy': loading ? 'true' : undefined,
          'data-git-branch-graph': '',
          'data-collapsed': collapsed || undefined,
          inert: manageOpen ? '' : undefined,
          style: layout,
        },
          h('style', null, CSS),
          h('div', { className: 'dsh-gbg-header' },
            h('button', {
              type: 'button', className: 'dsh-gbg-disclosure',
              'aria-expanded': !collapsed,
              'aria-controls': bodyId,
              'aria-label': disclosureLabel,
              title: disclosureLabel,
              onClick: () => { setCollapsed(value => !value) },
            },
              h('span', { className: 'dsh-gbg-branch-icon' }, icon('branch')),
              h('span', { className: 'dsh-gbg-title' }, t('title')),
              h('span', { className: 'dsh-gbg-title-short', 'aria-hidden': true }, 'Git'),
              projectName !== '' && h('span', {
                className: 'dsh-gbg-project', title: graph?.root ?? cwd,
              }, projectName),
              current && h('span', { className: 'dsh-gbg-current', title: t('branch', { name: current }) }, current),
              viewable && !current && h('span', { className: 'dsh-gbg-current' }, t('detached')),
              h('span', { className: 'dsh-gbg-chevron', 'aria-hidden': true }, icon(collapsed ? 'up' : 'down'))),
            hasError && h('span', {
              className: 'dsh-gbg-header-error', role: 'img', 'aria-label': t('error'), title: t('error'),
            }, icon('alert')),
            h('button', {
              type: 'button', ref: manageButtonRef, className: 'dsh-gbg-icon-button',
              'aria-label': t('manageRepo'), title: t('manageRepo'),
              onClick: () => { setManageOpen(true) },
            }, icon('repo')),
            h('button', {
              type: 'button',
              className: `dsh-gbg-icon-button${loading ? ' dsh-gbg-spinning' : ''}`,
              'aria-label': refreshLabel,
              title: refreshLabel,
              disabled: loading,
              onClick: () => { setRequestVersion(value => value + 1) },
            }, icon('refresh'))),
          !collapsed && h('div', { className: 'dsh-gbg-body', id: bodyId },
            loading && graph && h('span', { className: 'dsh-gbg-sr-only', role: 'status' }, t('refreshing')),
            notGit && h('div', { className: 'dsh-gbg-status dsh-gbg-missing' },
              h('span', null, t('gitMissing')),
              h('button', {
                type: 'button', className: 'dsh-gbg-create',
                onClick: () => { setManageOpen(true) },
              }, t('createGit'))),
            hasError && viewable && h('div', { className: 'dsh-gbg-inline-error', role: 'alert' },
              h('span', null, t('error')),
              h('button', { type: 'button', className: 'dsh-gbg-retry', onClick: () => { setRequestVersion(value => value + 1) } }, t('retry'))),
            hasError && !viewable && h('div', { className: 'dsh-gbg-status dsh-gbg-error', role: 'alert' },
              h('span', null, gitUnavailable ? t('gitUnavailable') : t('error')),
              h('button', { type: 'button', className: 'dsh-gbg-retry', onClick: () => { setRequestVersion(value => value + 1) } }, t('retry'))),
            empty && h('div', { className: 'dsh-gbg-status' },
              h('span', null, t('empty')),
              h('button', {
                type: 'button', className: 'dsh-gbg-secondary',
                onClick: () => { setManageOpen(true) },
              }, t('manageRepo'))),
            viewable && graph.commits.length > 0 && h(React.Fragment, null,
              h('div', { className: 'dsh-gbg-scroll' }, h(Graph, { graph })),
              h('div', { className: 'dsh-gbg-footer' },
                h('span', { className: 'dsh-gbg-root-path', title: t('repository', { path: graph.root }) }, graph.root),
                h('span', { className: 'dsh-gbg-count' }, commitCountLabel(graph, t))))))
        return h(React.Fragment, null, panel,
          manageOpen && h(RepoWizard, {
          sessionId,
          cwd,
          initialProjectName: projectName || pathBase(cwd),
          initialPath: repoPath,
          t,
          onClose: () => {
            setManageOpen(false)
            requestAnimationFrame(() => manageButtonRef.current?.focus())
          },
          onDone: (result) => {
            const relativePath = typeof result?.relativePath === 'string' && result.relativePath !== '.'
              ? result.relativePath : ''
            setManageOpen(false)
            setRepoPath(relativePath)
            if (sessionId !== undefined && cwd !== null) writeRepoOverride(sessionId, cwd, relativePath)
            setRequestVersion(value => value + 1)
            requestAnimationFrame(() => manageButtonRef.current?.focus())
          },
        })
      )
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git-branch-graph: dictionaries')
        const resetListeners = new Set()
        const geometryStore = createExternalStore(null)
        const getMounted = () => ctx.sidebarRight.mounted.getSnapshot()
        const subscribeMounted = listener => ctx.sidebarRight.mounted.subscribe(listener)
        const getProjectionFace = sessionId => ctx.sessions.binding(sessionId)?.session.projections.faceOf('gitBranchGraph')
        const getSessionRetention = sessionId => ctx.sessions.retainInfo(sessionId)
        ctx.on('connection/reset', () => {
          for (const listener of resetListeners) listener()
        })
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'git-branch-graph',
          order: 30,
          locale: NS,
          inject: () => ({
            getMounted,
            subscribeMounted,
            getProjectionFace,
            getSessionRetention,
            geometryStore,
            subscribeReset(listener) {
              resetListeners.add(listener)
              return () => { resetListeners.delete(listener) }
            },
          }),
        }, BranchGraphDock))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'git-branch-graph-geometry',
          order: 15,
          locale: NS,
          inject: () => ({ getMounted, subscribeMounted, geometryStore }),
        }, BranchGraphGeometry))
      },
      __test: {
        layoutGraph, normalizeGraph, shortDate, commitCountLabel, HIDDEN_UNAVAILABLE,
        computeFloatingLayout, sameGeometry, RepoWizard, dictionaries: { zh, en },
      },
    }
  },
})
