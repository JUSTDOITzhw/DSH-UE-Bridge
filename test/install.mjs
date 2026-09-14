/**
 * Installer round-trip test for dsh-ue-bridge. Run with plain Node:
 *
 *   node test/install.mjs
 *
 * Exercises `bin/cli.mjs` the way a user would — install, status, re-install,
 * uninstall — against a throwaway DSH_HOME, so it never touches the real one and
 * never needs dsh, pnpm or Unreal Engine to be present.
 *
 * `PATH` is deliberately stripped of the dsh CLI before spawning, which pins the
 * registration path to the documented fallback (link dependency + bundle layer +
 * node_modules link) instead of letting the machine decide which branch runs.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const cli = join(root, 'bin', 'cli.mjs')
const repoVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

let failures = 0
const check = (label, condition, detail = '') => {
  const mark = condition ? 'ok  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail === '' ? '' : `  -> ${detail}`}`)
}

/** An environment where `dsh` cannot be found, so registration takes the fallback. */
function bareEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key]
  }
  env.PATH = process.env.SystemRoot !== undefined ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) {
    env.Path = env.PATH
  }
  return env
}

function run(args, env = bareEnv()) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, windowsHide: true })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))

/** A DSH_HOME with one initialised profile, exactly like a real machine. */
function makeDshHome() {
  const home = mkdtempSync(join(tmpdir(), 'ue-bridge-dsh-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['dsh-base'] } } }, null, 2)}\n`)

  /* The host half imports `@deepseek-ai/schemastery`, which dsh itself provides
     inside the real profile. Stubbing it here is what lets the post-deploy
     "does the host half actually load from where it now lives" check be a real
     assertion instead of a warning nobody reads. */
  const stub = join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0', type: 'module', main: 'index.js' }, null, 2)}\n`)
  writeFileSync(join(stub, 'index.js'), [
    '/* Enough of a schema builder to survive module-level `Schema.object({...})`. */',
    'const proxy = new Proxy(function () {}, {',
    '  get: (target, key) => (key === "then" ? undefined : proxy),',
    '  apply: () => proxy,',
    '  construct: () => proxy,',
    '})',
    'export default proxy',
    '',
  ].join('\n'))

  return { home, profileDir, pluginDir: join(profileDir, 'plugins', 'dsh-ue-bridge'), manifestPath: join(profileDir, 'package.json') }
}

const cleanups = []
const cleanup = (dir) => cleanups.push(dir)
process.on('exit', () => {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

/* ------------------------------------------------------------------ *
 * dry-run writes nothing
 * ------------------------------------------------------------------ */

{
  const { home, pluginDir } = makeDshHome()
  cleanup(home)
  const dry = run(['install', '--dsh-home', home, '--profile', 'web', '--dry-run'])
  check('dry-run exits 0', dry.code === 0, `exit ${dry.code}`)
  check('dry-run names the files it would copy', dry.out.includes('package.json') && dry.out.includes('index.js'))
  check('dry-run writes nothing', !existsSync(pluginDir))
}

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

const target = makeDshHome()
cleanup(target.home)
const install = run(['install', '--dsh-home', target.home, '--profile', 'web'])
check('install exits 0', install.code === 0, `exit ${install.code}`)
check('install reports the deployment', install.out.includes('已部署到'), install.out.split('\n').filter((line) => line.includes('已部署到')).join(''))

check('the plugin directory exists', existsSync(target.pluginDir))
check('the host half was copied', existsSync(join(target.pluginDir, 'index.js')))
check('the patch layer was copied', existsSync(join(target.pluginDir, 'cordis.patch.yml')))
check('the browser half was copied', existsSync(join(target.pluginDir, 'lib', 'client.js')))
check('the installer itself was copied, so it can be re-run in place', existsSync(join(target.pluginDir, 'bin', 'cli.mjs')))
check('the deployed version matches the repo', existsSync(join(target.pluginDir, 'package.json'))
  && readJson(join(target.pluginDir, 'package.json')).version === repoVersion, repoVersion)
check('tests are not deployed into the profile', !existsSync(join(target.pluginDir, 'test')))
check('the host half loads from its final location', install.out.includes('宿主半侧可加载'))
check('install prints the restart reminder', install.out.includes('重启'))

const manifest = readJson(target.manifestPath)
check('the manifest gained a link dependency', typeof manifest.dependencies?.['dsh-ue-bridge'] === 'string'
  && manifest.dependencies['dsh-ue-bridge'].startsWith('link:'), String(manifest.dependencies?.['dsh-ue-bridge']))
check('the manifest bundles list gained the plugin', manifest.dsh?.profile?.bundles?.includes('dsh-ue-bridge') === true,
  JSON.stringify(manifest.dsh?.profile?.bundles))
check('the pre-existing bundle layer survived', manifest.dsh?.profile?.bundles?.includes('dsh-base') === true)
check('the node_modules link exists', (() => {
  try {
    return lstatSync(join(target.profileDir, 'node_modules', 'dsh-ue-bridge')) !== null
  } catch {
    return false
  }
})())
check('the manifest was backed up before being rewritten',
  readdirSync(target.profileDir).some((name) => name.startsWith('package.json.bak-')),
  readdirSync(target.profileDir).filter((name) => name.startsWith('package.json.bak-')).join(' '))

/* ------------------------------------------------------------------ *
 * re-install over an existing copy: upstream removals must propagate
 * ------------------------------------------------------------------ */

{
  writeFileSync(join(target.pluginDir, 'lib', 'stale.js'), '// left over from an older version\n')
  const again = run(['install', '--dsh-home', target.home, '--profile', 'web'])
  check('re-install exits 0', again.code === 0, `exit ${again.code}`)
  check('a file dropped upstream is gone after re-install', !existsSync(join(target.pluginDir, 'lib', 'stale.js')))
  check('re-install does not duplicate the bundle entry',
    readJson(target.manifestPath).dsh.profile.bundles.filter((entry) => entry === 'dsh-ue-bridge').length === 1)
}

/* ------------------------------------------------------------------ *
 * --roots writes the patch row
 * ------------------------------------------------------------------ */

{
  const { home, profileDir } = makeDshHome()
  cleanup(home)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# hand-written patch\n- id: ue-bridge\n  config:\n    searchRoots:\n      - auto\n')
  const pinned = run(['install', '--dsh-home', home, '--profile', 'web', '--roots', 'E:/,F:/'])
  check('--roots exits 0', pinned.code === 0, `exit ${pinned.code}`)
  const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  check('--roots rewrites the row', patch.includes("'E:/'") && patch.includes("'F:/'"))
  check('--roots keeps exactly one row', patch.split(/^-\s+id:/mu).length === 2, `${patch.split(/^-\s+id:/mu).length - 1} row(s)`)
  check('--roots preserves the file header', patch.includes('# hand-written patch'))
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

{
  const status = run(['status', '--dsh-home', target.home, '--profile', 'web'])
  check('status exits 0 when deployed', status.code === 0, `exit ${status.code}`)
  check('status reports the deployed version', status.out.includes(`版本 ${repoVersion}`))
  check('status confirms the bundles entry', status.out.includes('bundles 已包含它'))
  check('status confirms the node_modules link', status.out.includes('node_modules 链接就绪'))

  const { home } = makeDshHome()
  cleanup(home)
  const missing = run(['status', '--dsh-home', home, '--profile', 'web'])
  check('status exits non-zero when nothing is deployed', missing.code === 1, `exit ${missing.code}`)
  check('status says so plainly', missing.out.includes('未部署'))
}

/* ------------------------------------------------------------------ *
 * uninstall
 * ------------------------------------------------------------------ */

{
  const gone = run(['uninstall', '--dsh-home', target.home, '--profile', 'web'])
  check('uninstall exits 0', gone.code === 0, `exit ${gone.code}`)
  check('the plugin directory is gone', !existsSync(target.pluginDir))
  const after = readJson(target.manifestPath)
  check('the link dependency is gone', after.dependencies?.['dsh-ue-bridge'] === undefined)
  check('the bundles entry is gone', after.dsh?.profile?.bundles?.includes('dsh-ue-bridge') === false)
  check('the other bundle layer is untouched', after.dsh?.profile?.bundles?.includes('dsh-base') === true)
  check('the node_modules link is gone', !existsSync(join(target.profileDir, 'node_modules', 'dsh-ue-bridge')))
  /* existsSync follows links, so a dangling one still reads as gone — lstat is
     what actually proves the link itself was removed. */
  check('the link was unlinked, not merely left dangling', (() => {
    try {
      lstatSync(join(target.profileDir, 'node_modules', 'dsh-ue-bridge'))
      return false
    } catch {
      return true
    }
  })())
}

/* ------------------------------------------------------------------ *
 * unknown input
 * ------------------------------------------------------------------ */

{
  const bogus = run(['frobnicate'])
  check('an unknown subcommand fails loudly', bogus.code === 1 && bogus.out.includes('未知子命令'))
  const flag = run(['--nope'])
  check('an unknown flag fails loudly', flag.code === 1 && flag.out.includes('未知参数'))
  const help = run(['--help'])
  check('--help exits 0', help.code === 0)
  check('--help documents all three subcommands', ['install', 'status', 'uninstall'].every((word) => help.out.includes(word)))
  const missingHome = run(['install', '--dsh-home', join(tmpdir(), 'ue-bridge-does-not-exist-xyz')])
  check('installing into a non-dsh directory fails loudly', missingHome.code === 1 && missingHome.out.includes('profile 目录'))
}

/* ------------------------------------------------------------------ *
 * --dsh-home must beat the environment's DSH_HOME
 * ------------------------------------------------------------------ */

/* Regression: the dsh CLI takes its home from the DSH_HOME variable, and
   `dsh plugin --profile <p> add` edits whichever profile lives in that home. An
   earlier revision resolved `--dsh-home` for its own layout but never forwarded
   it to the child process, so the CLI registered into the DEFAULT home while
   this installer reported success — silently editing a profile the user never
   named. The decoy home here plays the part of that default home. */
{
  const decoy = makeDshHome()
  const preferred = makeDshHome()
  /* Deliberately not bareEnv(): this branch is only reachable with the real PATH.
     On a machine without dsh the same assertions still have to hold through the
     fallback, so the test is meaningful either way. */
  const env = { ...process.env, DSH_HOME: decoy.home }

  const installed = run(['install', '--dsh-home', preferred.home, '--profile', 'web'], env)
  check('installing into a named home exits 0', installed.code === 0, `exit ${installed.code}`)

  const got = readJson(preferred.manifestPath)
  check('--dsh-home wins over DSH_HOME in the environment',
    got.dsh?.profile?.bundles?.includes('dsh-ue-bridge') === true,
    JSON.stringify(got.dsh?.profile?.bundles))
  const linkValue = (got.dependencies?.['dsh-ue-bridge'] ?? '').replace(/\\/gu, '/')
  check('the link dependency points at the requested home',
    linkValue === `link:${preferred.pluginDir}`.replace(/\\/gu, '/'),
    linkValue)

  const untouched = readJson(decoy.manifestPath)
  check('the home named only by the environment keeps its bundle list',
    untouched.dsh?.profile?.bundles?.join(',') === 'dsh-base',
    JSON.stringify(untouched.dsh?.profile?.bundles))
  check('no dependency was written into that other home',
    untouched.dependencies?.['dsh-ue-bridge'] === undefined)
  check('no plugin directory was written into that other home', !existsSync(decoy.pluginDir))
  check('no node_modules link was written into that other home',
    !existsSync(join(decoy.profileDir, 'node_modules', 'dsh-ue-bridge')))

  cleanup(decoy.home)
  cleanup(preferred.home)
}

/* ------------------------------------------------------------------ *
 * running from a node_modules path (the npx and global-install layout)
 * ------------------------------------------------------------------ */

/* Regression: the tree copy used to skip anything whose absolute path merely
   *contained* a `node_modules` segment. npm installs this package under
   `_npx/<hash>/node_modules/<name>`, so when the installer ran from where npx
   actually put it, every entry was filtered out: the target was left empty while
   the run still reported a successful deploy. Stage the package at that shape and
   insist the tree really lands. */
{
  const staged = mkdtempSync(join(tmpdir(), 'ue-bridge-npx-'))
  const nestedRoot = join(staged, '_npx', 'deadbeef', 'node_modules', 'dsh-ue-bridge')
  mkdirSync(dirname(nestedRoot), { recursive: true })
  cpSync(root, nestedRoot, {
    recursive: true,
    filter: (entry) => {
      const rel = entry.slice(root.length)
      return rel === '' || !rel.split(sep).includes('node_modules')
    },
  })
  check('staged source sits under a node_modules path', nestedRoot.includes(`${sep}node_modules${sep}`))

  const home = makeDshHome()
  const result = spawnSync(process.execPath, [join(nestedRoot, 'bin', 'cli.mjs'), 'install', '--dsh-home', home.home, '--profile', 'web'], {
    encoding: 'utf8',
    env: bareEnv(),
    windowsHide: true,
  })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  check('installing from a node_modules path exits 0', result.status === 0, `exit ${result.status}`)
  check('the host half really landed', existsSync(join(home.pluginDir, 'index.js')))
  check('the browser half really landed', existsSync(join(home.pluginDir, 'lib', 'client.js')))
  check('the installer really landed', existsSync(join(home.pluginDir, 'bin', 'cli.mjs')))
  check('the deployed tree loads from where it now lives', out.includes('宿主半侧可加载'), out.includes('宿主半侧加载失败') ? 'load failed' : '')

  cleanup(staged)
  cleanup(home.home)
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
