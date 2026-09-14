# dsh-ue-bridge

[English](README.md) · [简体中文](README.zh.md)

把 Unreal Engine 工程绑定到 dsh，并在聊天输入框下方用一行紧凑控件完成**构建 / 打开编辑器 / 停止**。
行首有一颗**构建指示灯**：灰=尚未构建，琥珀呼吸=构建中，绿=成功，红=失败（并自动弹出报错日志）。

## 依赖

- dsh `>= 0.1.2-rc.1`，且有 `web` profile（profile 名任意）。
- Node 18+（只用来跑安装器；插件本身跑在 dsh 里）。
- 本机装了 Unreal Engine。Windows 支持最好：没配 `engineRoot` 时会走注册表解析；
  macOS / Linux 回退到盘符探测，建议显式钉住 `engineRoot`。

## 安装

三种方式任选其一，都是一条命令，装完重启 dsh 即可。

### 1. npx 一键（推荐，不用先克隆）

```sh
npx github:JUSTDOITzhw/dsh-ue-bridge
```

`npx` 会把本仓库取到临时目录执行包内的安装器，安装器自己完成全部步骤，不需要手改任何配置文件：

1. 定位 dsh：`$DSH_HOME` 或 `~/.dsh`，profile 默认 `web`；
2. 把插件复制到 `<DSH_HOME>/profiles/<profile>/plugins/dsh-ue-bridge`；
3. 注册到 profile：优先走官方 `dsh plugin --profile <p> add <dir>`；找不到 CLI 或 pnpm 时，
   直接写出等价结果（`link:` 依赖 + `dsh.profile.bundles` 层 + `node_modules` 链接）；
4. 校验：真实 `import` 一次宿主半侧，确认模块解析与依赖都通。

发布到 npm 之后，同一条命令写作 `npx dsh-ue-bridge` 即可。

### 2. 官方 dsh 插件方式

```sh
dsh plugin --profile web add github:JUSTDOITzhw/dsh-ue-bridge
```

`dsh plugin` 是 pnpm 的转发器（装完再对齐 `dsh.profile.bundles`），所以 registry 名、
`github:`、`git+https://`、tarball、本地路径都能吃。本包**不含任何构建步骤**
（没有 `prepare` / `postinstall`），因此不会撞上 pnpm 从 git 安装时的 `allowBuilds` 拦截。

### 3. 全局安装

```sh
npm i -g dsh-ue-bridge
dsh-ue-bridge install
```

### 常用选项

| 参数 | 作用 |
| --- | --- |
| `--profile <name>` | 目标 profile，默认 `web` |
| `--dsh-home <path>` | 非默认的 `DSH_HOME` |
| `--roots "E:/,F:/"` | 固定扫描目录（不给则自动发现） |
| `--engine D:/UE_5.4` | 固定引擎根目录 |
| `--no-register` | 只复制文件，不改 profile 清单 |
| `--dry-run` | 只打印将要做什么 |
| `-h` / `-v` | 帮助 / 版本 |

```sh
npx github:JUSTDOITzhw/dsh-ue-bridge status      # 版本、bundles 条目、node_modules 链接、配置层
npx github:JUSTDOITzhw/dsh-ue-bridge uninstall   # 连同配置层与 node_modules 链接一起清掉
```

装完启动 `dsh --profile <profile>`，打开任意会话即可看到那一行。

**新机器上不需要任何配置**：首次进入时插件会自动扫描本机磁盘找出 `.uproject` 所在目录
（约 1 秒，异步执行不阻塞宿主），结果缓存在 `<DSH_HOME>/ue-bridge/roots.json`，6 小时后自动重扫。
引擎则从 Windows 注册表解析，同样无需手填。

## 结构

| 半侧 | 入口 | 职责 |
| --- | --- | --- |
| 宿主 | `index.js`（`exports "."`） | 工程绑定、引擎解析、磁盘自动发现、进程启停、日志环形缓冲、注册 `/api/ue-bridge/*` 路由 |
| 浏览器 | `lib/client.js`（`exports "./client"`） | 向 `conversation.composer.dock` 插槽贡献一行界面 |
| 安装器 | `bin/cli.mjs`（包的 `bin` 入口） | 跨平台安装 / 状态 / 卸载，无第三方依赖 |

浏览器半侧是 loader 的 lazy-CJS factory 产物（`window.__ModuleLoader__.load`），只 `require("react")`，不导入任何其他插件的运行时值。
界面只用 `--dsw-alias-*` 主题语义 token，没有颜色字面量，也不做明暗分支。

## HTTP 接口

