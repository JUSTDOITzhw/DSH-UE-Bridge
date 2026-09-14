/**
 * Smoke test for dsh-ue-bridge. Run with plain Node from the package root:
 *
 *   node test/smoke.mjs
 *
 * Host half: exercises the pure planning and resolution surface against a
 * synthetic .uproject, and asserts the engine registry / scan / plan shapes.
 * Browser half: loads the lazy-CJS bundle through a stubbed
 * `window.__ModuleLoader__` and renders every panel state with the GUI's own
 * React 18 pair, so a broken bundle fails here rather than at boot.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

/* Keep the plugin's own state (binding, roots cache) off the real $DSH_HOME. */
const fakeHome = mkdtempSync(join(tmpdir(), 'ue-bridge-home-'))
process.env.DSH_HOME = fakeHome
process.on('exit', () => {
  try {
    rmSync(fakeHome, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

let failures = 0
const check = (label, condition, detail = '') => {
  const mark = condition ? 'ok  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail === '' ? '' : `  -> ${detail}`}`)
}

/* ------------------------------------------------------------------ *
 * Host half
 * ------------------------------------------------------------------ */

const { internals } = await import(new URL('../index.js', import.meta.url).href)

const scratch = mkdtempSync(join(tmpdir(), 'ue-bridge-'))
const projectDir = join(scratch, 'SampleGame')
mkdirSync(join(projectDir, 'Source', 'SampleGame'), { recursive: true })
writeFileSync(
  join(projectDir, 'SampleGame.uproject'),
  JSON.stringify({ FileVersion: 3, EngineAssociation: '5.4', Modules: [{ Name: 'SampleGame', Type: 'Runtime' }] }),
)
writeFileSync(join(projectDir, 'Source', 'SampleGame', 'SampleGame.Target.cs'), '// target')

const projectFile = join(projectDir, 'SampleGame.uproject')

/* A synthetic engine root. Without it, binding falls back to the registry and
   the drive probe, so the suite would only pass on a machine that happens to
   have UE installed — exactly what a CI runner is not. `isEngineRoot` accepts
   either marker, and the version comes from `Engine/Build/Build.version`. */
const engineDir = join(scratch, 'UE_5.4')
mkdirSync(join(engineDir, 'Engine', 'Build', 'BatchFiles'), { recursive: true })
writeFileSync(join(engineDir, 'Engine', 'Build', 'BatchFiles', 'Build.bat'), '@echo off\r\n')

/* `planEditor` always looks under Win64, while the blueprint build uses the
   host's own binary directory — so a host-agnostic suite needs both. */
const exeSuffix = process.platform === 'win32' ? '.exe' : ''
const hostBinDir = process.platform === 'win32' ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux'
mkdirSync(join(engineDir, 'Engine', 'Binaries', hostBinDir), { recursive: true })
writeFileSync(join(engineDir, 'Engine', 'Binaries', 'Win64', `UnrealEditor${exeSuffix}`), '')
writeFileSync(join(engineDir, 'Engine', 'Binaries', hostBinDir, `UnrealEditor-Cmd${exeSuffix}`), '')
writeFileSync(
  join(engineDir, 'Engine', 'Build', 'Build.version'),
  JSON.stringify({ MajorVersion: 5, MinorVersion: 4, PatchVersion: 4 }),
)

const config = {
  projectFile,
  engineRoot: engineDir,
  searchRoots: [scratch],
  searchDepth: 3,
  target: '',
  platform: 'Win64',
  configuration: 'Development',
  extraBuildArgs: '-NoHotReload',
  extraEditorArgs: '-log',
  maxLogChars: 200000,
}

const found = internals.scanProjects([scratch], 3)
check('scan finds the scratch project', found.length === 1 && found[0].name === 'SampleGame', `${found.length} candidate(s)`)

const binding = internals.resolveBinding(config)
check('binding is ok', binding.ok === true, binding.error)
check('project name parsed', binding.projectName === 'SampleGame')
check('code project detected', binding.buildMode === 'code')
check('default target derived', binding.target === 'SampleGameEditor')
check('engine association surfaced', binding.engineAssociation === '5.4')
check('engine version read', /^\d+\.\d+/.test(binding.engineVersion), binding.engineVersion)

const args = (value) => internals.splitArgs(value)
check('splitArgs handles quoting', JSON.stringify(args('a "b c" d')) === JSON.stringify(['a', 'b c', 'd']))
check('registry probe is a Map', internals.registryEngines() instanceof Map)

if (binding.ok) {
  const build = internals.planBuild(config, binding)
  check('build uses cmd.exe on win32', process.platform !== 'win32' || build.command === 'cmd.exe')
  check('build passes the target', build.args.join(' ').includes('SampleGameEditor'))
  check('build passes -Project', build.args.join(' ').includes('-Project='))
  check('build forwards extra args', build.args.join(' ').includes('-NoHotReload'))
  check('build cwd is the project dir', build.cwd === projectDir)

  const editor = internals.planEditor(config, binding)
  check('editor points at UnrealEditor', /UnrealEditor(\.exe)?$/u.test(editor.command), editor.command)
  check('editor forwards the project and extra args', editor.args.join(' ').includes('-log'))

  // A blueprint-only project must take the CompileAllBlueprints path.
  const blueprint = { ...binding, buildMode: 'blueprint', target: '' }
  try {
    const plan = internals.planBuild(config, blueprint)
    check('blueprint build uses CompileAllBlueprints', plan.mode === 'blueprint' && plan.args.join(' ').includes('-run=CompileAllBlueprints'))
  } catch (error) {
    check('blueprint build plan', false, error.message)
  }

  const bad = { ...binding, ok: false, error: 'no engine' }
  let threw = false
  try {
    internals.planBuild(config, bad)
  } catch {
    threw = true
  }
  check('an unbound plan throws', threw)
} else {
  console.log('skip  plan assertions (no engine resolved on this host)')
}

/* Build verdict: UE's own summary outranks a non-zero exit code, because an
   unattended blueprint run reports "Failure" over unrelated config errors. */
check(
  'a clean exit is a success',
  internals.classifyBuild('code', 0, {}).ok === true,
)
check(
  'a failing blueprint run stays a failure',
  internals.classifyBuild('blueprint', 1, { commandletResult: 0, compileErrors: 3 }).ok === false,
)
check(
  'a blueprint run with a clean summary overrides exit 1',
  internals.classifyBuild('blueprint', 1, { commandletResult: 0, compileErrors: 0 }).ok === true,
)
check(
  'the override explains itself',
  internals.classifyBuild('blueprint', 1, { commandletResult: 0, compileErrors: 0 }).verdict.includes('无人值守'),
)
check(
  'a commandlet that never finished is a failure',
  internals.classifyBuild('blueprint', 1, { compileErrors: 0 }).ok === false,
)
check(
  'a C++ build trusts UBT over the exit code',
  internals.classifyBuild('code', 6, { ubtSucceeded: true }).ok === true,
)
check(
  'a C++ build with no UBT verdict fails on the exit code',
  internals.classifyBuild('code', 6, {}).ok === false,
)
check(
  'a missing exit code reads as failure',
  internals.classifyBuild('code', null, {}).ok === false,
)

/* The parser is anchored to the exact lines UE 5.8 printed on this machine, so
   a future wording change shows up here rather than silently mis-reporting. */
const REAL_SUMMARY = '[2026.09.14-06.04.21:907][  0]LogCompileAllBlueprintsCommandlet: Display: Compiling Completed with 0 errors and 0 warnings and 0 blueprints that failed to load.'
const REAL_RESULT = '[2026.09.14-06.04.21:907][  0]LogCore: Engine exit requested (reason: Commandlet CompileAllBlueprintsCommandlet_0 finished execution (result 0))'
check('parses the real blueprint summary line', internals.parseBuildSignal(REAL_SUMMARY)?.compileErrors === 0, JSON.stringify(internals.parseBuildSignal(REAL_SUMMARY)))
check('parses the real commandlet result line', internals.parseBuildSignal(REAL_RESULT)?.commandletResult === 0, JSON.stringify(internals.parseBuildSignal(REAL_RESULT)))
check('a real UBT success line is recognised', internals.parseBuildSignal('Result: Succeeded')?.ubtSucceeded === true)
check('an ordinary log line yields no signal', internals.parseBuildSignal('LogTemp: hello') === null)
check(
  'a failing blueprint summary carries its error count',
  internals.parseBuildSignal('Compiling Completed with 3 errors and 0 warnings and 1 blueprints that failed to load.')?.compileErrors === 3,
)

/* Failure reasons: the popup is only as good as what gets collected, so the
   matcher is pinned against real engine / toolchain wordings — and, just as
   important, against the clean-run counters that must never look like errors. */
const ERROR_SAMPLES = [
  '[2026.09.14-14.04.21:907][  0]LogBlueprint: Error: Failed to compile Blueprint /Game/BP_Foo',
  "D:\\Game\\Source\\Foo.cpp(12): error C2065: 'x': undeclared identifier",
  'Foo.obj : error LNK2019: unresolved external symbol',
  "fatal error C1083: Cannot open include file: 'CoreMinimal.h'",
  'Result: Failed (OtherCompilationError)',
  'Failure - 2 error(s), 0 warning(s)',
  'Compiling Completed with 2 errors and 1 warnings and 0 blueprints that failed to load.',
  'MSB3073: the command "Build.bat" exited with code 6 -> error MSB3073',
]
const missed = ERROR_SAMPLES.filter((line) => internals.isBuildErrorLine(line) !== true)
check('every failure wording is collected', missed.length === 0, missed.join(' | '))

const CLEAN_SAMPLES = [
  REAL_SUMMARY,                       // "with 0 errors" is a clean run, not a reason
  'LogTemp: Warning: deprecated API',
  'Result: Succeeded',
  '',
]
const noise = CLEAN_SAMPLES.filter((line) => internals.isBuildErrorLine(line) === true)
check('clean output never reads as a failure reason', noise.length === 0, noise.join(' | '))

const finishedBuild = internals.finalizeBuild('code', 'SampleGameEditor', 6, {
  startedAt: 1000, run: 4, signals: {}, errors: ['e1', 'e2'], errorCount: 2,
}, 5200)
check(
  'a finished build carries its id, timing and reasons',
  finishedBuild.ok === false && finishedBuild.run === 4 && finishedBuild.ms === 4200
    && finishedBuild.errors.length === 2 && finishedBuild.errorCount === 2 && finishedBuild.code === 6,
  JSON.stringify(finishedBuild),
)
check(
  'finalize copies the reasons instead of aliasing the live build',
  (() => {
    const live = { startedAt: 0, run: 1, signals: {}, errors: ['x'], errorCount: 1 }
    const out = internals.finalizeBuild('code', 'T', 0, live, 10)
    live.errors.push('late')
    return out.errors.length === 1
  })(),
)
check('a build with no record still finalises', internals.finalizeBuild('code', 'T', 1, null, 5).run === 0)

/* A manual stop is a kill, and a kill looks exactly like a failed build: a
   non-zero exit code. Without this the row would turn red and pop up a log of
   messages that were never a verdict. */
const killedBuild = { startedAt: 0, run: 7, signals: {}, errors: ['error C2065: noise'], errorCount: 1, stopRequested: true }
check(
  'a manual stop is not a failure',
  internals.markStopped(internals.finalizeBuild('code', 'T', 1, killedBuild, 100), killedBuild).stopped === true,
)
check(
  'a manual stop drops the noise it collected before the kill',
  (() => {
    const stopped = internals.markStopped(internals.finalizeBuild('code', 'T', 1, killedBuild, 100), killedBuild)
    return stopped.errors.length === 0 && stopped.errorCount === 0 && stopped.verdict === '手动停止'
  })(),
)
check(
  'an untouched result passes through the stop check unchanged',
  (() => {
    const plain = internals.finalizeBuild('code', 'T', 1, { startedAt: 0, run: 1, signals: {} }, 10)
    return internals.markStopped(plain, null).stopped === undefined
  })(),
)

/* Root discovery: the grouping rule and the cached-root state machine. */
check(
  'grouping root keeps the project group',
  internals.groupingRootOf(join('D:', 'Root', 'Group', 'Game', 'Game.uproject')) === join('D:', 'Root', 'Group'),
)
check(
  'grouping root never degrades into a drive root',
  internals.groupingRootOf(join('D:', 'Game', 'Game.uproject')) === join('D:', 'Game'),
)
check('configured roots take precedence', internals.rootsState({ searchRoots: ['E:/'] }).source === 'config')

/* A profile patch replaces the whole config and the loader does not refill the
   schema defaults, so a sparse patch must still come out complete — otherwise
   `config.target.trim()` throws and the log budget silently disappears. */
const sparse = internals.resolveConfig({ searchRoots: ['auto'] })
check(
  'a sparse config is completed with defaults',
  sparse.searchDepth === 3 && sparse.maxLogChars === 200000 && sparse.platform === 'Win64'
    && sparse.configuration === 'Development' && sparse.discoverDepth === 6,
  `searchDepth=${sparse.searchDepth} maxLogChars=${sparse.maxLogChars}`,
)
check('an absent config resolves to pure defaults', internals.resolveConfig(undefined).searchDepth === 3)
check('explicit values survive resolution', internals.resolveConfig({ searchDepth: 5 }).searchDepth === 5)
check("the literal 'auto' opts back into discovery", internals.rootsState({ searchRoots: ['auto'] }).source === 'auto-pending')

internals.storeRoots([join('D:', 'Root', 'Group')])
check('discovered roots are served from the cache', internals.rootsState({ searchRoots: [] }).source === 'auto')
check('the cache round-trips through disk', existsSync(internals.rootsCachePath()))
/* The scan itself resolves roots through this helper, so it must agree with
   `rootsState` — returning the literal 'auto' would scan a directory that does
   not exist and silently report zero projects. */
check(
  "the scan resolves 'auto' to the discovered roots",
  internals.searchRootsOf({ searchRoots: ['auto'] }).length === 1
    && internals.searchRootsOf({ searchRoots: ['auto'] })[0] === join('D:', 'Root', 'Group'),
)
check(
  'configured roots are passed through verbatim',
  internals.searchRootsOf({ searchRoots: ['E:/'] })[0] === 'E:/',
)
internals.forgetRoots()
check('forgetting the cache returns to pending', internals.rootsState({ searchRoots: [] }).source === 'auto-pending')
check('a pending scan yields no roots rather than a bogus one', internals.searchRootsOf({ searchRoots: [] }).length === 0)

rmSync(scratch, { recursive: true, force: true })

/* ------------------------------------------------------------------ *
 * Browser half
 * ------------------------------------------------------------------ */

/** Find the GUI's own React 18 pair; the bundle's `require("react")` must hit this instance. */
function findReactPair() {
  let dir = root
  for (let hops = 0; hops < 8; hops += 1) {
    const store = join(dir, 'node_modules', '.pnpm')
    if (existsSync(store)) {
      const hit = readdirSync(store).find((entry) => entry.startsWith('react-dom@18.'))
      if (hit !== undefined) {
        const pair = join(store, hit, 'node_modules')
        if (existsSync(join(pair, 'react-dom', 'server.js'))) return pair
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const pair = findReactPair()
const bundlePath = join(root, 'lib', 'client.js')

check('client bundle exists', existsSync(bundlePath))

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      captured = definition
    },
  },
}
new Function('window', readFileSync(bundlePath, 'utf8'))(globalThis.window)

check('bundle registers a factory', captured !== null && captured.id === 'dsh-ue-bridge')

if (captured === null) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

const React = pair === null ? null : require(join(pair, 'react'))
const exports_ = captured.factory((name) => (name === 'react' && React !== null ? React : require(name)))

check('bundle exports apply', typeof exports_.apply === 'function')
check('bundle injects slots', JSON.stringify(exports_.inject) === '["slots"]')

let registration = null
let injectedKey = null
exports_.apply({
  slots: {
    inject: (key, callback) => {
      injectedKey = key
      return callback()
    },
    register: (options, component) => {
      registration = { options, component }
      return () => {}
    },
  },
})

check('targets conversation.composer.dock', injectedKey === 'conversation.composer.dock')
check('registers a list cell with an id and order', registration?.options?.id === 'ue-bridge' && typeof registration?.options?.order === 'number')
check('component is a function', typeof registration?.component === 'function')

/* The lamp's pulse is the one thing an inline style cannot express, so it rides
 * in a single injected stylesheet. Assert it lands once — dsh may activate a
 * plugin more than once, and a second copy would be dead weight. */
const injectedStyles = []
globalThis.document = {
  getElementById: (id) => injectedStyles.find((node) => node.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (node) => injectedStyles.push(node) },
}
const noopSlots = { slots: { inject: () => {} } }
exports_.apply(noopSlots)
exports_.apply(noopSlots)
delete globalThis.document
check('injects exactly one stylesheet', injectedStyles.length === 1, `${injectedStyles.length} injected`)
check(
  'the stylesheet defines the keyframes the lamp names',
  String(injectedStyles[0]?.textContent).includes('@keyframes ue-bridge-lamp-pulse'),
  String(injectedStyles[0]?.textContent),
)

/* The picker's payload normalisation is pure, so assert it directly instead of
 * inferring it from markup. A host shape change once produced rows with no
 * label at all — an unclickable, unreadable blank list. */
const pickerInternals = exports_.internals || {}
check('client exposes picker internals for testing', typeof pickerInternals.normalizeProjects === 'function')

const normalize = typeof pickerInternals.normalizeProjects === 'function'
  ? pickerInternals.normalizeProjects
  : () => []
const normalized = normalize([
  { path: projectFile, name: 'SampleGame', engineAssociation: '5.4' },
  { path: 'D:\\Root\\NoName\\NoName.uproject' },
  'E:\\Plain\\String.uproject',
  { file: 'F:\\Alt\\Alt.uproject', projectName: 'Alt', engineVersion: '5.3' },
  { name: '' },
  {},
  null,
])

check('normalisation keeps every usable row', normalized.length === 4, JSON.stringify(normalized))
check(
  'normalisation derives a missing name from the .uproject basename',
  normalized[1]?.name === 'NoName' && normalized[1]?.path === 'D:\\Root\\NoName\\NoName.uproject',
  JSON.stringify(normalized[1] ?? null),
)
check(
  'normalisation accepts a bare path string',
  normalized[2]?.path === 'E:\\Plain\\String.uproject' && normalized[2]?.name === 'String',
  JSON.stringify(normalized[2] ?? null),
)
check(
  'normalisation reads alternate field names',
  normalized[3]?.path === 'F:\\Alt\\Alt.uproject'
    && normalized[3]?.name === 'Alt'
    && normalized[3]?.engineAssociation === '5.3',
  JSON.stringify(normalized[3] ?? null),
)
check(
  'a row can never come out with a blank label and path',
  normalized.every((row) => row.name !== '' && row.path !== ''),
  JSON.stringify(normalized),
)

const shapeShifted = normalize([{}, {}, {}])
check('an unusable payload yields zero rows, not blank ones', shapeShifted.length === 0, JSON.stringify(shapeShifted))
check('a version stamp is exported', /^\d+\.\d+\.\d+$/u.test(String(pickerInternals.VERSION)), String(pickerInternals.VERSION))
check(
  'the stamped version matches package.json',
  String(pickerInternals.VERSION) === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  `${pickerInternals.VERSION} vs ${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`,
)

/* The lamp is a pure state machine, so every colour the user sees is asserted
 * here rather than inferred from markup: gray = nothing built, amber = running,
 * green = clean, red = failed and worth a popup. */
const lampOf = typeof pickerInternals.buildStateOf === 'function'
  ? pickerInternals.buildStateOf
  : () => ({ kind: 'none', tone: 'idle', pulse: false, text: '', detail: '', errors: [], count: 0 })
const withLamp = (lastBuild, build = { running: false }) => ({
  binding: { ok: true }, build, editor: { running: false }, lastBuild,
})

const lampNone = lampOf(withLamp(null))
check(
  'nothing built yet → gray lamp',
  lampNone.tone === 'idle' && lampNone.kind === 'none' && lampNone.text === '尚未构建',
  JSON.stringify(lampNone),
)
check('an unreachable host is also gray, not red', lampOf(null).kind === 'none')

const lampBusy = lampOf(withLamp(null, { running: true, elapsedMs: 61000, label: '编译蓝图' }))
check(
  'a build in flight → amber, pulsing lamp',
  lampBusy.tone === 'busy' && lampBusy.pulse === true && lampBusy.kind === 'running',
  JSON.stringify(lampBusy),
)
check('the in-flight text carries the elapsed time', lampBusy.text.includes('1:01'), lampBusy.text)

const lampOk = lampOf(withLamp({
  ok: true, code: 1, at: 1, run: 2, ms: 135232,
  verdict: '蓝图 0 编译错误；无人值守模式下 UE 把工程配置类 Error 计为 Failure，故退出码非 0',
}))
check(
  'a clean build → green lamp',
  lampOk.tone === 'ok' && lampOk.pulse === false && lampOk.text.startsWith('构建成功'),
  JSON.stringify(lampOk),
)
check('the green lamp still explains an overridden exit code', lampOk.detail.includes('无人值守'), lampOk.text)

const lampBad = lampOf(withLamp({
  ok: false, code: 6, at: 2, run: 3, ms: 4200,
  errors: ['Foo.cpp(12): error C2065: undeclared identifier', 'error LNK2019: unresolved external symbol'],
  errorCount: 2,
}))
check(
  'a failed build → red lamp',
  lampBad.tone === 'error' && lampBad.kind === 'failed' && lampBad.pulse === false,
  JSON.stringify(lampBad),
)
check('the red lamp names the exit code and the reason count', lampBad.text === '构建失败 · exit 6 · 2 处报错', lampBad.text)
check(
  'the red lamp hands its reasons to the popup',
  lampBad.errors.length === 2 && lampBad.detail.includes('error C2065'),
  lampBad.text,
)
check(
  'a failure with no captured reason still reports the exit code',
  lampOf(withLamp({ ok: false, code: 1, at: 3, run: 4, ms: 10 })).text === '构建失败 · exit 1',
)
check(
  'the reported total outranks the captured count',
  lampOf(withLamp({ ok: false, code: 1, at: 4, run: 5, ms: 10, errors: ['a'], errorCount: 7 })).count === 7,
)

const lampStopped = lampOf(withLamp({ ok: false, stopped: true, code: -1, at: 5, run: 6, ms: 3000 }))
check(
  'a build the user stopped is gray, never red',
  lampStopped.tone === 'idle' && lampStopped.kind === 'stopped',
  JSON.stringify(lampStopped),
)
check('a stopped build carries no popup payload', lampStopped.errors.length === 0)

/* One popup per failure: the id must be stable across polls of the same build
 * and different for the next one, or the panel would reopen (or never open). */
const failureId = pickerInternals.buildIdOf({ ok: false, at: 1, run: 1 })
check('the same failure keeps one id', failureId !== '' && failureId === pickerInternals.buildIdOf({ ok: false, at: 1, run: 1 }))
check('a later failure gets a fresh id', failureId !== pickerInternals.buildIdOf({ ok: false, at: 2, run: 2 }))
check('a later success is never read as the failure', failureId !== pickerInternals.buildIdOf({ ok: true, at: 1, run: 1 }))
check('no build has no id', pickerInternals.buildIdOf(null) === '')

/* An older host sends no reasons at all; the popup must still render. */
check('a missing reasons field reads as none', pickerInternals.errorLinesOf({ ok: false })?.length === 0)
check('a single reason string is tolerated', pickerInternals.errorLinesOf({ errors: 'boom' })?.length === 1)
check('blank reasons are dropped', pickerInternals.errorLinesOf({ errors: ['', '  ', 'real'] })?.length === 1)


if (pair !== null) {
  const { renderToStaticMarkup } = require(join(pair, 'react-dom/server'))

  globalThis.fetch = async (url) => {
    const bound = {
      ok: true, source: 'auto', projectFile, projectName: 'SampleGame', projectDir,
      engineRoot: 'D:\\UE_5.4', engineVersion: '5.4.4', engineSource: 'registry',
      engineAssociation: '5.4', buildMode: 'code', target: 'SampleGameEditor', error: '',
    }
    const body = String(url).endsWith('/state')
      ? {
        now: Date.now(), platform: process.platform, binding: bound, scanRoots: [scratch],
        candidateCount: 1, build: { running: false }, editor: { running: false },
        lastBuild: null, lastError: '', log: [],
      }
      : { ok: true, message: 'ok' }
    return { status: 200, ok: true, json: async () => body, text: async () => '' }
  }

  /** The component's useState order is fixed, so a counter forces panels and the snapshot. */
  const renderWith = (panel, picker, logText, snapshot, pickerNote) => {
    const original = React.useState
    let counter = 0
    React.useState = (initial) => {
      counter += 1
      const forced = { 1: snapshot, 4: panel, 5: picker, 6: '', 7: logText, 8: pickerNote }[counter]
      return [forced === undefined ? (typeof initial === 'function' ? initial() : initial) : forced, () => {}]
    }
    try {
      return renderToStaticMarkup(React.createElement(registration.component))
    } finally {
      React.useState = original
    }
  }

  /** A healthy bound snapshot whose build part is the only thing that varies. */
  const rowSnapshot = (lastBuild, extra = {}) => ({
    rootsSource: 'auto', discovering: false, scanRoots: [scratch], candidateCount: 1,
    binding: {
      ok: true, source: 'auto', projectFile, projectName: 'SampleGame', projectDir,
      engineRoot: 'D:\\UE_5.4', engineVersion: '5.4.4', engineSource: 'registry',
      engineAssociation: '5.4', buildMode: 'code', target: 'SampleGameEditor', error: '',
    },
    build: { running: false }, editor: { running: false },
    lastBuild, lastError: '', log: [],
    ...extra,
  })

  const cases = [
    ['collapsed', () => renderWith('', null, ''), (markup) => markup.includes('选择 UE 工程') && markup.includes('日志')],
    ['picker with candidates', () => renderWith('picker', [{ path: projectFile, name: 'SampleGame', engineAssociation: '5.4', mtime: 1 }], ''), (markup) => markup.includes('SampleGame') && markup.includes('--dsw-elevation-panel')],
    ['picker scanning', () => renderWith('picker', null, ''), (markup) => markup.includes('扫描中')],
    ['picker empty', () => renderWith('picker', [], ''), (markup) => markup.includes('未发现 .uproject')],
    ['log panel', () => renderWith('log', null, 'LogTemp: done'), (markup) => markup.includes('LogTemp: done') && markup.includes('--dsw-font-markdown-code')],
    [
      'a build that succeeded despite a non-zero exit code reads as success',
      () => renderWith('', null, '', {
        rootsSource: 'auto', discovering: false, scanRoots: [scratch], candidateCount: 1,
        binding: {
          ok: true, source: 'auto', projectFile, projectName: 'SampleGame', projectDir,
          engineRoot: 'D:\\UE_5.4', engineVersion: '5.4.4', engineSource: 'registry',
          engineAssociation: '5.4', buildMode: 'blueprint', target: '', error: '',
        },
        build: { running: false }, editor: { running: false },
        lastBuild: {
          ok: true, code: 1, at: 0, ms: 135232, mode: 'blueprint', label: '编译蓝图',
          verdict: '蓝图 0 编译错误；无人值守模式下 UE 把工程配置类 Error 计为 Failure，故退出码非 0',
        },
        lastError: '', log: [],
      }),
      (markup) => markup.includes('构建成功') && markup.includes('无人值守')
        && markup.includes('--dsw-alias-state-success-primary'),
    ],
    [
      'a first-run row shows a gray lamp',
      () => renderWith('', null, '', rowSnapshot(null)),
      (markup) => markup.includes('尚未构建') && markup.includes('--dsw-alias-label-tertiary'),
    ],
    [
      'a build in flight turns the lamp amber and pulses it',
      () => renderWith('', null, '', rowSnapshot(null, { build: { running: true, elapsedMs: 61000, label: '编译蓝图' } })),
      (markup) => markup.includes('构建中 1:01')
        && markup.includes('--dsw-alias-state-warn-primary')
        && markup.includes('ue-bridge-lamp-pulse'),
    ],
    [
      'a failure opens the log with its reasons above the raw output',
      () => renderWith('log', null, 'LogTemp: line', rowSnapshot({
        ok: false, code: 6, at: 9, run: 2, ms: 4200, mode: 'code', label: 'SampleGameEditor',
        errors: [
          'D:\\Game\\Source\\Foo.cpp(12): error C2065: undeclared identifier',
          'Foo.obj : error LNK2019: unresolved external symbol',
        ],
        errorCount: 2,
      })),
      (markup) => markup.includes('构建失败 · exit 6 · 2 处报错')
        && markup.includes('报错 2 处')
        && markup.includes('error C2065')
        && markup.includes('完整日志')
        && markup.includes('复制')
        && markup.includes('--dsw-alias-state-error-primary'),
    ],
    [
      'a build the user stopped stays gray and opens nothing',
      () => renderWith('', null, '', rowSnapshot({ ok: false, stopped: true, code: -1, at: 10, run: 3, ms: 3000 })),
      (markup) => markup.includes('构建已停止') && !markup.includes('--dsw-alias-state-error-primary'),
    ],
    [
      'row geometry mirrors the composer card',
      () => renderWith('', null, ''),
      (markup) => markup.includes('--dsh-composer-card-max-width') && markup.includes('margin:0 auto'),
    ],
    [
      'typography uses the composer scale, not the 12px/11px one',
      () => renderWith('', null, ''),
      (markup) => markup.includes('--dsw-font-s-14')
        && markup.includes('--dsw-font-xs-13')
        && !markup.includes('--dsw-font-xxxs-11')
        && !markup.includes('--dsw-font-xxs-12'),
    ],
    [
      'discovery in flight',
      () => renderWith('', null, '', {
        rootsSource: 'auto-pending', discovering: true, scanRoots: [], candidateCount: 0,
        binding: { ok: false, source: 'none', error: '未找到 .uproject', projectFile: '', projectName: '' },
        build: { running: false }, editor: { running: false }, lastBuild: null,
      }),
      (markup) => markup.includes('正在发现工程目录'),
    ],
    [
      'picker offers a re-discovery',
      () => renderWith('picker', [], '', {
        rootsSource: 'auto', discovering: false, scanRoots: ['D:/Root/Group'], candidateCount: 0,
        binding: { ok: false, source: 'none', error: '', projectFile: '', projectName: '' },
        build: { running: false }, editor: { running: false }, lastBuild: null,
      }),
      (markup) => markup.includes('重新发现') && markup.includes('自动发现的工程目录'),
    ],
    [
      'picker rows carry the flex guard that keeps their labels readable',
      () => renderWith('picker', Array.from({ length: 40 }, (_, index) => ({
        path: `D:\\Root\\P${index}\\P${index}.uproject`, name: `P${index}`, engineAssociation: '5.4',
      })), ''),
      (markup) => markup.includes('flex:0 0 auto') && markup.includes('min-height:26px') && markup.includes('P39'),
    ],
    [
      'picker surfaces a payload problem instead of a blank list',
      () => renderWith('picker', [], '', undefined, '工程接口返回了 3 项，但没有一项带有工程路径。'),
      (markup) => markup.includes('工程接口返回了 3 项'),
    ],
    [
      'picker footer reports the candidate count',
      () => renderWith('picker', [{ path: projectFile, name: 'SampleGame' }], ''),
      (markup) => markup.includes('候选 1/1') && markup.includes(`v${pickerInternals.VERSION}`),
    ],
    [
      'the log panel prints the version, so a stale bundle is visible',
      () => renderWith('log', null, 'LogTemp: done'),
      (markup) => markup.includes(`dsh-ue-bridge v${pickerInternals.VERSION}`),
    ],
  ]

  for (const [label, render, assert] of cases) {
    try {
      const markup = render()
      check(`render: ${label}`, assert(markup), `${markup.length} chars`)
    } catch (error) {
      check(`render: ${label}`, false, error.message)
    }
  }

  const markup = renderWith('', null, '')
  const strayColours = markup.replace(/--dsw-[a-z0-9-]+/gu, '').match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/gu)
  check('no colour literals in output', strayColours === null, strayColours?.join(' ') ?? '')
} else {
  console.log('skip  render assertions (no React 18 pair reachable)')
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
