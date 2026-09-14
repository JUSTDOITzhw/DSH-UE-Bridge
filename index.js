/**
 * dsh-ue-bridge — host half.
 *
 * Binds an Unreal Engine project and drives three actions from the dsh Web GUI:
 * Build, Open Editor, Stop. This half owns the binding, resolves the engine,
 * spawns and reaps the children, keeps a bounded log ring, and serves the
 * browser half over same-origin loopback HTTP routes.
 *
 *   GET  /api/ue-bridge/state      live snapshot (binding, children, last build, log tail)
 *   GET  /api/ue-bridge/projects   .uproject candidates under the configured roots
 *   GET  /api/ue-bridge/log        the full bounded log as text
 *   POST /api/ue-bridge/action     { action: 'build' | 'openEditor' | 'stop' | 'bind' | 'unbind' }
 *
 * All four routes are registered inside a single `ctx.effect` disposer, so the
 * children are reaped in the same cleanup step that drops the routes.
 *
 * The browser half (`./client`, exported as `lib/client.js`) contributes one
 * compact row into the `conversation.composer.dock` slot.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

export const name = 'ue-bridge'

/** Route registration needs the browser HTTP carrier. */
export const inject = ['webServer']

export const Config = Schema.object({
  /** Absolute path of the .uproject to bind. Empty falls through to the persisted binding, then auto-detection. */
  projectFile: Schema.string().default(''),
  /** Absolute engine root (the folder holding `Engine/`). Empty falls through to the persisted binding, then the Windows registry. */
  engineRoot: Schema.string().default(''),
  /**
   * Folders scanned for .uproject candidates. Empty, or `['auto']`, means
   * zero-config discovery: the drives are swept once and the folders that
   * actually group projects are cached. `['.']` means the host's cwd.
   */
  searchRoots: Schema.array(Schema.string()).default([]),
  /** Directory depth of the candidate scan below each root. */
  searchDepth: Schema.number().min(1).max(8).default(3),
  /** Build target name. Empty means `<ProjectName>Editor` for code projects. */
  target: Schema.string().default(''),
  platform: Schema.union(['Win64', 'Linux', 'Mac']).default('Win64'),
  configuration: Schema.string().default('Development'),
  /** Appended verbatim to the build command line. */
  extraBuildArgs: Schema.string().default(''),
  /** Appended verbatim to the editor command line. */
  extraEditorArgs: Schema.string().default(''),
  /** Log ring budget, in characters. */
  maxLogChars: Schema.number().min(1000).default(200000),
})

/**
 * The runtime defaults, mirrored from `Config` on purpose.
 *
 * A profile patch replaces a row's whole `config`, and the loader does not
 * re-apply the schema defaults afterwards — a field the patch omits arrives as
 * `undefined`. Filling them here means a patch only has to state what it
 * actually pinning (`searchRoots`, say) instead of restating every field, and a
 * plugin bundled without any patch behaves like one with a full patch.
 */
const DEFAULTS = {
  projectFile: '',
  engineRoot: '',
  searchRoots: [],
  searchDepth: 3,
  discoverBudget: 24000,
  discoverDepth: 6,
  target: '',
  platform: 'Win64',
  configuration: 'Development',
  extraBuildArgs: '',
  extraEditorArgs: '',
  maxLogChars: 200000,
}

function resolveConfig(raw) {
  const merged = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object') return merged
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== null) merged[key] = value
  }
  return merged
}

const API = '/api/ue-bridge'
const LOG_LINE_LIMIT = 400
const PICK_LIMIT = 300
/** Hard ceiling on directories visited per root, so a pathological tree cannot stall the host. */
const SCAN_DIR_BUDGET = 20000

/** Directory names never worth descending into while hunting for .uproject files. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.vs', '.idea', '.vscode', 'Binaries', 'Intermediate', 'Saved',
  'DerivedDataCache', 'Engine', 'Templates', 'Programs', 'Build', 'Releases', '__pycache__', 'obj',
  '$RECYCLE.BIN', '$Recycle.Bin', 'System Volume Information', 'Config.Msi', 'Recovery',
])

/* ------------------------------------------------------------------ *
 * Zero-config root discovery
 *
 * A fresh machine has no configured roots and projects can live on any
 * drive, so a shipped path list is never portable. Instead the plugin sweeps
 * the fixed drives once — asynchronously and under a directory budget, so the
 * host keeps serving — keeps the folders that actually group .uproject files,
 * and caches them under `~/.dsh/ue-bridge/roots.json`. Later scans touch only
 * those folders, which costs milliseconds, and the cache expires so projects
 * added or moved in the meantime are still picked up.
 * ------------------------------------------------------------------ */

/** Extra directories skipped during the expensive whole-drive sweep. */
const AUTO_SKIP = new Set([
  ...SKIP_DIRS,
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users', 'PerfLogs',
  'MSOCache', 'Intel', 'AMD', 'NVIDIA', 'DRIVERS', 'Drivers', 'hp', 'Dell', 'swtools',
  'OneDriveTemp', '$WinREAgent', 'Documents and Settings', 'Boot', 'EFI', 'AppData',
  '.pnpm-store', '.cache', '.gradle', '.nuget', 'AzureData', 'Recovery',
])

/** Deep enough for `Root/Team/Project/Project.uproject`; the budget caps the cost. */
const DISCOVER_DEPTH = 6
const DISCOVER_DIR_BUDGET = 12_000
const DISCOVERED_ROOT_LIMIT = 24
const ROOTS_TTL_MS = 6 * 60 * 60 * 1000

const rootsCachePath = () => join(dshHome(), 'ue-bridge', 'roots.json')