宿主半侧通过 `ctx.webServer.register` 注册，仅接受本机同源请求：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ue-bridge/state` | 绑定状态、子进程、上次构建结果、日志尾部 |

`lastBuild` 是界面上那颗指示灯的唯一数据来源：

```jsonc
{
  "ok": false,             // UE 自报结论优先于退出码
  "code": 6,               // 退出码（-1 = 没拿到）
  "ms": 4200,              // 耗时
  "mode": "code",          // code | blueprint
  "label": "SampleGameEditor",
  "run": 3,                // 单调递增的构建序号：UI 靠它判断"这是一次新的失败"
  "verdict": "",           // 退出码非 0 但实际成功时的解释
  "stopped": false,        // 手动停止：灰色，不计失败
  "errorCount": 2,         // 构建期间筛出的报错行总数
  "errors": ["…", "…"]     // 最多 30 条，供失败弹窗直接展示
}
```

| GET | `/api/ue-bridge/projects` | 扫描根目录下的 `.uproject` 候选（会等待进行中的自动发现） |
| GET | `/api/ue-bridge/log` | 完整日志（有界环形缓冲） |
| POST | `/api/ue-bridge/action` | `{ action: 'build' \| 'openEditor' \| 'stop' \| 'bind' \| 'unbind' \| 'rescan' }` |

## 配置

所有部署相关的值都是配置字段，无硬编码。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `projectFile` | `''` | 要绑定的 `.uproject` 绝对路径 |
| `engineRoot` | `''` | 引擎根目录（含 `Engine/` 的那层） |
| `searchRoots` | `[]` | 候选工程扫描根目录；空或 `['auto']` 表示自动发现，`['.']` 表示宿主工作目录 |
| `searchDepth` | `3` | 扫描深度（1–8） |
| `discoverDepth` | `6` | 自动发现的遍历深度（1–10） |
| `discoverBudget` | `24000` | 自动发现的目录数预算；目录树极深时调大 |
| `target` | `''` | 构建目标名；空表示 `<工程名>Editor` |
| `platform` | `Win64` | `Win64` / `Linux` / `Mac` |
| `configuration` | `Development` | 构建配置 |
| `extraBuildArgs` | `''` | 追加到构建命令行 |
| `extraEditorArgs` | `''` | 追加到编辑器命令行 |
| `maxLogChars` | `200000` | 日志环形缓冲字符预算 |

### 解析优先级

**工程**：界面绑定（持久化） → `projectFile` → 扫描根目录下最新的 `.uproject`。

**引擎**：`engineRoot` → 持久化绑定 → Windows 注册表 → 盘符探测。

注册表来源为 `HKLM\SOFTWARE\EpicGames\Unreal Engine\<version>\InstalledDirectory` 与
`HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds`（源码版引擎的 GUID 映射），
按 `.uproject` 的 `EngineAssociation` 匹配。

### 自动发现工程目录

`searchRoots` 为空时走自动发现，策略是"先广后深"：

1. 枚举本机所有盘符，加上 `~/UnrealProjects`、`~/Documents/Unreal Projects`、`~/Desktop`、`~/Downloads` 这些常见位置；
2. **广度优先**遍历，深度 6、总目录数预算 24000 —— BFS 让有限的预算先花在工程常见的浅层，
   而不是钻进某一根深枝；
3. 按盘加权分配预算：系统盘只给 15%（它的 `Users` 已在第 1 步单独覆盖），
   避免 `C:` 把预算吃掉、让真正放工程的 `D:`/`E:`/`F:` 挨饿；
4. 由找到的 `.uproject` 反推**工程分组目录**（`D:/Root/Group/Game/Game.uproject` → `D:/Root/Group`），
   再做前缀收敛（保留更短的父目录，丢掉被覆盖的子目录）；
5. 结果落到 `roots.json` 缓存，之后的每次扫描只扫这些目录，几十毫秒即可返回。

工程搬了位置或想重新全盘找一次，点界面里的「重新发现」即可。

### 构建方式

按工程类型自动选路，不需要手工切换：

- **C++ 工程**（`.uproject` 里有 `Modules`，或 `Source/**/*.Target.cs` 存在）→

  ```
  Engine/Build/BatchFiles/Build.bat <Target> <Platform> <Configuration> -Project="<…>.uproject" -WaitMutex -FromMsBuild
  ```

  和 IDE 里右键 Build 走的是同一条 UBT 流水线，真正编译并链接 C++。

- **纯蓝图工程** → `UnrealEditor-Cmd <…>.uproject -run=CompileAllBlueprints -unattended -nopause -NullRHI -stdout`。
  蓝图没有 C++ 产物可链接，只能由编辑器把蓝图编译一遍（会完整启动一次编辑器，所以明显更慢）。

**构建结果怎么判定**：不是只看退出码。无人值守模式下 UE 会把工程配置类的 `Error`
（例如 `GameFeatureData` 未注册到资产管理器）计为 `Failure`，于是即便
`Compiling Completed with 0 errors` 也会以退出码 `1` 结束。插件因此同时解析 UE
自己的结论行（`Compiling Completed with N errors…`、`finished execution (result N)`、
UBT 的 `Result: Succeeded`）：退出码为 0 一律算成功；退出码非 0 时，若 UE 自报结论
干净则仍算成功，并在界面给出原因（鼠标悬停那行文字可见）。

### 指示灯

行首那颗灯**只回答一件事：上一次构建怎么样**。所以「编辑器运行中」不会改它的颜色。

| 状态 | 颜色 | 行为 |
|---|---|---|
| 尚未构建（本会话没构建过） | 灰 `label-tertiary` | — |
| 构建中 | 琥珀 `state-warn-primary`，光晕呼吸 | 实时走秒 |
| 成功 | 绿 `state-success-primary` | 显示总耗时 |
| 失败 | 红 `state-error-primary` | **自动弹出日志面板** |
| 构建被手动 `停止` | 灰 | 不计为失败，不弹日志 |

失败时弹出的日志面板把**报错行**单独放在最上方（红色左边框 + 等宽字体），
带一个「复制」按钮直接拷走；原始日志完整保留在下方，不会被截断。

报错行是构建期间从子进程输出里实时筛出来的，匹配 UE / 工具链的常见写法
（`Error:`、`error C2065` / `error LNK2019` / `error MSB3073`、`fatal error`、
`Result: Failed`、`Failure - N error(s)`、`with N errors`），最多 30 条。
计数器行（`with 0 errors`）被显式排除 —— 那是干净结论，不是报错。

编辑器运行时构建会带上文件占用提示；`停止` 通过 `taskkill /T /F` 结束整棵进程树（MSBuild / UBT 会派生子进程）。
编辑器二进制目录按宿主平台选择（Windows `Win64`、macOS `Mac`、Linux `Linux`）。

## 想在配置层固定扫描目录

在 profile 的 `cordis.patch.yml` 中按 row id 覆盖（patch 替换整行 `config`，不做深度合并，因此要把字段写全）：

```yaml
- id: ue-bridge
  config:
    projectFile: ''
    engineRoot: ''
    searchRoots:
      - 'E:/'
      - 'F:/'
    searchDepth: 3
    target: ''
    platform: Win64
    configuration: Development
    extraBuildArgs: ''
    extraEditorArgs: ''
    maxLogChars: 200000
