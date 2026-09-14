#!/usr/bin/env node
/**
 * dsh-ue-bridge — installer CLI.
 *
 * One command puts this plugin into a dsh profile on any machine, without
 * hand-editing a manifest:
 *
 *   npx dsh-ue-bridge                       # deploy into the `web` profile of ~/.dsh
 *   npx dsh-ue-bridge --profile web         # explicit profile
 *   npx dsh-ue-bridge --dsh-home D:/dsh     # non-default DSH_HOME
 *   npx dsh-ue-bridge --roots "E:/,F:/"     # pin the .uproject scan roots
 *   npx dsh-ue-bridge status                # what is deployed where
 *   npx dsh-ue-bridge uninstall             # remove it again
 *
 * Registration prefers the official path (`dsh plugin --profile <p> add <dir>`,
 * a pnpm forwarder plus a bundles reconciler). When the CLI or pnpm is missing
 * it falls back to the same end state written by hand: a `link:` dependency, the
 * bundle layer entry, and the node_modules link.
 *
 * Deliberately free of any `prepare` / `postinstall` step: a package that builds
 * on install is blocked by pnpm's allowBuilds gate when installed from a git
 * URL, which would turn the one-command install into a two-step chore.
 *
 * Zero dependencies; Node 18+.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-ue-bridge'
const ROW_ID = 'ue-bridge'
const MIN_NODE_MAJOR = 18

/**
 * Everything the plugin needs at runtime, plus the installer itself so a
 * deployed copy can be re-run in place. Anything outside this list (tests,
 * VCS metadata, editor droppings) never lands in a dsh profile.
 */
const DEPLOY_FILES = [
  'package.json',
  'index.js',
  'lib',
  'cordis.patch.yml',
  'bin',
  'tools',
  'README.md',
  'README.zh.md',
  'LICENSE',
]

/** Directories dropped wholesale before a copy, so removals actually propagate. */
const DEPLOY_TREES = new Set(['lib', 'bin', 'tools'])

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)
const version = readPackageVersion(packageRoot)

/* ------------------------------------------------------------------ *
 * Console
 * ------------------------------------------------------------------ */

const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
const tint = (code) => (text) => (color ? `\u001B[${code}m${text}\u001B[0m` : text)
const dim = tint('2')
const bold = tint('1')
const green = tint('32')
const yellow = tint('33')
const red = tint('31')

const step = (text) => console.log(`\n${bold(`== ${text}`)}`)
const info = (text) => console.log(`   ${text}`)
const warn = (text) => console.log(`   ${yellow('!')} ${text}`)
const ok = (text) => console.log(`   ${green('\u2713')} ${text}`)
const bad = (text) => console.log(`   ${red('\u00d7')} ${text}`)

function fail(text) {
  console.error(`\n${red('\u00d7')} ${text}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const USAGE = `
dsh-ue-bridge v${version} — bind an Unreal Engine project to the dsh composer dock.

用法
  npx ${PLUGIN_NAME} [install] [选项]    部署并注册到 dsh profile（默认动作）
  npx ${PLUGIN_NAME} status [选项]       显示部署状态
  npx ${PLUGIN_NAME} uninstall [选项]    从 profile 卸载

选项
  --profile <name>   目标 profile（默认 web）
  --dsh-home <dir>   DSH_HOME（默认取环境变量 DSH_HOME，否则 ~/.dsh）
  --roots <list>     钉住 .uproject 扫描根目录，逗号分隔；默认 auto（自动探测磁盘）
  --engine <dir>     钉住 UE 引擎根目录
  --no-register      只复制文件，不改 profile 清单
  --dry-run          只打印打算做什么，不写盘
  -y, --yes          不询问（当前无非交互确认项，保留给后续）
  -h, --help         显示本帮助
  -v, --version      显示版本
`

function parseArgs(argv) {
  const options = {
    command: 'install',
    profile: 'web',
    dshHome: '',
    roots: '',
    engine: '',
    source: packageRoot,
    register: true,
    dryRun: false,
  }

  const takesValue = {
    '--profile': 'profile',
    '--dsh-home': 'dshHome',
    '--roots': 'roots',
    '--engine': 'engine',
    '--source': 'source',
  }

  const argvRest = [...argv]
  const first = argvRest[0]
  if (first !== undefined && !first.startsWith('-')) {
    const commands = { install: 'install', add: 'install', status: 'status', uninstall: 'uninstall', remove: 'uninstall' }
    if (commands[first] === undefined) fail(`未知子命令：${first}（可选 install / status / uninstall）`)
    options.command = commands[first]
    argvRest.shift()
  }

  for (let index = 0; index < argvRest.length; index += 1) {
    const arg = argvRest[index]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (arg === '--version' || arg === '-v') {
      console.log(version)
      process.exit(0)
    }
    if (arg === '--uninstall') options.command = 'uninstall'
    else if (arg === '--no-register') options.register = false
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--yes' || arg === '-y') { /* reserved */ }
    else if (takesValue[arg] !== undefined) {
      const value = argvRest[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${arg} 缺少取值`)
      options[takesValue[arg]] = value
      index += 1
    } else fail(`未知参数：${arg}（试试 --help）`)
  }

  if (options.source !== packageRoot && !existsSync(join(options.source, 'index.js'))) {
    fail(`--source 指向的目录里没有 index.js：${options.source}`)
  }
  return options
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function readPackageVersion(dir) {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return '0.0.0'
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')).version ?? '0.0.0'
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

function backup(file) {
  if (!existsSync(file)) return ''
  const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)
  const copy = `${file}.bak-${stamp}`
  cpSync(file, copy)
  return copy
}

