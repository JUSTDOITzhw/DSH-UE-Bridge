/**
 * dsh-ue-bridge — browser half.
 *
 * Contributes one compact row into the `conversation.composer.dock` slot: the
 * ambient strip below the composer card (kind `list`, scope `session`). The row
 * binds an Unreal project and drives Build / Open Editor / Stop through the host
 * half's loopback routes.
 *
 * Packaged as a loader lazy-CJS factory product: the whole module body lives
 * inside the factory closure and runs at materialization. Only the
 * platform-seeded `react` module is required, so the bundle stays pure.
 *
 * Styling follows docs/web-styling.md: feature components use `--dsw-alias-*`
 * semantic aliases with no colour literals and no theme branches.
 */
window.__ModuleLoader__.load({
  id: "dsh-ue-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const API = "/api/ue-bridge";
    const POLL_MS = 1500;
    const NOTICE_MS = 4000;
    /* Shown in both panels: the client half is read once at dsh activation and
     * cached, so a restart is the only way to pick up an edit. Printing the
     * version here makes "did my restart land?" a one-glance question. */
    const VERSION = "0.4.0";
    /* A row can never be squeezed below this; see the picker's scroll box. */
    const ROW_MIN_HEIGHT = 26;

    /** Semantic aliases only; every value carries a non-colour-ish fallback. */
    const T = {
      label: "var(--dsw-alias-label-primary, inherit)",
      label2: "var(--dsw-alias-label-secondary, inherit)",
      label3: "var(--dsw-alias-label-tertiary, inherit)",
      onAccent: "var(--dsw-alias-label-primary-inverted, inherit)",
      line: "var(--dsw-alias-border-l1, currentColor)",
      hover: "var(--dsw-alias-interactive-bg-hover, transparent)",
      accent: "var(--dsw-alias-button-primary-fill, currentColor)",
      accentHover: "var(--dsw-alias-button-primary-hover, currentColor)",
      active: "var(--dsw-alias-button-ghost-active-fill, transparent)",
      surfaceStrong: "var(--dsw-alias-bg-layer-2, transparent)",
      idle: "var(--dsw-alias-label-tertiary, currentColor)",
      busy: "var(--dsw-alias-state-warn-primary, currentColor)",
      live: "var(--dsw-alias-state-success-primary, currentColor)",
      error: "var(--dsw-alias-state-error-primary, currentColor)",
      mono: "var(--dsw-font-markdown-code, 12px/19px ui-monospace, monospace)",
      font: "var(--dsw-font-s-14, 14px/22px sans-serif)",
      fontStrong: "var(--dsw-font-s-strong-14, 500 14px/22px sans-serif)",
      fontSmall: "var(--dsw-font-xs-13, 13px/20px sans-serif)",
      /* The composer card's own geometry, so this row lines up with it exactly. */
      cardMax: "var(--dsh-composer-card-max-width)",
      elevate: "var(--dsw-elevation-panel)",
      radius: 12,
    };

    /**
     * The build lamp's four tones. Gray is "nothing has been built yet", amber
     * is a build in flight, green is a build that finished clean, red is one
     * that did not — the mapping the row is read by, kept in one place.
     */
    const TONE = { idle: T.idle, busy: T.busy, ok: T.live, error: T.error };

    /* The pulse is the one thing an inline style cannot express, so it lives in
     * a single injected stylesheet. Keyframes only — no selector, no colour,
     * nothing that could collide with dsh's own sheet. */
    const STYLE_ID = "dsh-ue-bridge-lamp";

    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = "@keyframes ue-bridge-lamp-pulse{0%,100%{opacity:.16}50%{opacity:.6}}";
      document.head.appendChild(style);
    }

    /* ---------------------------------------------------------------- *
     * Host API
     * ---------------------------------------------------------------- */

    /** One bridge call; never throws, always resolves to a shaped result. */
    async function call(path, body) {
      const init = body === undefined
        ? { cache: "no-store" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
      try {
        const res = await fetch(API + path, init);
        let payload = null;
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
        return { status: res.status, payload };
      } catch (error) {
        return { status: 0, payload: { ok: false, message: error && error.message ? error.message : String(error) } };
      }
    }

    /* ---------------------------------------------------------------- *
     * Formatting
     * ---------------------------------------------------------------- */

    function elapsed(ms) {
      const total = Math.max(0, Math.floor((ms || 0) / 1000));
      const seconds = total % 60;
      const minutes = Math.floor(total / 60);
      const hours = Math.floor(minutes / 60);
      const pad = (value) => String(value).padStart(2, "0");
      return hours > 0 ? `${hours}:${pad(minutes % 60)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
    }

    function shorten(value, keep) {
      const text = String(value || "");
      return text.length > keep ? `…${text.slice(1 - keep)}` : text;
    }

    function asText(value) {
      if (typeof value === "string") return value.trim();
      return value === undefined || value === null ? "" : String(value).trim();
    }

    /** Last segment of a Windows or POSIX path; "" when there is nothing left. */
    function baseName(value) {
      const text = asText(value).replace(/[\\/]+$/u, "");
      const at = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
      return at === -1 ? text : text.slice(at + 1);
    }

    /** `.uproject` basename → project name; used when the host omits `name`. */
    function projectNameOf(value) {
      return baseName(value).replace(/\.uproject$/iu, "");
    }

    /**
     * The picker must never render a row it cannot label. A host-side shape
     * change once left `{projects: [ ... ]}` carrying entries whose name and
     * path were read from fields that no longer existed, and the result was a
     * list of buttons with zero text — a blank 220px box that looked like a
     * rendering bug rather than a data mismatch. So every entry is coerced
     * here, a name is always derived, and anything unusable is dropped.
     */
    function normalizeProjects(list) {
      const rows = [];
      for (const entry of list) {
        const source = typeof entry === "string" ? { path: entry } : (entry || {});
        const path = asText(source.path)
          || asText(source.projectFile)
          || asText(source.file)
          || asText(source.projectPath);
        const name = asText(source.name)
          || asText(source.label)
          || asText(source.projectName)
          || projectNameOf(path)
          || baseName(source.projectDir);
        if (path === "" && name === "") continue;
        rows.push({
          path,
          name: name || "(未命名工程)",
          engineAssociation: asText(source.engineAssociation)
            || asText(source.engineVersion)
            || asText(source.engine),
        });
      }
      return rows;
    }

    /* ---------------------------------------------------------------- *
     * Build lamp
     * ---------------------------------------------------------------- */

    /** Failure reasons the host attached to a finished build; always an array. */
    function errorLinesOf(last) {
      if (last === null || last === undefined) return [];
      const raw = last.errors;
      if (Array.isArray(raw)) return raw.map(asText).filter((line) => line !== "");
      const single = asText(raw);
      return single === "" ? [] : [single];
    }

    /** Host-reported total when present, else what actually came through. */
    function errorCountOf(last, lines) {
      const reported = Number(last && last.errorCount);
      return Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : lines.length;
    }

    /**
     * The lamp's state, and the only place a build's outcome is interpreted.
     * Gray when nothing has been built, amber while one is in flight, green when
     * one finished clean, red when one did not. A build the user stopped by hand
     * is neither success nor failure: it returns to gray and raises no popup.
     * Pure on purpose, so the smoke test can pin every branch.
     */
    function buildStateOf(snapshot) {
      const build = (snapshot && snapshot.build) || { running: false };
      const last = snapshot === null || snapshot === undefined ? null : snapshot.lastBuild || null;

      if (build.running === true) {
        return {
          kind: "running",
          tone: "busy",
          pulse: true,
          text: `构建中 ${elapsed(build.elapsedMs)}${build.label ? ` · ${build.label}` : ""}`,
          detail: "正在构建；指示灯为琥珀色",
          errors: [],
          count: 0,
        };
      }
      if (last === null) {
        return {
          kind: "none",
          tone: "idle",
          pulse: false,
          text: "尚未构建",
          detail: "本会话还没有构建过；指示灯为灰色",
          errors: [],
          count: 0,
        };
      }

      const errors = errorLinesOf(last);
      const code = last.code === undefined || last.code === null ? "?" : String(last.code);
      const took = elapsed(last.ms);

      if (last.stopped === true) {
        return {
          kind: "stopped",
          tone: "idle",
          pulse: false,
          text: `构建已停止 · ${took}`,
          detail: "构建被手动停止，不计为失败",
          errors: [],
          count: 0,
        };
      }
      if (last.ok === true) {
        return {
          kind: "ok",
          tone: "ok",
          pulse: false,
          text: `构建成功 · ${took}`,
          detail: [`构建成功，用时 ${took}`, asText(last.verdict)].filter((line) => line !== "").join("\n"),
          errors: [],
          count: 0,
        };
      }

      const count = errorCountOf(last, errors);
      return {
        kind: "failed",
        tone: "error",
        pulse: false,
        text: `构建失败 · exit ${code}${count > 0 ? ` · ${count} 处报错` : ""}`,
        detail: [
          `构建失败，退出码 ${code}，用时 ${took}`,
          asText(last.verdict),
          ...errors.slice(0, 5),
        ].filter((line) => line !== "").join("\n"),
        errors,
        count,
      };
    }

    /** Identity of one finished build, so a failure raises exactly one popup. */
    function buildIdOf(last) {
      if (last === null || last === undefined) return "";
      const run = last.run === undefined || last.run === null ? "" : String(last.run);
      const at = last.at === undefined || last.at === null ? "" : String(last.at);
      return `${run}|${at}|${last.ok === true ? "ok" : "bad"}`;
    }

    /* ---------------------------------------------------------------- *
     * Primitives
     * ---------------------------------------------------------------- */

    function Action(props) {
      const [hover, setHover] = React.useState(false);
      const disabled = props.disabled === true;
      const accent = props.accent === true;
      const on = props.active === true;

      let background = "transparent";
      if (disabled) background = "transparent";
      else if (accent) background = hover ? T.accentHover : T.accent;
      else if (on) background = T.active;
      else if (hover) background = T.hover;

      return h(
        "button",
        {
          type: "button",
          disabled,
          title: props.title,
          "aria-pressed": on ? "true" : undefined,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: disabled ? undefined : props.onClick,
          style: {
            font: T.fontSmall,
            padding: "2px 10px",
            borderRadius: 6,
            border: accent ? "0" : `0.5px solid ${T.line}`,
            background,
            color: disabled ? T.label3 : accent ? T.onAccent : T.label2,
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.55 : 1,
            whiteSpace: "nowrap",
            flex: "0 0 auto",
          },
        },
        props.children,
      );
    }

    /**
     * The build lamp: an 8px core inside a 14px halo, both painted with the same
     * semantic token. The halo is a second element at low opacity rather than a
     * `color-mix()` shadow — that keeps it right in both themes without a single
     * colour literal. `pulse` marks a build in flight.
     */
    function Lamp(props) {
      const color = TONE[props.tone] || TONE.idle;
      return h(
        "span",
        {
          title: props.title,
          "aria-hidden": "true",
          style: {
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            flex: "0 0 auto",
          },
        },
        h("span", {
          style: {
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: color,
            opacity: 0.16,
            animation: props.pulse === true ? "ue-bridge-lamp-pulse 1.4s ease-in-out infinite" : undefined,
          },
        }),
        h("span", { style: { width: 8, height: 8, borderRadius: "50%", background: color } }),
      );
    }

    /** Inline popover shared by the project picker and the log view. */
    function Panel(props) {
      return h(
        "div",
        {
          style: {
            border: 0,
            borderRadius: T.radius,
            boxShadow: T.elevate,
            background: T.surfaceStrong,
            padding: 10,
            marginBottom: 8,
            font: T.fontSmall,
            color: T.label2,
          },
        },
        props.children,
      );
    }

    /* ---------------------------------------------------------------- *
     * The ambient row
     * ---------------------------------------------------------------- */

    function UeBridgeRow() {
      const [snapshot, setSnapshot] = React.useState(null);
      const [problem, setProblem] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const [panel, setPanel] = React.useState("");
      const [picker, setPicker] = React.useState(null);
      const [filter, setFilter] = React.useState("");
      const [logText, setLogText] = React.useState("");
      const [pickerNote, setPickerNote] = React.useState("");

      const refresh = React.useCallback(async () => {
        const result = await call("/state");
        const payload = result.payload;
        if (payload && payload.binding) {
          setSnapshot(payload);
          setProblem("");
        } else {
          setProblem((payload && payload.message) || `桥接不可用（HTTP ${result.status}）`);
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          if (alive) refresh();
        };
        tick();
        const timer = window.setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [refresh]);

      React.useEffect(() => {
        if (notice === "") return undefined;
        const timer = window.setTimeout(() => setNotice(""), NOTICE_MS);
        return () => window.clearTimeout(timer);
      }, [notice]);

      React.useEffect(() => {
        if (panel !== "log") return undefined;
        let alive = true;
        const pull = async () => {
          try {
            const res = await fetch(`${API}/log`, { cache: "no-store" });
            const text = await res.text();
            if (alive) setLogText(text.split("\n").slice(-150).join("\n"));
          } catch {
            /* the poll loop is what reports connectivity */
          }
        };
        pull();
        const timer = window.setInterval(pull, POLL_MS * 2);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [panel]);

      /* A finished failure opens the log by itself: the reason is the whole point
       * of turning the lamp red, and making the user hunt for the 日志 button
       * would waste it. One report per build — the ref holds the id of the last
       * failure already shown, so polling cannot re-open the panel, and closing
       * it stays closed. */
      const announced = React.useRef("");
      React.useEffect(() => {
        if (buildStateOf(snapshot).kind !== "failed") return;
        const id = buildIdOf(snapshot === null || snapshot === undefined ? null : snapshot.lastBuild);
        if (id === "" || id === announced.current) return;
        announced.current = id;
        setPanel("log");
      }, [snapshot]);

      const run = async (action, extra) => {
        const result = await call("/action", Object.assign({ action }, extra));
        setNotice((result.payload && result.payload.message) || `HTTP ${result.status}`);
        if (action === "bind" || action === "unbind") setPanel("");
        await refresh();
      };

      const toggle = async (which) => {
        if (panel === which) {
          setPanel("");
          return;
        }
        setPanel(which);
        if (which === "picker") {
          setPicker(null);
          setPickerNote("");
          setFilter("");
          const result = await call("/projects");
          const payload = result.payload || {};
          /* `projects` is the documented shape; `roots` is tolerated so an
           * older host cannot silently produce an unlabelled list. */
          const raw = Array.isArray(payload.projects)
            ? payload.projects
            : Array.isArray(payload.roots) ? payload.roots : null;
          const rows = raw === null ? [] : normalizeProjects(raw);
          setPicker(rows);
          if (raw === null) {
            setPickerNote(`工程接口未返回可用列表（HTTP ${result.status}），请点「重新发现」重试。`);
          } else if (raw.length > 0 && rows.length === 0) {
            setPickerNote(`工程接口返回了 ${raw.length} 项，但没有一项带有工程路径。`);
          }
        }
      };

      /** Failure reasons are meant to be pasted elsewhere; clipboard may be off. */
      const copyText = (text) => {
        const refuse = () => setNotice("复制失败，请手动选中日志");
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(text)
              .then(() => setNotice("报错已复制到剪贴板"))
              .catch(refuse);
            return;
          }
        } catch {
          /* insecure context or blocked clipboard — fall through to the hint */
        }
        refuse();
      };

      const binding = (snapshot && snapshot.binding) || null;
      const build = (snapshot && snapshot.build) || { running: false };
      const editor = (snapshot && snapshot.editor) || { running: false };
      const ready = binding !== null && binding.ok === true;
      const busy = build.running || editor.running;

      const discovering = snapshot !== null
        && (snapshot.rootsSource === "auto-pending" || snapshot.discovering === true);

      /* The lamp answers exactly one question — how did the last build go — so
       * it is derived on its own instead of being folded into the status text.
       * A running editor therefore never repaints it. */
      const lamp = buildStateOf(snapshot);

      let color = T.idle;
      let status = lamp.text;
      let statusDetail = lamp.detail;
      if (problem !== "") {
        color = T.error;
        status = problem;
        statusDetail = "";
      } else if (!ready && discovering) {
        color = T.busy;
        status = "正在发现工程目录…";
        statusDetail = "";
      } else if (!ready && binding !== null) {
        color = T.error;
        status = binding.error || "工程未就绪";
        statusDetail = "";
      } else if (lamp.kind === "running") {
        /* Beats the editor line on purpose: building inside an open editor is
           the normal case, and "构建中" is what the row is watched for. */
        color = T.busy;
        status = lamp.text;
        statusDetail = lamp.detail;
      } else if (editor.running) {
        color = T.live;
        status = `编辑器运行中 ${elapsed(editor.elapsedMs)}`;
        statusDetail = lamp.kind === "none" ? "" : lamp.detail;
      }
      if (notice !== "") {
        status = notice;
        statusDetail = "";
        color = T.label2;
      }

      const label = ready
        ? `${binding.projectName} · UE ${binding.engineVersion || binding.engineAssociation || "?"}`
        : "选择 UE 工程";
      const labelTitle = ready
        ? [
          binding.projectFile,
          `引擎：${binding.engineRoot}`,
          binding.buildMode === "code" ? `C++ 目标：${binding.target}` : "蓝图工程（CompileAllBlueprints）",
        ].join("\n")
        : "点击选择本机的 .uproject";

      const header = h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 10, width: "100%", font: T.font, color: T.label, minHeight: 22 } },
        h(Lamp, {
          tone: lamp.tone,
          pulse: lamp.pulse,
          title: `构建指示灯：${lamp.text}${lamp.detail === "" ? "" : `\n${lamp.detail}`}`,
        }),
        h(
          "button",
          {
            type: "button",
            title: labelTitle,
            onClick: () => toggle("picker"),
            style: {
              font: T.fontStrong,
              padding: 0,
              border: 0,
              background: "none",
              color: T.label,
              cursor: "pointer",
              maxWidth: 280,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: "0 1 auto",
            },
          },
          label,
        ),
        h(
          "span",
          {
            title: statusDetail === "" ? undefined : statusDetail,
            style: {
              color,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: "1 1 auto",
              minWidth: 0,
            },
          },
          status,
        ),
        h(
          "span",
          { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" } },
          h(Action, { onClick: () => run("build"), disabled: !ready || build.running, title: "构建工程" }, "构建"),
          h(Action, { onClick: () => run("openEditor"), disabled: !ready || editor.running, title: "打开编辑器" }, "编辑器"),
          h(Action, { onClick: () => run("stop"), disabled: !busy, title: "停止编辑器与构建" }, "停止"),
          h(Action, { onClick: () => toggle("log"), active: panel === "log", title: "查看输出日志" }, "日志"),
        ),
      );

      const blocks = [header];

      if (panel === "picker") {
        const roots = (snapshot && snapshot.scanRoots) || [];
        const needle = filter.trim().toLowerCase();
        const matches = (picker || []).filter((item) =>
          needle === ""
          || asText(item.name).toLowerCase().includes(needle)
          || asText(item.path).toLowerCase().includes(needle));

        blocks.unshift(
          h(
            Panel,
            { key: "picker" },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 } },
              h("input", {
                value: filter,
                placeholder: "筛选工程名或路径",
                onChange: (event) => setFilter(event.target.value),
                style: {
                  font: T.fontSmall,
                  color: T.label,
                  background: "transparent",
                  border: `0.5px solid ${T.line}`,
                  borderRadius: 6,
                  padding: "4px 8px",
                  flex: "1 1 auto",
                  minWidth: 0,
                  outline: "none",
                },
              }),
              snapshot && snapshot.rootsSource !== "config"
                ? h(Action, { onClick: () => run("rescan"), title: "重新扫描本机磁盘查找 .uproject" }, "重新发现")
                : null,
              ready && binding.source === "binding"
                ? h(Action, { onClick: () => run("unbind"), title: "解除绑定" }, "解除绑定")
                : null,
            ),
            picker === null
              ? h("div", { style: { color: T.label3, padding: "2px 0" } }, "扫描中…")
              : pickerNote !== ""
                ? h("div", { style: { color: T.error, padding: "2px 0" } }, pickerNote)
                : matches.length === 0
                  ? h(
                    "div",
                    { style: { color: T.label3, padding: "2px 0" } },
                    picker.length === 0
                      ? `未发现 .uproject。当前扫描：${roots.join("  |  ") || "工作目录"}`
                      : "没有匹配的工程",
                  )
                  : h(
                    "div",
                    { style: { maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column" } },
                    matches.map((item, index) => h(
                      "button",
                      {
                        key: item.path === "" ? `${item.name}#${index}` : item.path,
                        type: "button",
                        title: item.path === "" ? item.name : item.path,
                        disabled: item.path === "",
                        onClick: () => run("bind", { projectFile: item.path }),
                        onMouseEnter: (event) => { event.currentTarget.style.background = T.hover; },
                        onMouseLeave: (event) => { event.currentTarget.style.background = "transparent"; },
                        style: {
                          font: T.fontSmall,
                          textAlign: "left",
                          padding: "4px 8px",
                          border: 0,
                          borderRadius: 6,
                          background: "transparent",
                          color: T.label2,
                          cursor: item.path === "" ? "default" : "pointer",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          /* `overflow: hidden` zeroes a flex item's automatic
                           * minimum size, so in this capped column the rows can
                           * be squashed to a few pixels and every label clipped
                           * away. This is what keeps a long list readable. */
                          flex: "0 0 auto",
                          minHeight: ROW_MIN_HEIGHT,
                        },
                      },
                      h("span", { style: { color: T.label, fontWeight: 500 } }, item.name),
                      item.engineAssociation ? h("span", { style: { color: T.label3 } }, `  UE ${item.engineAssociation}`) : null,
                      item.path === "" ? null : h("span", { style: { color: T.label3 } }, `  ${shorten(item.path, 68)}`),
                    )),
                  ),
            h(
              "div",
              { style: { color: T.label3, marginTop: 6 } },
              `${
                snapshot && snapshot.rootsSource === "config" ? "配置的扫描根目录" : "自动发现的工程目录"
              }：${roots.join("  |  ") || "正在发现…"}`,
              h(
                "span",
                { style: { marginLeft: 6, whiteSpace: "nowrap" } },
                `｜ 候选 ${matches.length}/${picker === null ? "…" : picker.length} ｜ v${VERSION}`,
              ),
            ),
          ),
        );
      }

      if (panel === "log") {
        /* Header restates the lamp's verdict, the failure reasons sit on top of
           the raw log in their own bordered block, and the log stays complete
           underneath — the popup explains, it does not truncate. */
        const failures = lamp.kind === "failed" ? lamp.errors : [];
        const tone = TONE[lamp.tone] || T.idle;

        blocks.unshift(
          h(
            Panel,
            { key: "log" },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
              h(Lamp, { tone: lamp.tone, pulse: false, title: lamp.text }),
              h("span", { style: { color: tone, font: T.fontStrong } }, lamp.text),
              h(
                "span",
                { style: { color: T.label3, marginLeft: "auto", whiteSpace: "nowrap" } },
                `dsh-ue-bridge v${VERSION}`,
              ),
            ),
            failures.length === 0
              ? null
              : h(
                "div",
                { style: { borderLeft: `2px solid ${T.error}`, paddingLeft: 8, marginBottom: 8 } },
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
                  h(
                    "span",
                    { style: { color: T.error, font: T.fontStrong, flex: "1 1 auto", minWidth: 0 } },
                    `报错 ${
                      lamp.count > failures.length
                        ? `${lamp.count} 处（显示前 ${failures.length} 处）`
                        : `${failures.length} 处`
                    }`,
                  ),
                  h(Action, { onClick: () => copyText(failures.join("\n")), title: "复制这些报错行" }, "复制"),
                ),
                h(
                  "pre",
                  {
                    style: {
                      margin: 0,
                      maxHeight: 150,
                      overflow: "auto",
                      font: T.mono,
                      color: T.error,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    },
                  },
                  failures.join("\n"),
                ),
              ),
            h("div", { style: { color: T.label3, marginBottom: 4 } }, `完整日志（末尾 150 行）`),
            h(
              "pre",
              {
                style: {
                  margin: 0,
                  maxHeight: 200,
                  overflow: "auto",
                  font: T.mono,
                  color: T.label2,
                  whiteSpace: "pre",
                },
              },
              logText === "" ? "暂无输出" : logText,
            ),
          ),
        );
      }

      /* Spread, not an array child: the block count is static, so React needs no keys here.
       * Geometry mirrors the composer card itself (`width:100%` capped at
       * `--dsh-composer-card-max-width`, centred), so the row lines up with the input box
       * instead of stretching to the full conversation column. */
      return h(
        "div",
        {
          style: {
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            width: "100%",
            maxWidth: T.cardMax,
            margin: "0 auto",
          },
        },
        ...blocks,
      );
    }

    /** Required service: the UI slot registry. */
    const inject = ["slots"];

    /** Mount the row into the ambient strip below the composer card. */
    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
        { name: "conversation.composer.dock", id: "ue-bridge", order: 50, label: "Unreal" },
        UeBridgeRow,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    /* Exposed for the smoke test only: the picker's payload normalisation and
     * the lamp's state machine are pure, so they are worth asserting directly
     * rather than through markup. */
    exports.internals = {
      VERSION,
      asText,
      baseName,
      projectNameOf,
      normalizeProjects,
      buildStateOf,
      buildIdOf,
      errorLinesOf,
      TONES: TONE,
    };
    return module.exports;
  },
});