/** Drives to sweep: every mounted letter on Windows, the user tree elsewhere. */
function fixedDrives() {
  if (process.platform !== 'win32') {
    return ['/', join(homedir(), 'Documents')].filter((entry) => isDirectory(entry))
  }
  const drives = []
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:${sep}`
    if (isDirectory(root)) drives.push(root)
  }
  return drives
}

/**
 * How much of the sweep budget a seed deserves. The OS drive is mostly system
 * noise (its `Users` tree is seeded explicitly below), so it gets a fraction —
 * that is what keeps the data drives from being starved on a machine where the
 * projects sit on `D:`/`E:`/`F:`.
 */
function seedWeight(seed) {
  const system = (process.env.SystemDrive ?? 'C:').toLowerCase()
  if (seed.toLowerCase().startsWith(system)) return 0.15
  return /^[A-Za-z]:[\\/]?$/u.test(seed) ? 1 : 0.5
}

/** Places projects hide that a drive sweep deliberately skips (`Users` among them). */
const seedRoots = () => [
  join(homedir(), 'UnrealProjects'),
  join(homedir(), 'Documents', 'Unreal Projects'),
  join(homedir(), 'Documents', 'UnrealProjects'),
  join(homedir(), 'Desktop'),
  join(homedir(), 'Downloads'),
]

/**
 * The folder grouping a project, given one .uproject path: `D:/Root/Group/Game/Game.uproject`
 * yields `D:/Root/Group`, while a project sitting directly on a drive keeps its own folder
 * rather than degrading into a sweep of the whole drive.
 */
function groupingRootOf(projectFile) {
  const parent = dirname(dirname(projectFile))
  return parent === dirname(parent) ? dirname(projectFile) : parent
}

/**
 * Drop roots already covered by a shorter one: with `D:/Group` kept,
 * `D:/Group/Game` would only re-walk directories the parent already walks.
 * Shorter roots win, so the merged list stays both complete and cheap.
 */
function collapseRoots(candidates) {
  const byKey = new Map()
  for (const root of candidates) {
    const key = root.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, root)
  }
  const sorted = [...byKey.entries()].sort((left, right) => left[0].length - right[0].length)
  const kept = []
  for (const [key, root] of sorted) {
    const covered = kept.some((entry) => key === entry.key
      || key.startsWith(`${entry.key}${sep}`)
      || key.startsWith(`${entry.key}/`))
    if (!covered) kept.push({ key, root })
  }
  return kept.map((entry) => entry.root).sort((left, right) => left.localeCompare(right))
}

/**
 * Breadth-first walk that yields between directories, so the host keeps
 * answering requests. BFS matters more than it looks: the directory budget is
 * finite, and going wide first means the shares are spent on the shallow
 * levels where projects actually live, instead of drilling one deep branch.
 */
async function walkForProjects(seed, depth, budget) {
  const projects = []
  const queue = [[seed, depth]]
  let head = 0

  while (head < queue.length && budget.left > 0) {
    const [dir, remaining] = queue[head]
    head += 1
    budget.left -= 1

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      /* An unreadable directory is expected on a real machine; a missing import
         or a typo is not, and must not be swallowed into a silently empty sweep. */
      if (typeof error?.code !== 'string') throw error
      continue
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (remaining > 0 && shouldDescend(entry.name) && !AUTO_SKIP.has(entry.name)) {
          queue.push([full, remaining - 1])
        }
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.uproject')) projects.push(full)
    }
  }
  return projects
}

/**
 * Sweep the machine once and return the de-duplicated grouping folders.
 * Each seed gets an equal share of the remaining budget, so a huge `C:/` cannot
 * starve the drive that actually holds the projects.
 */
async function discoverProjectRoots(config = {}) {
  const total = Number(config.discoverBudget) > 0 ? Number(config.discoverBudget) : DISCOVER_DIR_BUDGET
  const depth = Number(config.discoverDepth) > 0 ? Number(config.discoverDepth) : DISCOVER_DEPTH
  const budget = { left: total }
  const seeds = [...fixedDrives(), ...seedRoots()].filter((entry) => isDirectory(entry))
  const weights = seeds.map((seed) => seedWeight(seed))
  let remainingWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const roots = []
  const seen = new Set()

  for (let index = 0; index < seeds.length; index += 1) {
    const share = Math.max(400, Math.round(budget.left * (weights[index] / Math.max(remainingWeight, 0.001))))
    remainingWeight -= weights[index]
    const local = { left: share }
    const projects = await walkForProjects(seeds[index], depth, local)
    budget.left -= share - local.left

    for (const project of projects) {
      const root = groupingRootOf(project)
      const key = root.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      roots.push(root)
    }
    if (budget.left <= 0) break
  }

  return collapseRoots(roots).slice(0, DISCOVERED_ROOT_LIMIT)
}

let rootsCache = null
let rootsLoaded = false

function loadRootsCache() {
  if (rootsLoaded) return rootsCache
  rootsLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(rootsCachePath(), 'utf8'))
    const fresh = typeof parsed?.at === 'number' && Date.now() - parsed.at < ROOTS_TTL_MS
    if (fresh && Array.isArray(parsed.roots)) {
      rootsCache = { at: parsed.at, roots: parsed.roots.filter((entry) => typeof entry === 'string') }
    }
  } catch {
    rootsCache = null
  }
  return rootsCache
}

function storeRoots(roots) {
  rootsCache = { at: Date.now(), roots }
  rootsLoaded = true
  try {
    mkdirSync(dirname(rootsCachePath()), { recursive: true })
    writeFileSync(rootsCachePath(), `${JSON.stringify(rootsCache, null, 2)}\n`, 'utf8')
  } catch {
    /* an unwritable DSH_HOME only costs one re-discovery on the next launch */
  }
}

function forgetRoots() {
  rootsCache = null
  rootsLoaded = true
  try {
    rmSync(rootsCachePath(), { force: true })
  } catch {
    /* nothing had been persisted */
  }
}

/** Where the candidate scan currently looks, and why it looks there. */
function rootsState(config) {
  const configured = Array.isArray(config.searchRoots)
    ? config.searchRoots.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : []
  const explicit = configured.filter((entry) => entry.toLowerCase() !== 'auto')
  if (explicit.length > 0) return { source: 'config', roots: explicit }

  const cached = loadRootsCache()
  return cached === null ? { source: 'auto-pending', roots: [] } : { source: 'auto', roots: cached.roots }
}

let discovery = null

/**
 * Run the sweep at most once at a time. `onDiscovered` fires when fresh roots
 * land, letting the caller drop binding/scan results computed without them.
 * Never rejects — a failed sweep simply leaves the state pending.
 */
function ensureRoots(config, onDiscovered) {
  if (rootsState(config).source !== 'auto-pending') return Promise.resolve(rootsState(config))
  if (discovery !== null) return discovery
  discovery = (async () => {
    try {
      storeRoots(await discoverProjectRoots(config))
      if (typeof onDiscovered === 'function') onDiscovered()
    } catch {
      /* the per-directory guard already swallows the common failures */
    } finally {
      discovery = null
    }
    return rootsState(config)
  })()
  return discovery
}

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

const bindingPath = () => join(dshHome(), 'ue-bridge', 'binding.json')

function readBinding() {
  try {
    const parsed = JSON.parse(readFileSync(bindingPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeBinding(patch) {
  const next = { ...readBinding(), ...patch }
  try {
    mkdirSync(dirname(bindingPath()), { recursive: true })
    writeFileSync(bindingPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `无法写入绑定文件：${messageOf(error)}` }
  }
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

function absolute(target) {
  if (typeof target !== 'string' || target.trim() === '') return ''
  return isAbsolute(target) ? resolve(target) : resolve(process.cwd(), target)
}

function statOf(target) {
  try {
    return statSync(target)
  } catch {
    return null
  }
}

const isFile = (target) => statOf(target)?.isFile() === true
const isDirectory = (target) => statOf(target)?.isDirectory() === true

/** Split a command-line fragment into arguments, honouring simple quoting. */
function splitArgs(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  const out = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu
  let match
  while ((match = pattern.exec(value)) !== null) out.push(match[1] ?? match[2] ?? match[3])
  return out
}

/** Read the .uproject document; returns null when it is unreadable or malformed. */
function readProject(projectFile) {
  try {
    const parsed = JSON.parse(readFileSync(projectFile, 'utf8').replace(/^\uFEFF/u, ''))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Project discovery
 * ------------------------------------------------------------------ */

function shouldDescend(entryName) {
  return !SKIP_DIRS.has(entryName) && !entryName.startsWith('.')
}

/**
 * Collect `.uproject` files under the given roots, newest first.
 * Pure and synchronous: the browser polls the snapshot far more often than a
 * tree changes, so callers cache the result (see `Caches` below).
 */
function scanProjects(roots, depth) {
  const results = []
  const seen = new Set()

  const record = (full) => {
    const key = full.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const document = readProject(full)
    results.push({
      path: full,
      name: basename(full, '.uproject'),
      engineAssociation: typeof document?.EngineAssociation === 'string' ? document.EngineAssociation : '',
      mtime: statOf(full)?.mtimeMs ?? 0,
    })
  }

  const walk = (dir, remaining, budget) => {
    if (budget.left <= 0) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    budget.left -= 1
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (remaining > 0 && shouldDescend(entry.name)) walk(full, remaining - 1, budget)
        continue
      }
      if (entry.name.toLowerCase().endsWith('.uproject')) record(full)
    }
  }

  for (const root of roots) {
    const target = absolute(root)
    if (target === '' || !isDirectory(target)) continue
    walk(target, depth, { left: SCAN_DIR_BUDGET })
  }
  results.sort((left, right) => right.mtime - left.mtime)
  return results
}

function searchRootsOf(config) {
  return rootsState(config).roots
}

/* ------------------------------------------------------------------ *
 * Engine resolution
 * ------------------------------------------------------------------ */

const isEngineRoot = (candidate) =>
  typeof candidate === 'string'
  && candidate !== ''
  && (isFile(join(candidate, 'Engine', 'Build', 'BatchFiles', 'Build.bat'))
    || isFile(join(candidate, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe')))

/** The engine's own version string, read from `Engine/Build/Build.version`. */
function engineVersionOf(engineRoot) {
  if (engineRoot === '') return ''
  try {
    const version = JSON.parse(readFileSync(join(engineRoot, 'Engine', 'Build', 'Build.version'), 'utf8'))
    return [version.MajorVersion, version.MinorVersion, version.PatchVersion]
      .filter((part) => part !== undefined)
      .join('.')
  } catch {
    return ''
  }
}

let registryCache = { at: 0, roots: [] }
const REGISTRY_TTL_MS = 300_000

/**
 * Engine installations Windows already knows about.
 * - `HKLM\SOFTWARE\EpicGames\Unreal Engine\<version>` -> `InstalledDirectory`
 * - `HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds`    -> `<GUID|name>` = absolute path
 * Returns a map keyed by both the version string and the GUID/name, so an
 * .uproject `EngineAssociation` of either shape resolves directly.
 */
function registryEngines() {
  if (Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.roots
  const map = new Map()
  if (process.platform === 'win32') {
    const queries = [
      ['HKLM\\SOFTWARE\\EpicGames\\Unreal Engine', '/s'],
      ['HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds', '/s'],
    ]
    for (const args of queries) {
      const result = spawnSync('reg', ['query', ...args], { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
      if (result.status !== 0 || typeof result.stdout !== 'string') continue
      let section = ''
      for (const raw of result.stdout.split(/\r?\n/u)) {
        const line = raw.trim()
        if (line.startsWith('HKEY')) {
          section = line
          continue
        }
        const value = /^(\S+)\s+REG_SZ\s+(.*)$/u.exec(line)
        if (value === null) continue
        const [, key, data] = value
        const directory = data.trim()
        if (key === 'InstalledDirectory') {
          const version = section.slice(section.lastIndexOf('\\') + 1)
          if (version !== '') map.set(version, directory)
        } else if (isAbsolute(directory)) {
          map.set(key, directory)
        }
      }
    }
  }
  registryCache = { at: Date.now(), roots: map }
  return map
}

/** Fixed drive letters probed when nothing more precise is known. */
const PROBE_DRIVES = ['C', 'D', 'E', 'F', 'G', 'H']

function engineCandidates(association, registry) {
  const value = typeof association === 'string' ? association.trim() : ''
  const out = []
  if (value !== '') {
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) {
      out.push(absolute(value))
    }
    const known = registry.get(value)
    if (typeof known === 'string') out.push(absolute(known))
    for (const drive of PROBE_DRIVES) {
      const root = `${drive}:${sep}`
      out.push(join(root, `UE_${value}`), join(root, `UE${value}`))
      out.push(join(root, 'Epic Games', `UE_${value}`))
      out.push(join(root, 'Program Files', 'Epic Games', `UE_${value}`))
      out.push(join(root, 'UnrealEngine', `UE_${value}`))
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Binding resolution
 * ------------------------------------------------------------------ */

/** A code project needs a compiled target; a blueprint-only project compiles its blueprints. */
function detectCodeProject(projectDir, project, projectName) {
  const modules = Array.isArray(project?.Modules) ? project.Modules : []
  if (modules.some((module) => module !== null && typeof module === 'object' && typeof module.Type === 'string')) return true
  const sourceDir = join(projectDir, 'Source')
  if (!isDirectory(sourceDir)) return false
  const walk = (dir, remaining) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (remaining > 0 && walk(join(dir, entry.name), remaining - 1)) return true
        continue
      }
      if (entry.name.toLowerCase().endsWith('.target.cs')) return true
    }
    return false
  }
  return walk(sourceDir, 2) || projectName === ''
}

const emptyBinding = (source, error) => ({
  ok: false,
  source,
  projectFile: '',
  projectName: '',
  projectDir: '',
  engineRoot: '',
  engineVersion: '',
  engineSource: 'none',
  engineAssociation: '',
  buildMode: 'unknown',
  target: '',
  error,
})

function finishBinding(config, projectFile, source, persisted) {
  const base = {
    ...emptyBinding(source, ''),
    projectFile,
    projectName: basename(projectFile, '.uproject'),
    projectDir: dirname(projectFile),
  }

  const project = readProject(projectFile)
  if (project === null) return { ...base, error: `无法解析工程文件：${projectFile}` }
  base.engineAssociation = typeof project.EngineAssociation === 'string' ? project.EngineAssociation : ''

  const isCode = detectCodeProject(base.projectDir, project, base.projectName)
  base.buildMode = isCode ? 'code' : 'blueprint'
  base.target = isCode ? (config.target.trim() !== '' ? config.target.trim() : `${base.projectName}Editor`) : ''

  const explicit = absolute(config.engineRoot)
  const persistedEngine = absolute(persisted.engineRoot)
  if (explicit !== '') {
    if (!isEngineRoot(explicit)) return { ...base, error: `引擎目录无效：${explicit}` }
    base.engineRoot = explicit
    base.engineSource = 'config'
  } else if (persistedEngine !== '' && isEngineRoot(persistedEngine)) {
    base.engineRoot = persistedEngine
    base.engineSource = 'binding'
  } else {
    const hit = engineCandidates(base.engineAssociation, registryEngines()).find((candidate) => isEngineRoot(candidate))
    if (hit !== undefined) {
      base.engineRoot = hit
      base.engineSource = 'registry'
    }
  }

  base.engineVersion = engineVersionOf(base.engineRoot)
  if (base.engineRoot === '') {
    base.error = base.engineAssociation === ''
      ? '无法确定引擎目录：工程未声明 EngineAssociation，请在插件配置里填写 engineRoot'
      : `无法确定引擎目录：EngineAssociation="${base.engineAssociation}"，请在插件配置里填写 engineRoot`
    return base
  }
  base.ok = true
  return base
}

/**
 * The binding currently in force.
 * Precedence: persisted pick (the UI) > config.projectFile > newest auto-detected .uproject.
 */
function resolveBinding(config) {
  const persisted = readBinding()

  const persistedFile = absolute(persisted.projectFile)
  if (persistedFile !== '' && isFile(persistedFile)) return finishBinding(config, persistedFile, 'binding', persisted)

  const configured = absolute(config.projectFile)
  if (configured !== '' && isFile(configured)) return finishBinding(config, configured, 'config', persisted)

  const candidates = scanProjects(searchRootsOf(config), config.searchDepth)
  if (candidates.length > 0) return finishBinding(config, candidates[0].path, 'auto', persisted)

  return emptyBinding(
    'none',
    configured !== ''
      ? `工程文件不存在：${configured}`
      : '未找到 .uproject，请在插件配置的 searchRoots 或界面里绑定一个工程',
  )
}

/* ------------------------------------------------------------------ *
 * Command plans — pure, so each action's exact spawn shape is assertable
 * ------------------------------------------------------------------ */

const quoted = (value) => `"${value}"`

/** The engine's host-platform binary folder; the editor is not always Win64. */
const editorBinaryDir = () => (process.platform === 'win32' ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux')

export function planBuild(config, binding) {
  if (!binding.ok) throw new Error(binding.error)
  const extras = splitArgs(config.extraBuildArgs)

  if (binding.buildMode === 'blueprint') {
    const cmd = process.platform === 'win32' ? 'UnrealEditor-Cmd.exe' : 'UnrealEditor-Cmd'
    const exe = join(binding.engineRoot, 'Engine', 'Binaries', editorBinaryDir(), cmd)
    if (!isFile(exe)) throw new Error(`找不到 ${cmd}：${exe}`)
    return {
      mode: 'blueprint',
      target: '',
      label: '编译蓝图',
      command: exe,
      args: [
        binding.projectFile, '-run=CompileAllBlueprints',
        '-unattended', '-nopause', '-NullRHI', '-stdout', '-FullStdOutLogOutput',
        ...extras,
      ],
      verbatim: false,
      cwd: binding.projectDir,
    }
  }

  const bat = join(binding.engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat')
  if (!isFile(bat)) throw new Error(`找不到 Build.bat：${bat}`)
  const tail = [
    binding.target,
    config.platform,
    config.configuration,
    `-Project=${quoted(binding.projectFile)}`,
    '-WaitMutex',
    '-FromMsBuild',
    ...extras,
  ].join(' ')
  return {
    mode: 'code',
    target: binding.target,
    label: `${binding.target} ${config.platform} ${config.configuration}`,
    command: process.platform === 'win32' ? 'cmd.exe' : bat,
    args: process.platform === 'win32'
      ? ['/d', '/s', '/c', `call ${quoted(bat)} ${tail}`]
      : [binding.target, config.platform, config.configuration, `-Project=${binding.projectFile}`, '-WaitMutex', ...extras],
    verbatim: process.platform === 'win32',
    cwd: binding.projectDir,
  }
}

export function planEditor(config, binding) {
  if (!binding.ok) throw new Error(binding.error)
  const name = process.platform === 'win32' ? 'UnrealEditor.exe' : 'UnrealEditor'
  const exe = join(binding.engineRoot, 'Engine', 'Binaries', 'Win64', name)
  if (!isFile(exe)) throw new Error(`找不到 ${name}：${exe}`)
  return {
    command: exe,
    args: [binding.projectFile, ...splitArgs(config.extraEditorArgs)],
    verbatim: false,
    cwd: binding.projectDir,
  }
}

/* ------------------------------------------------------------------ *
 * Runtime: log ring and child supervision
 * ------------------------------------------------------------------ */

function createRuntime() {
  return {
    build: null,
    /* A build detached by the stop button, kept until its exit event lands. */
    stopping: null,
    editor: null,
    lastBuild: null,
    lastError: '',
    log: [],
    partial: new Map(),
    seq: 0,
    /* Monotonic id of a finished build. The UI keys its "a failure just
       happened, open the log" decision off this, so the same failure can only
       raise one popup no matter how often the state is polled. */
    buildRuns: 0,
  }
}

/* UE's own verdict beats the process exit code. Under -unattended the editor
   counts unrelated project-configuration errors as a failure and still exits
   non-zero after a perfectly clean CompileAllBlueprints run, so the summary
   lines below are the only trustworthy answer. */
const COMPILE_SUMMARY = /Compiling Completed with (\d+) errors? and (\d+) warnings? and (\d+) blueprints? that failed to load/u
const COMMANDLET_END = /finished execution \(result (\d+)\)/u
const UBT_SUCCESS = /Result: Succeeded|BUILD SUCCESSFUL/u

/** The piece of build state that one output line reveals, or null if none. */
export function parseBuildSignal(line) {
  const text = String(line)
  const signal = {}

  const summary = COMPILE_SUMMARY.exec(text)
  if (summary !== null) {
    signal.compileErrors = Number(summary[1])
    signal.blueprintsFailedToLoad = Number(summary[3])
  }

  const ended = COMMANDLET_END.exec(text)
  if (ended !== null) signal.commandletResult = Number(ended[1])

  if (UBT_SUCCESS.test(text)) signal.ubtSucceeded = true

  return Object.keys(signal).length === 0 ? null : signal
}

/** Record whatever the running build's own output says about its outcome. */
function scanBuildSignals(runtime, line) {
  const build = runtime.build
  if (build === null || build === undefined) return
  const signal = parseBuildSignal(line)
  if (signal !== null) Object.assign(build.signals, signal)
}

/**
 * Fold the raw exit code and UE's own verdict into a result the UI can show.
 * Zero is always a success. A non-zero code still counts as a success when the
 * engine itself reported one, which is how an unattended run of the blueprint
 * commandlet behaves after tripping over unrelated project-configuration errors.
 */
export function classifyBuild(mode, code, signals) {
  const exitCode = code === null || code === undefined ? -1 : Number(code)
  if (exitCode === 0) return { ok: true, exitCode, verdict: '' }

  const clean = signals ?? {}
  if (mode === 'blueprint' && clean.commandletResult === 0 && clean.compileErrors === 0) {
    return {
      ok: true,
      exitCode,
      verdict: '蓝图 0 编译错误；无人值守模式下 UE 把工程配置类 Error 计为 Failure，故退出码非 0',
    }
  }
  if (mode === 'code' && clean.ubtSucceeded === true) {
    return { ok: true, exitCode, verdict: 'UBT 报告构建成功，但进程退出码非 0' }
  }
  return { ok: false, exitCode, verdict: '' }
}

/** Most failure reasons a single build can contribute; the rest is in the log. */
const ERROR_LINE_LIMIT = 30

/* UE prints its own `Error:` lines, while MSVC / UBT / MSBuild prefix theirs
   with a tool code (`error C2065`, `error LNK2019`, `error MSB3073`), so the
   test is a shape match instead of a fixed list. Counter lines are excluded on
   purpose: "Compiling Completed with 0 errors" is the engine reporting a clean
   run and must never read as a failure reason. */
const ERROR_LINE = [
  /\bError:\s/u,                     // LogSomething: Error: <message>
  /\berror\s+[A-Z]{1,4}\d{3,}\b/u,   // error C2065 / LNK2019 / MSB3073
  /\bfatal error\b/iu,
  /^\s*Result:\s*Failed\b/u,
  /\bFailure\s*-\s*\d+\s*error/iu,
  /\b[1-9]\d*\s+errors?\b/u,         // Compiling Completed with 2 errors ...
  /\bbuild (?:has )?failed\b/iu,
  /\bFailed to (?:build|compile|link)\b/iu,
]
const ERROR_LINE_SKIP = [
  /\b0\s+errors?\b/iu,
  /\bno\s+errors?\b/iu,
  /\berrors?\(s\):\s*0\b/iu,
]

/** Is this output line a failure reason worth surfacing in the popup? */
export function isBuildErrorLine(line) {
  const text = String(line ?? '')
  if (text.trim() === '') return false
  for (const skip of ERROR_LINE_SKIP) if (skip.test(text)) return false
  for (const hit of ERROR_LINE) if (hit.test(text)) return true
  return false
}

/** Collect the reasons a running build reports, bounded and deduplicated. */
function recordBuildError(build, line) {
  if (build === null || build === undefined) return
  if (!isBuildErrorLine(line)) return
  build.errorCount += 1
  const text = String(line).trim().slice(0, 400)
  if (build.errors.length >= ERROR_LINE_LIMIT) return
  if (build.errors[build.errors.length - 1] === text) return
  build.errors.push(text)
}

/**
 * Fold the process outcome and everything the build said about itself into the
 * single shape the UI renders: the lamp's colour, the elapsed time, and the
 * reasons behind a failure.
 */
export function finalizeBuild(mode, label, code, build, now) {
  const verdict = classifyBuild(mode, code, build?.signals ?? {})
  return {
    ok: verdict.ok,
    code: verdict.exitCode,
    at: now,
    ms: now - (build?.startedAt ?? now),
    mode,
    label,
    run: build?.run ?? 0,
    verdict: verdict.verdict,
    errors: [...(build?.errors ?? [])],
    errorCount: build?.errorCount ?? 0,
  }
}

/**
 * A build the user stopped by hand is neither a success nor a failure. The kill
 * arrives as just another non-zero exit, so without this the row would turn red
 * and pop up a log full of messages that were never a verdict.
 */
export function markStopped(result, finished) {
  if (finished?.stopRequested !== true) return result
  return { ...result, stopped: true, errors: [], errorCount: 0, verdict: '手动停止' }
}

/** Append one complete line and enforce both log budgets. */
function pushLine(runtime, config, stream, line) {
  scanBuildSignals(runtime, line)
  recordBuildError(runtime.build, line)
  runtime.seq += 1
  runtime.log.push({ seq: runtime.seq, at: Date.now(), stream, line: String(line).slice(0, 2000) })
  if (runtime.log.length > LOG_LINE_LIMIT) runtime.log.splice(0, runtime.log.length - LOG_LINE_LIMIT)

  const budget = Number(config.maxLogChars) > 0 ? Number(config.maxLogChars) : DEFAULTS.maxLogChars
  let total = 0
  for (let index = runtime.log.length - 1; index >= 0; index -= 1) {
    total += runtime.log[index].line.length
    if (total > budget) {
      runtime.log.splice(0, index + 1)
      break
    }
  }
}

/** The plugin's own messages are whole lines; child output arrives in chunks. */
const note = (runtime, config, line) => pushLine(runtime, config, 'out', line)

function appendLog(runtime, config, stream, text) {
  const chunk = String(text)
  if (chunk === '') return
  const buffered = (runtime.partial.get(stream) ?? '') + chunk
  const parts = buffered.split(/\r?\n/u)
  runtime.partial.set(stream, parts.pop() ?? '')

  for (const line of parts) {
    if (line.trim() === '') continue
    pushLine(runtime, config, stream, line)
  }
}

function pipeChild(runtime, config, child) {
  for (const [name, source] of [['out', child.stdout], ['err', child.stderr]]) {
    if (source === null || source === undefined) continue
    source.setEncoding('utf8')
    source.on('data', (chunk) => appendLog(runtime, config, name, chunk))
  }
}

/** Take down a child and everything it spawned (MSBuild and UBT both fork). */
function killTree(child) {
  if (child === null || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => {})
    } catch {
      /* fall through to the handle below */
    }
  }
  try {
    child.kill()
  } catch {
    /* already gone, or the tree kill covered it */
  }
}

const uptimeOf = (start) => (start === null ? 0 : Date.now() - start)

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

const isLoopback = (req) => {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === ''
}

/** Reject cross-origin callers: these routes run shell commands. */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

const guarded = (req) => isLoopback(req) && sameOrigin(req)

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendText(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((settle) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        settle(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return settle({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settle(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        settle(null)
      }
    })
    req.on('error', () => settle(null))
  })
}

/* ------------------------------------------------------------------ *
 * Caches — the browser polls every couple of seconds, and a candidate
 * scan over a real project tree is far too expensive to repeat per poll.
 * ------------------------------------------------------------------ */

const BINDING_TTL_MS = 3000
const PROJECTS_TTL_MS = 30_000

const bindingNow = (config, caches) => {
  if (caches.binding === null || Date.now() - caches.binding.at > BINDING_TTL_MS) {
    caches.binding = { at: Date.now(), value: resolveBinding(config) }
  }
  return caches.binding.value
}

const projectsNow = (config, caches, force = false) => {
  if (force || caches.projects === null || Date.now() - caches.projects.at > PROJECTS_TTL_MS) {
    caches.projects = {
      at: Date.now(),
      value: scanProjects(searchRootsOf(config), config.searchDepth).slice(0, PICK_LIMIT),
    }
  }
  return caches.projects.value
}

const invalidate = (caches) => {
  caches.binding = null
  caches.projects = null
}

function snapshot(config, runtime, caches) {
  const roots = rootsState(config)
  const binding = bindingNow(config, caches)
  const candidates = projectsNow(config, caches)
  return {
    now: Date.now(),
    platform: process.platform,
    binding,
    scanRoots: roots.roots.map((root) => absolute(root)),
    rootsSource: roots.source,
    discovering: discovery !== null,
    /* Echoed so the UI and a bare `curl` can both tell what the scan is doing. */
    scan: {
      source: roots.source,
      roots: roots.roots.map((root) => absolute(root)).length,
      depth: config.searchDepth,
      discoverDepth: config.discoverDepth,
      discoverBudget: config.discoverBudget,
    },
    candidateCount: candidates.length,
    build: runtime.build === null
      ? { running: false }
      : {
        running: true,
        pid: runtime.build.pid,
        elapsedMs: uptimeOf(runtime.build.startedAt),
        label: runtime.build.label,
        mode: runtime.build.mode,
      },
    editor: runtime.editor === null
      ? { running: false }
      : { running: true, pid: runtime.editor.pid, elapsedMs: uptimeOf(runtime.editor.startedAt) },
    lastBuild: runtime.lastBuild,
    lastError: runtime.lastError,
    log: runtime.log.slice(-8).map((entry) => entry.line),
  }
}

/* ------------------------------------------------------------------ *
 * Plugin body
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  /* A patch row replaces the whole config and the loader does not refill the
     schema defaults, so the defaults are applied here instead. */
  const config = resolveConfig(rawConfig)
  const runtime = createRuntime()
  const caches = { binding: null, projects: null }

  const onDiscovered = () => invalidate(caches)

  /** Answers immediately; a pending sweep keeps running and lands on the next poll. */
  const state = (req, res) => {
    void ensureRoots(config, onDiscovered)
    sendJson(res, 200, snapshot(config, runtime, caches))
  }

  /** The picker is worth a short wait, so this one waits for a pending sweep. */
  const listProjects = async (req, res) => {
    const roots = await ensureRoots(config, onDiscovered)
    sendJson(res, 200, {
      roots: roots.roots.map((root) => absolute(root)),
      source: roots.source,
      projects: projectsNow(config, caches, true),
    })
  }

  const readLog = (req, res) => sendText(res, 200, runtime.log.map((entry) => entry.line).join('\n'))

  const startBuild = () => {
    if (runtime.build !== null) return { ok: false, status: 409, message: '已有构建在运行' }
    const plan = planBuild(config, bindingNow(config, caches))
    const notes = []
    if (runtime.editor !== null) notes.push('编辑器正在运行，构建可能因文件占用失败')

    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    note(runtime, config, `$ ${plan.command} ${plan.args.join(' ')}`)
    runtime.buildRuns += 1
    runtime.build = {
      pid: child.pid,
      startedAt: Date.now(),
      label: plan.label,
      mode: plan.mode,
      child,
      signals: {},
      errors: [],
      errorCount: 0,
      run: runtime.buildRuns,
    }
    runtime.lastError = ''
    pipeChild(runtime, config, child)

    child.on('error', (error) => {
      /* Match by child, not by "whatever is in the slot": a build started right
         after a stop could otherwise inherit the previous one's outcome. */
      const started = runtime.build !== null && runtime.build.child === child ? runtime.build : null
      if (started !== null) runtime.build = null
      runtime.lastError = `构建启动失败：${messageOf(error)}`
      /* The launcher never ran, so there is no output to scan: its own message
         is the whole failure reason. */
      const result = finalizeBuild(plan.mode, plan.label, -1, started, Date.now())
      result.errors = [...(started?.errors ?? []), runtime.lastError].slice(-ERROR_LINE_LIMIT)
      result.errorCount = (started?.errorCount ?? 0) + 1
      runtime.lastBuild = result
      note(runtime, config, runtime.lastError)
    })
    child.on('exit', (code) => {
      /* `stopping` holds a build the stop button already detached: the row must
         know it was a kill, so it neither turns red nor raises a popup. */
      const finished = runtime.build !== null && runtime.build.child === child
        ? runtime.build
        : runtime.stopping !== null && runtime.stopping.child === child ? runtime.stopping : null
      if (runtime.build !== null && runtime.build.child === child) runtime.build = null
      if (runtime.stopping !== null && runtime.stopping.child === child) runtime.stopping = null
      const result = markStopped(finalizeBuild(plan.mode, plan.label, code, finished, Date.now()), finished)
      runtime.lastBuild = result
      note(
        runtime,
        config,
        `构建结束：exit ${result.code} — ${result.stopped === true ? '已停止' : result.ok ? '成功' : '失败'}${
          result.verdict === '' ? '' : `（${result.verdict}）`
        }${result.ok || result.stopped === true || result.errorCount === 0 ? '' : `，${result.errorCount} 处报错`}`,
      )
    })

    return {
      ok: true,
      status: 200,
      message: [`已开始构建：${plan.label}`, ...notes].join('；'),
      pid: child.pid,
    }
  }

  const openEditor = () => {
    if (runtime.editor !== null) {
      return { ok: true, status: 200, message: '编辑器已在运行', pid: runtime.editor.pid }
    }
    const plan = planEditor(config, bindingNow(config, caches))
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    note(runtime, config, `$ ${plan.command} ${plan.args.join(' ')}`)
    runtime.editor = { pid: child.pid, startedAt: Date.now(), child }
    runtime.lastError = ''
    pipeChild(runtime, config, child)

    child.on('error', (error) => {
      runtime.lastError = `编辑器启动失败：${messageOf(error)}`
      note(runtime, config, runtime.lastError, 'err')
      runtime.editor = null
    })
    child.on('exit', (code) => {
      runtime.editor = null
      note(runtime, config, `编辑器已退出：exit ${code}`)
    })

    return { ok: true, status: 200, message: '正在启动编辑器', pid: child.pid }
  }

  const stopAll = () => {
    const stopped = []
    if (runtime.editor !== null) {
      killTree(runtime.editor.child)
      stopped.push(`编辑器 #${runtime.editor.pid}`)
      runtime.editor = null
    }
    if (runtime.build !== null) {
      /* Hand the record to the exit handler instead of dropping it: a kill is
         not a build failure, and the handler has to be able to tell them apart.
         The row goes idle right away, which is what the button implies. */
      runtime.build.stopRequested = true
      runtime.stopping = runtime.build
      killTree(runtime.build.child)
      stopped.push(`构建 #${runtime.build.pid}`)
      runtime.build = null
    }
    if (stopped.length === 0) return { ok: true, status: 200, message: '没有正在运行的进程' }
    note(runtime, config, `已停止：${stopped.join('、')}`)
    return { ok: true, status: 200, message: `已停止：${stopped.join('、')}` }
  }

  const bind = (projectFile) => {
    const target = absolute(projectFile)
    if (target === '' || !isFile(target) || !target.toLowerCase().endsWith('.uproject')) {
      return { ok: false, status: 400, message: `不是有效的 .uproject：${String(projectFile)}` }
    }
    const written = writeBinding({ projectFile: target })
    if (!written.ok) return { ok: false, status: 500, message: written.error }
    invalidate(caches)
    const binding = bindingNow(config, caches)
    note(runtime, config, `已绑定工程：${target}`)
    return {
      ok: binding.ok,
      status: binding.ok ? 200 : 409,
      message: binding.ok ? `已绑定 ${binding.projectName}` : binding.error,
      binding,
    }
  }

  const unbind = () => {
    const written = writeBinding({ projectFile: '', engineRoot: '' })
    if (!written.ok) return { ok: false, status: 500, message: written.error }
    invalidate(caches)
    return { ok: true, status: 200, message: '已解除绑定' }
  }

  /** Drop the cached sweep and walk the drives again — the picker's escape hatch. */
  const rescan = async () => {
    forgetRoots()
    invalidate(caches)
    const roots = await ensureRoots(config, onDiscovered)
    const found = roots.roots.length
    const message = found > 0
      ? `已发现 ${found} 个工程目录`
      : '未发现工程目录，请在插件配置里填写 searchRoots'
    note(runtime, config, message)
    return { ok: found > 0, status: found > 0 ? 200 : 409, message, roots: roots.roots }
  }

  const dispatch = {
    build: startBuild,
    openEditor,
    stop: stopAll,
    bind: (body) => bind(body.projectFile),
    unbind,
    rescan,
  }

  const action = async (req, res) => {
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
    const handler = dispatch[body.action]
    if (handler === undefined) return sendJson(res, 400, { ok: false, message: `未知动作：${String(body.action)}` })
    try {
      const result = await handler(body)
      sendJson(res, result.status ?? 200, result)
    } catch (error) {
      const message = messageOf(error)
      runtime.lastError = message
      note(runtime, config, message, 'err')
      sendJson(res, 409, { ok: false, message })
    }
  }

  const forbidden = (res) => sendJson(res, 403, { ok: false, message: '仅允许本机同源访问' })

  const asGet = (handler) => (req, res) => (guarded(req) ? handler(req, res) : forbidden(res))

  const routes = [
    { kind: 'exact', path: `${API}/state`, handler: asGet(state) },
    { kind: 'exact', path: `${API}/projects`, handler: asGet(listProjects) },
    { kind: 'exact', path: `${API}/log`, handler: (req, res) => (guarded(req) ? readLog(req, res) : sendText(res, 403, 'forbidden')) },
    {
      kind: 'exact',
      path: `${API}/action`,
      handler: (req, res) => {
        if (!guarded(req)) return forbidden(res)
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '请使用 POST' })
        return action(req, res)
      },
    },
  ]

  /**
   * One effect owns every registration this plugin makes, so unloading drops
   * the routes and reaps the children in a single ordered cleanup step.
   */
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    const scanState = rootsState(config)
    note(runtime, config, scanState.source === 'auto-pending'
      ? 'ue-bridge 已就绪，正在自动发现工程目录'
      : `ue-bridge 已就绪（${scanState.source === 'config' ? '配置的' : '自动发现的'}根目录）：${scanState.roots.map((root) => absolute(root)).join(' ; ')}`)
    /* A fresh install starts with no roots; warm them without blocking the host. */
    void ensureRoots(config, onDiscovered)
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* a route may already be gone if the carrier is tearing down */
        }
      }
      killTree(runtime.editor?.child ?? null)
      killTree(runtime.build?.child ?? null)
      /* A stopped build is detached from `build` and parked here until its exit
         event lands, so unloading has to reap it too. */
      killTree(runtime.stopping?.child ?? null)
      runtime.editor = null
      runtime.build = null
      runtime.stopping = null
    }
  })
}

/** Exposed for unit tests and for `cordis_inspect` style probing. */
export const internals = {
  resolveConfig,
  resolveBinding,
  planBuild,
  planEditor,
  classifyBuild,
  parseBuildSignal,
  isBuildErrorLine,
  finalizeBuild,
  markStopped,
  scanProjects,
  engineCandidates,
  registryEngines,
  isEngineRoot,
  splitArgs,
  readProject,
  rootsState,
  searchRootsOf,
  groupingRootOf,
  collapseRoots,
  fixedDrives,
  seedRoots,
  walkForProjects,
  discoverProjectRoots,
  storeRoots,
  forgetRoots,
  rootsCachePath,
}