/** `existsSync` follows links, so a link whose target is already gone reads as absent. */
function linkExists(target) {
  try {
    return lstatSync(target) !== null
  } catch {
    return false
  }
}

const isDir = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function findCli() {
  const probe = spawnSync('dsh', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8', windowsHide: true })
  return probe.status === 0 ? 'dsh' : ''
}

function resolveDshHome(options) {
  if (options.dshHome !== '') return resolve(options.dshHome)
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

function listProfiles(dshHome) {
  const root = join(dshHome, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'package.json')))
    .map((entry) => entry.name)
}

function layout(options) {
  const dshHome = resolveDshHome(options)
  const profileDir = join(dshHome, 'profiles', options.profile)
  return {
    dshHome,
    profileDir,
    manifestPath: join(profileDir, 'package.json'),
    patchFile: join(profileDir, 'cordis.patch.yml'),
    pluginDir: join(profileDir, 'plugins', PLUGIN_NAME),
    linkPath: join(profileDir, 'node_modules', PLUGIN_NAME),
  }
}

/* ------------------------------------------------------------------ *
 * Patch layer (cordis.patch.yml) — a top-level list of `- id: <row>` blocks
 * ------------------------------------------------------------------ */

const isBlockStart = (line) => /^-\s+id:\s*(\S+)\s*$/u.test(line)
const blockIdOf = (line) => /^-\s+id:\s*(\S+)\s*$/u.exec(line)?.[1] ?? ''

/**
 * Split a patch file into its leading comment header and one entry per block.
 * Comment lines directly above a `- id:` line belong to that block, so removing
 * a block also removes the note explaining it. The file's own leading comments
 * stay in the header and are never stolen by the first block.
 */
function splitPatch(text) {
  const lines = text.split(/\r?\n/u)
  const blocks = []
  const header = []
  let current = null

  const takeTrailingComments = () => {
    if (current === null) return []
    const owned = []
    while (current.lines.length > 0 && current.lines[current.lines.length - 1].trimStart().startsWith('#')) {
      owned.unshift(current.lines.pop())
    }
    return owned
  }

  for (const line of lines) {
    if (isBlockStart(line)) {
      current = { id: blockIdOf(line), lines: [...takeTrailingComments(), line] }
      blocks.push(current)
      continue
    }
    if (current === null) header.push(line)
    else current.lines.push(line)
  }
  return { header, blocks }
}

const renderPatch = ({ header, blocks }) =>
  `${[...header, ...blocks.flatMap((block) => block.lines)].join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '')}\n`

function upsertPatchBlock(file, lines) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const parsed = splitPatch(text)
  const kept = parsed.blocks.filter((block) => block.id !== ROW_ID)
  kept.push({ id: ROW_ID, lines: [...lines, ''] })
  return renderPatch({ header: parsed.header, blocks: kept })
}