```

## 安装与卸载（手动等价操作）

```sh
dsh plugin --profile web add ./plugins/dsh-ue-bridge
dsh --profile web --dump-config     # 应出现 "# == dsh-ue-bridge" 层
dsh --profile web
dsh plugin --profile web remove dsh-ue-bridge
```

## 已知边界

- 引擎解析优先走 Windows 注册表；其他平台回退到盘符探测。
- 自动发现只覆盖盘符下的目录树与上面列出的常见位置；装在盘符之外（如网络路径）时请用 `searchRoots` 指定。
- `C:\ProgramData\Epic\...\VaultCache` 这类 Epic Launcher 只读模板缓存会被有意跳过。
- 页面轮询周期 1.5s，扫描结果缓存 30s，绑定缓存 3s。
- 单次扫描每个根目录上限 20000 个目录，防止异常目录树阻塞宿主。

## 改了插件界面却不生效？先重启 dsh

**浏览器半侧（`lib/client.js`）在 dsh 启动时被读取一次并缓存在内存里**，bundle 的 `rev` 是启动时算好的哈希。所以：

- 改了 `lib/client.js` → **必须重启 `dsh web`**，刷新页面没有用。
- 该 profile 没有启用 HMR（`dsh-client-hmr` / `cordis-plugin-hmr` 都未安装）；装上后可以免重启。

判断当前加载的是哪一版：打开「日志」面板，第一行会打印 `dsh-ue-bridge v<版本>`；选择工程面板底部也会带上 `｜ 候选 N/M ｜ v<版本>`。版本号对不上就是没重启。

宿主半侧（`index.js`）没有这个限制，但同样只在启动时加载一次。

## 工程列表是空的？

选择列表对宿主返回的数据做了规整：字段缺失会回退（`path` / `projectFile` / `file`，名字可由 `.uproject` 文件名推导），无法使用的条目直接丢弃。**任何一行都不会渲染成没有文字的空行**——如果一条都用不了，面板会直接显示原因（例如「工程接口返回了 N 项，但没有一项带有工程路径」），而不是给一个空白框。

排查顺序：

1. `curl -s http://127.0.0.1:<port>/api/ue-bridge/projects` —— 宿主是否返回了 `projects` 数组。
2. `curl -s http://127.0.0.1:<port>/api/ue-bridge/state` —— 看 `scanRoots` / `candidateCount`。
3. 面板底部若显示 `候选 0/M`，说明数据到了但过滤器没匹配上（清空筛选框）。

