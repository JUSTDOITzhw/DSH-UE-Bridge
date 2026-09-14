# dsh-ue-bridge

[English](README.md) · [简体中文](README.zh.md)

Bind an Unreal Engine project to [dsh](https://github.com/deepseek-harness) and drive
**Build / Open Editor / Stop** from one compact row in the Web composer dock.

The row opens with a **build lamp**: gray = never built, amber pulse = building,
green = succeeded, red = failed (which also pops the error log open by itself).

```
▌ ●  SampleGame          [ Build ] [ Editor ] [ Stop ]   Development · Win64
```

## Requirements

- dsh `>= 0.1.2-rc.1` with a `web` profile (any profile name works).
- Node 18+ (only to run the installer; the plugin runs inside dsh).
- Unreal Engine installed locally. Windows is the best-supported host: the engine
  is resolved from the registry when no `engineRoot` is configured. On macOS and
  Linux the plugin falls back to drive-root probing, so pinning `engineRoot` is
  recommended there.

## Install

Any one of these is enough — one command, then restart dsh.

### 1. `npx`, straight from this repo (no clone, no registry)

```sh
npx github:JUSTDOITzhw/dsh-ue-bridge
```

`npx` fetches the repo into a temp directory and runs the installer it ships. The
installer then does the whole job itself:

1. locates dsh (`$DSH_HOME`, else `~/.dsh`), profile defaults to `web`;
2. copies the plugin to `<DSH_HOME>/profiles/<profile>/plugins/dsh-ue-bridge`;
3. registers it with the profile — preferring the official
   `dsh plugin --profile <p> add <dir>`, and falling back to writing the exact same
   end state by hand (`link:` dependency + `dsh.profile.bundles` layer +
   `node_modules` link) when the CLI or pnpm is missing;
4. verifies by really `import`ing the host half from its final location.

Once published to the npm registry the same command works as `npx dsh-ue-bridge`.

### 2. The native dsh plugin route

```sh
dsh plugin --profile web add github:JUSTDOITzhw/dsh-ue-bridge
```

`dsh plugin` is a thin pnpm forwarder that afterwards reconciles
`dsh.profile.bundles`, so registry names, `github:`, `git+https://`, tarballs and
local paths all work. This package has **no build step** — no `prepare`, no
`postinstall` — so it never trips pnpm's `allowBuilds` gate that otherwise blocks
git-hosted plugins.

### 3. Global install

```sh
npm i -g dsh-ue-bridge
dsh-ue-bridge install
```

### Options

| Flag | Meaning |
| --- | --- |
| `--profile <name>` | target profile, default `web` |
| `--dsh-home <path>` | non-default `DSH_HOME` |
| `--roots "E:/,F:/"` | pin the `.uproject` scan roots instead of auto-discovery |
| `--engine D:/UE_5.4` | pin the engine root |
| `--no-register` | copy files only, leave the profile manifest alone |
| `--dry-run` | print what would happen, write nothing |
| `-h` / `-v` | help / version |

```sh
npx github:JUSTDOITzhw/dsh-ue-bridge status      # version, bundles entry, links, patch row
npx github:JUSTDOITzhw/dsh-ue-bridge uninstall   # also drops the patch row and the node_modules link
```

Then start `dsh --profile <profile>` and open any session — the row is right under
the composer.

**Nothing has to be configured on a new machine.** On first open the plugin scans
the local disks for `.uproject` files (about a second, asynchronous, never blocking
the host) and caches the findings in `<DSH_HOME>/ue-bridge/roots.json`, rescanning
after 6 hours. The engine comes from the Windows registry, also without manual
input.

## Layout

| Half | Entry | Responsibility |
| --- | --- | --- |
| Host | `index.js` (`exports "."`) | project binding, engine resolution, disk discovery, process control, ring-buffered log, `/api/ue-bridge/*` routes |
| Browser | `lib/client.js` (`exports "./client"`) | contributes one row into the `conversation.composer.dock` slot |
| Installer | `bin/cli.mjs` (package `bin`) | cross-platform install / status / uninstall, zero dependencies |

The browser half is a loader lazy-CJS factory product (`window.__ModuleLoader__.load`)
that only `require`s `react`, so it stays free of other plugins' runtime values.
Styling uses `--dsw-alias-*` semantic tokens exclusively: no colour literals, no
light/dark branches.

## HTTP API

Registered through `ctx.webServer.register`; same-origin loopback requests only.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/ue-bridge/state` | binding, child process, last build result, log tail |
| GET | `/api/ue-bridge/projects` | `.uproject` candidates under the scan roots (waits for discovery in flight) |
| GET | `/api/ue-bridge/log` | full log (bounded ring buffer) |
| POST | `/api/ue-bridge/action` | `{ action: 'build' \| 'openEditor' \| 'stop' \| 'bind' \| 'unbind' \| 'rescan' }` |

`lastBuild` is the only source of truth for the lamp:

```jsonc
{
  "ok": false,             // UE's own conclusion outranks the exit code
  "code": 6,               // exit code (-1 = never seen)
  "ms": 4200,              // duration
  "mode": "code",          // code | blueprint
  "label": "SampleGameEditor",
  "run": 3,                // monotonically increasing build id: lets the UI tell "a new failure" apart
  "verdict": "",           // why a non-zero exit still counts as success
  "stopped": false,        // user pressed Stop: gray, not a failure
  "errorCount": 2,         // error lines captured during the build
  "errors": ["…", "…"]     // up to 30, shown straight in the failure panel
}
```

## Configuration

Every deployment-specific value is a config field; nothing is hard-coded.

| Field | Default | Meaning |
| --- | --- | --- |
| `projectFile` | `''` | absolute path of the `.uproject` to bind |
| `engineRoot` | `''` | engine root (the directory containing `Engine/`) |
| `searchRoots` | `[]` | candidate scan roots; empty or `['auto']` means auto-discovery, `['.']` means the host working directory |
| `searchDepth` | `3` | scan depth (1–8) |
| `discoverDepth` | `6` | auto-discovery depth (1–10) |
| `discoverBudget` | `24000` | directory budget for auto-discovery; raise it for very deep trees |
| `target` | `''` | build target; empty means `<ProjectName>Editor` |
| `platform` | `Win64` | `Win64` / `Linux` / `Mac` |
| `configuration` | `Development` | build configuration |
| `extraBuildArgs` | `''` | appended to the build command line |
| `extraEditorArgs` | `''` | appended to the editor command line |
| `maxLogChars` | `200000` | log ring-buffer budget |

### Resolution order

**Project**: UI binding (persisted) → `projectFile` → the newest `.uproject` under
the scan roots.

**Engine**: `engineRoot` → persisted binding → Windows registry → drive-root
probing. The registry sources are
`HKLM\SOFTWARE\EpicGames\Unreal Engine\<version>\InstalledDirectory` and
`HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds` (the GUID map for source builds),
matched against the `.uproject`'s `EngineAssociation`.

### How a build is selected

Chosen automatically from the project type:

- **C++ project** (the `.uproject` has `Modules`, or `Source/**/*.Target.cs` exists)
  runs the same UBT pipeline as *Build* in your IDE:

  ```
  Engine/Build/BatchFiles/Build.bat <Target> <Platform> <Configuration> -Project="<…>.uproject" -WaitMutex -FromMsBuild
  ```

- **Blueprint-only project** runs
  `UnrealEditor-Cmd <…>.uproject -run=CompileAllBlueprints -unattended -nopause -NullRHI -stdout`.
  There is no C++ artefact to link, so the editor has to boot once — noticeably slower.

**How success is decided.** Not by exit code alone. In unattended mode UE counts
project-configuration errors (say, a `GameFeatureData` asset not registered with the
asset manager) as `Failure`, so even `Compiling Completed with 0 errors` can exit `1`.
The plugin therefore also parses UE's own conclusion lines —
`Compiling Completed with N errors…`, `finished execution (result N)`, UBT's
`Result: Succeeded`. Exit code `0` is always a success; a non-zero exit is still a
success when UE's own verdict is clean, and the UI states the reason on hover.

## Pinning scan roots in the config layer

Override by row id in the profile's `cordis.patch.yml`. A patch row replaces the
target row's whole `config` (no deep merge), so restate every field:

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

## Changed the UI and nothing happened? Restart dsh first

**The browser half (`lib/client.js`) is read once at dsh startup and cached in
memory**; the bundle's `rev` is a hash computed at that moment. So:

- editing `lib/client.js` requires **restarting `dsh web`** — reloading the page does nothing;
- this profile has no HMR installed (`dsh-client-hmr` / `cordis-plugin-hmr`), which would lift that.

To tell which build is actually loaded, open the log panel: its first line prints
`dsh-ue-bridge v<version>`, and the project picker footer shows `| N/M candidates | v<version>`.
A version mismatch means it was never restarted. The host half (`index.js`) is under
the same rule — also loaded once at startup.

## Empty project list?

The picker normalises whatever the host returns: missing fields fall back
(`path` / `projectFile` / `file`, the name can be derived from the `.uproject`
filename) and unusable entries are dropped. **A row is never rendered without text** —
if nothing is usable the panel says why (e.g. "the project endpoint returned N items
but none carried a project path") instead of showing an empty box.

Checklist:

1. `curl -s http://127.0.0.1:<port>/api/ue-bridge/projects` — did the host return a `projects` array?
2. `curl -s http://127.0.0.1:<port>/api/ue-bridge/state` — inspect `scanRoots` / `candidateCount`.
3. A footer reading `0/M candidates` means the data arrived but the filter matched nothing (clear the filter box).

## Manual equivalent

```sh
dsh plugin --profile web add ./plugins/dsh-ue-bridge
dsh --profile web --dump-config     # should list an "# == dsh-ue-bridge" layer
dsh --profile web
dsh plugin --profile web remove dsh-ue-bridge
```

## Known limits

- Engine resolution prefers the Windows registry; other platforms fall back to drive-root probing.
- Discovery only covers drive trees plus the usual locations; for projects outside those (a network path, say) set `searchRoots`.
- Epic Launcher's read-only template caches such as `C:\ProgramData\Epic\...\VaultCache` are deliberately skipped.
- Polling runs at 1.5 s; scan results cache for 30 s, bindings for 3 s.
- A scan walks at most 20000 directories per root, so a pathological tree cannot stall the host.

## License

MIT