function removePatchBlock(file, options) {
  if (!existsSync(file)) return false
  const parsed = splitPatch(readFileSync(file, 'utf8'))
  const kept = parsed.blocks.filter((block) => block.id !== ROW_ID)
  if (kept.length === parsed.blocks.length) return false
  if (!options.dryRun) {
    const backupFile = backup(file)
    writeFileSync(file, renderPatch({ header: parsed.header, blocks: kept }), 'utf8')
    info(`已移除配置层：${file}${backupFile === '' ? '' : `（备份 ${basename(backupFile)}）`}`)
  } else {
    info(`would drop the '${ROW_ID}' row from ${file}`)
  }
  return true
}

/* ------------------------------------------------------------------ *
 * Profile registration
 * ------------------------------------------------------------------ */

function register(profile, profileDir, pluginDir, options) {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {}

  const cli = findCli()
  if (cli !== '' && options.dryRun === false) {
    step(`注册（dsh plugin --profile ${profile} add）`)
    const result = spawnSync(cli, ['plugin', '--profile', profile, 'add', pluginDir], {
      cwd: profileDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.status === 0) {
      ok('已通过官方 CLI 注册')
      return 'cli'
    }
    warn('官方 CLI 注册失败，回退为直接改写 profile 清单')
  } else if (cli === '') {
    warn('未在 PATH 上找到 dsh CLI，直接改写 profile 清单')
  }

  const backupManifest = options.dryRun ? '' : backup(manifestPath)
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [PLUGIN_NAME]: `link:${pluginDir}` }
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  bundles.add(PLUGIN_NAME)
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...bundles] } }

  const modulesDir = join(profileDir, 'node_modules')
  const linkPath = join(modulesDir, PLUGIN_NAME)
  if (options.dryRun === false) {
    writeJson(manifestPath, manifest)
    mkdirSync(modulesDir, { recursive: true })
    if (linkExists(linkPath)) rmSync(linkPath, { recursive: true, force: true })
    try {
      symlinkSync(pluginDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      warn(`无法创建 node_modules 链接（${error.code}）：请改在 profile 目录里执行一次 pnpm install`)
    }
  }
  ok(options.dryRun
    ? `（dry-run）将登记 ${PLUGIN_NAME} 的依赖、bundle 层与 node_modules 链接`
    : `已写入 ${manifestPath}${backupManifest === '' ? '' : `（备份 ${basename(backupManifest)}）`}`)
  return 'manifest'
}

function unregister(profileDir, options) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = readJson(manifestPath)
  let touched = false
  if (manifest.dependencies?.[PLUGIN_NAME] !== undefined) {
    delete manifest.dependencies[PLUGIN_NAME]
    touched = true
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(PLUGIN_NAME)) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PLUGIN_NAME)
    touched = true
  }
  if (touched && options.dryRun === false) {
    const backupManifest = backup(manifestPath)
    writeJson(manifestPath, manifest)
    ok(`已从 profile 清单移除${backupManifest === '' ? '' : `（备份 ${basename(backupManifest)}）`}`)
  }
  const linkPath = join(profileDir, 'node_modules', PLUGIN_NAME)
  if (linkExists(linkPath) && options.dryRun === false) rmSync(linkPath, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * Deployment
 * ------------------------------------------------------------------ */

function deploy(source, target, options) {
  /* Running the installer from an already-deployed copy: nothing to copy, the
     folder is both source and target, and copying it onto itself would thrash. */
  if (resolve(source) === resolve(target)) {
    info('源目录就是目标目录，跳过复制（只做注册与校验）')
    return
  }
  for (const name of DEPLOY_FILES) {
    const from = join(source, name)
    if (!existsSync(from)) continue
    const to = join(target, name)
    if (options.dryRun) {
      info(`would copy ${name}${isDir(from) ? '/' : ''}`)
      continue
    }
    /* Trees are replaced, not merged: dropping a file upstream has to drop it
       here too, or a stale module keeps shadowing the new one. */
    if (DEPLOY_TREES.has(name) && linkExists(to)) rmSync(to, { recursive: true, force: true })
    cpSync(from, to, {
      recursive: true,
      force: true,
      filter: (entry) => !entry.includes(`${sep}node_modules${sep}`) && !entry.endsWith(`${sep}node_modules`),
    })
  }
}

/** Import the host half from its final location — this is what proves the tree is right. */
function verifyHostHalf(pluginDir) {
  const script = `await import(${JSON.stringify(`file:///${pluginDir.replace(/\\/gu, '/')}/index.js`)}); console.log('HOST_HALF_OK')`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status === 0 && output.includes('HOST_HALF_OK')) return { ok: true, detail: '宿主半侧可加载，依赖解析正常' }
  const reason = output.split('\n').find((line) => line.includes('Error')) ?? `exit ${result.status}`
  return { ok: false, detail: reason.trim() }
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

function commandStatus(options) {
  const paths = layout(options)
  const deployedManifest = join(paths.pluginDir, 'package.json')
  const manifest = existsSync(paths.manifestPath) ? readJson(paths.manifestPath) : {}
  const bundles = manifest.dsh?.profile?.bundles ?? []

  console.log(`${bold(PLUGIN_NAME)} v${version} — 部署状态`)
  info(`DSH_HOME     : ${paths.dshHome}`)
  info(`profile      : ${options.profile}${existsSync(paths.manifestPath) ? '' : dim('  (尚未初始化)')}`)
  info(`插件目录     : ${paths.pluginDir}`)

  const profiles = listProfiles(paths.dshHome)
  if (profiles.length > 0) info(`现有 profile : ${profiles.join(', ')}`)

  if (!existsSync(deployedManifest)) {
    bad('未部署。在 profile 里运行一次安装即可。')
    return 1
  }
  const deployed = readPackageVersion(paths.pluginDir)
  ok(`已部署，版本 ${deployed}${deployed === version ? '' : yellow(`（安装器版本 ${version}，可重跑本命令升级）`)}`)

  if (bundles.includes(PLUGIN_NAME)) ok('profile 的 bundles 已包含它')
  else bad('profile 的 bundles 里没有它 —— 插件不会被加载')

  if (existsSync(paths.linkPath)) ok('node_modules 链接就绪')
  else bad('node_modules 链接缺失（在 profile 目录跑一次 pnpm install 可补齐）')

  const patch = existsSync(paths.patchFile) ? readFileSync(paths.patchFile, 'utf8') : ''
  if (new RegExp(`^\\s*-\\s+id:\\s*${ROW_ID}\\s*$`, 'mu').test(patch)) ok(`配置层已有 '${ROW_ID}' 行`)
  else info(dim(`配置层没有 '${ROW_ID}' 行（用默认值即可，正常）`))

  return 0
}

function commandUninstall(options) {
  const paths = layout(options)
  if (!existsSync(paths.dshHome)) {
    bad(`没有找到 DSH_HOME：${paths.dshHome}`)
    return 1
  }
  step('卸载')
  /* Unregister first: once the plugin directory is gone the node_modules link
     dangles, and a dangling link no longer reads as present. */
  unregister(paths.profileDir, options)
  removePatchBlock(paths.patchFile, options)
  if (!existsSync(paths.pluginDir)) {
    warn(`插件目录不存在：${paths.pluginDir}`)
  } else if (options.dryRun) {
    info(`would remove ${paths.pluginDir}`)
  } else {
    rmSync(paths.pluginDir, { recursive: true, force: true })
    ok(`已删除 ${paths.pluginDir}`)
  }
  console.log(`\n卸载完成。重启 dsh 生效。`)
  return 0
}

function commandInstall(options) {
  const paths = layout(options)
  const source = resolve(options.source)
  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE_MAJOR) fail(`需要 Node ${MIN_NODE_MAJOR}+，当前为 ${process.versions.node}`)
  if (!existsSync(join(source, 'index.js'))) fail(`源目录里没有 index.js：${source}`)

  console.log(`${bold(PLUGIN_NAME)} v${version} 安装器`)
  info(`源目录      : ${source}`)
  info(`DSH_HOME    : ${paths.dshHome}`)
  info(`目标 profile: ${options.profile}${existsSync(paths.manifestPath) ? '' : dim('  (尚未初始化)')}`)
  info(`插件目标位置: ${paths.pluginDir}`)
  if (options.dryRun) info(`模式        : dry-run（不写入）`)

  if (!existsSync(join(paths.dshHome, 'profiles')) && !options.dryRun) {
    fail([
      `没有找到 profile 目录：${join(paths.dshHome, 'profiles')}`,
      '这台机器上似乎还没有初始化过 dsh。先运行一次 dsh，或用 --dsh-home 指定正确位置。',
    ].join('\n'))
  }
  const profiles = listProfiles(paths.dshHome)
  if (profiles.length > 0 && !profiles.includes(options.profile) && !options.dryRun) {
    warn(`profile "${options.profile}" 不存在；现有：${profiles.join(', ')}`)
  }

  step('复制插件文件')
  if (!options.dryRun) mkdirSync(paths.pluginDir, { recursive: true })
  deploy(source, paths.pluginDir, options)
  ok(options.dryRun ? '（dry-run）' : `已部署到 ${paths.pluginDir}`)

  if (options.register) register(options.profile, paths.profileDir, paths.pluginDir, options)
  else warn('按要求跳过了注册；需要手工把插件加入 profile')

  if (options.roots !== '' || options.engine !== '') {
    step('写入配置层')
    const roots = options.roots.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
    const lines = [
      `# ${PLUGIN_NAME}: pinned by bin/cli.mjs.`,
      '# A patch row replaces the target row\'s whole `config`, so every field is restated here.',
      `- id: ${ROW_ID}`,
      '  config:',
      "    projectFile: ''",
      `    engineRoot: '${options.engine.replace(/\\/gu, '/')}'`,
      '    searchRoots:',
      ...(roots.length > 0 ? roots.map((root) => `      - '${root.replace(/\\/gu, '/')}'`) : ["      - 'auto'"]),
      '    searchDepth: 3',
      "    target: ''",
      '    platform: Win64',
      '    configuration: Development',
      "    extraBuildArgs: ''",
      "    extraEditorArgs: ''",
      '    maxLogChars: 200000',
    ]
    if (!options.dryRun && existsSync(paths.patchFile)) {
      const backupPatch = backup(paths.patchFile)
      writeFileSync(paths.patchFile, upsertPatchBlock(paths.patchFile, lines), 'utf8')
      ok(`已更新 ${paths.patchFile}${backupPatch === '' ? '' : `（备份 ${basename(backupPatch)}）`}`)
    } else if (options.dryRun) {
      info(lines.join('\n      '))
    } else {
      warn(`未找到 ${paths.patchFile}，跳过配置层（默认值已足够）`)
    }
  }

  step('验证')
  if (options.dryRun) {
    info('dry-run：跳过验证')
  } else {
    const host = verifyHostHalf(paths.pluginDir)
    host.ok ? ok(host.detail) : warn(`宿主半侧加载失败：${host.detail}`)

    const manifest = existsSync(paths.manifestPath) ? readJson(paths.manifestPath) : {}
    if (manifest.dsh?.profile?.bundles?.includes(PLUGIN_NAME) === true) ok('profile 的 bundles 已包含 dsh-ue-bridge')
    else warn('profile 的 bundles 里还没有它，注册可能没成功')

    if (existsSync(paths.linkPath)) ok('node_modules 链接就绪')
    else warn('node_modules 链接缺失；在 profile 目录执行 pnpm install 可补齐')
  }

  console.log(`
${bold('下一步')}
  1. 重启 dsh（客户端半侧只在启动时读一次，刷新页面不够）
  2. 打开一个会话，输入框下方就是 UE 那一行
  3. 首次进入会自动扫描本机磁盘发现 .uproject（约 1 秒），点工程名可切换
  4. 要指定扫描目录：npx ${PLUGIN_NAME} --roots "E:/,F:/"，或直接编辑
     ${paths.patchFile}

${dim(`卸载：npx ${PLUGIN_NAME} uninstall${options.profile === 'web' ? '' : ` --profile ${options.profile}`}`)}
`)
  return 0
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

const options = parseArgs(process.argv.slice(2))
const code =
  options.command === 'status' ? commandStatus(options)
    : options.command === 'uninstall' ? commandUninstall(options)
      : commandInstall(options)
process.exit(code)
