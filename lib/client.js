"use strict";
(() => {
  // src/locale/shared.ts
  function message(key, params) {
    return params === void 0 ? { key } : { key, params };
  }
  function isDictionary(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");
  }
  function catalogUrl(id) {
    return `api/${id}/locales`;
  }

  // src/locale/client.ts
  async function registerClientLocale(ctx, namespace, id = namespace) {
    const response = await fetch(catalogUrl(id), { cache: "no-store", redirect: "error" });
    if (ctx.fiber.uid === null) return;
    if (!response.ok) throw Object.assign(new Error(`Locale catalogs: HTTP ${response.status}`), {
      messages: [message("error.localeHttp", { status: String(response.status) })]
    });
    const data = await response.json();
    if (ctx.fiber.uid === null) return;
    const catalogs = data?.dictionaries;
    if (data?.ok !== true || !catalogs || !isDictionary(catalogs.en)) {
      throw Object.assign(new Error("Invalid locale catalogs."), { messages: [message("error.invalidLocaleDictionaries")] });
    }
    const dictionaries = Object.fromEntries(Object.entries(catalogs).filter((entry) => isDictionary(entry[1])));
    ctx.effect(() => ctx.locale.register(namespace, dictionaries), "locale dictionaries");
  }
  var ApiError = class extends Error {
    failure;
    constructor(failure) {
      super(failure.error);
      this.failure = failure;
    }
  };
  function asFailure(error) {
    return error instanceof ApiError ? error.failure : { error: error instanceof Error ? error.message : String(error) };
  }
  async function readFailure(response) {
    const text = await response.text();
    const status = `HTTP ${response.status}`;
    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        const failure = JSON.parse(text);
        if (typeof failure?.error === "string") return { ...failure, error: failure.error };
        if (failure && typeof failure === "object") {
          return { error: status, messages: failure.messages ?? [message("error.httpStatus", { status: response.status })], diagnostic: failure.diagnostic };
        }
      } catch {
      }
    }
    return text ? { error: text } : { error: status, messages: [message("error.httpStatus", { status: response.status })] };
  }
  function withCode(React, template, params) {
    if (!params) return template;
    return template.split(/(\{\w+\})/g).map((part, index) => {
      const name = part.slice(1, -1);
      return part.startsWith("{") && Object.hasOwn(params, name) ? React.createElement("code", { key: index, style: { overflowWrap: "anywhere" } }, String(params[name])) : part;
    });
  }
  function renderFailure(React, t, failure) {
    const h = React.createElement;
    const explanations = [];
    for (const item of failure.messages ?? []) {
      const template = t(item.key);
      if (!template.trim() || template === item.key) continue;
      explanations.push(h(
        React.Fragment,
        { key: explanations.length },
        explanations.length ? t("error.separator") : null,
        withCode(React, template, item.params)
      ));
    }
    const raw = failure.diagnostic ?? (explanations.length ? void 0 : failure.error);
    return h(
      React.Fragment,
      null,
      explanations.length ? explanations : t("error.unknown"),
      raw ? h("code", { style: {
        display: "block",
        marginTop: 4,
        fontFamily: "var(--ds-font-family-code, monospace)",
        fontSize: 12,
        color: "var(--dsw-alias-label-secondary)",
        overflowWrap: "anywhere",
        whiteSpace: "pre-wrap"
      } }, raw) : null
    );
  }

  // src/client.ts
  window.__ModuleLoader__.load({
    id: "dsh-git-bash-on-win",
    factory(require2) {
      const ns = "dsh-git-bash-on-win";
      const React = require2("react");
      const { SettingsForm, SettingsValueField, Modal, Toast } = require2("@deepseek-ai/dsh-client-ui-primitives");
      function pathChange(text, snapshot) {
        if (!snapshot.writable && text === (snapshot.value?.gitBashPath ?? "")) return;
        if (!text.trim()) {
          if (snapshot.user && Object.hasOwn(snapshot.user, "gitBashPath")) return { op: "unset", path: ["gitBashPath"] };
        } else if (text !== snapshot.value?.gitBashPath) {
          return { op: "set", path: ["gitBashPath"], value: text };
        }
      }
      function GitBashPage({ t, shellForm, useShellForm }) {
        const snapshot = useShellForm((s) => s);
        const [draft, setDraft] = React.useState();
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState();
        const mounted = React.useRef(true);
        React.useEffect(() => {
          mounted.current = true;
          return () => {
            mounted.current = false;
          };
        }, []);
        const locked = React.useRef(false);
        const inputId = React.useId();
        const value = draft?.text ?? snapshot.value?.gitBashPath ?? "";
        const disabled = busy || snapshot.status !== "ready";
        async function saveAndRebuild() {
          if (locked.current) return;
          locked.current = true;
          setBusy(true);
          setNotice(void 0);
          let failureKey = "save.failed";
          try {
            const latest = shellForm.getSnapshot();
            if (latest.status !== "ready") return;
            const text = draft?.text ?? latest.value?.gitBashPath ?? "";
            const change = pathChange(text, latest);
            if (change) {
              if (!latest.writable) return;
              if (!await shellForm.mutate([change], draft ? draft.revision : latest.revision)) {
                const confirmed = shellForm.getSnapshot();
                if (mounted.current) {
                  if (confirmed.status === "ready") setDraft({ text, revision: confirmed.revision });
                  setNotice(confirmed.status === "ready" ? { key: "save.review", path: confirmed.value?.gitBashPath } : { key: "save.failed" });
                }
                return;
              }
            }
            if (mounted.current) setDraft(void 0);
            failureKey = change ? "rebuild.failedAfterSave" : "rebuild.failed";
            const response = await fetch("api/git-bash-on-win/rebuild", { method: "POST", redirect: "error" });
            const result = response.ok ? { key: "rebuild.ok" } : { key: failureKey, reason: await readFailure(response) };
            if (mounted.current) setNotice(result);
          } catch (error) {
            if (mounted.current) setNotice({ key: failureKey, reason: asFailure(error) });
          } finally {
            locked.current = false;
            if (mounted.current) setBusy(false);
          }
        }
        const h = React.createElement;
        const dismiss = () => setNotice((current) => current === notice ? void 0 : current);
        return h(
          React.Fragment,
          null,
          h(SettingsForm, {
            // Rebuilding a saved path is an action even when the settings document is clean or read-only.
            state: {
              available: true,
              writable: true,
              dirty: !disabled && (snapshot.writable || !pathChange(value, snapshot)),
              invalid: false,
              saving: busy,
              failed: false
            },
            labels: {
              unavailable: t("form.unavailable"),
              readOnly: "",
              saveFailed: t("save.failed"),
              save: t("action.saveRebuild"),
              saving: t("action.rebuilding")
            },
            onSave: () => {
              void saveAndRebuild();
            },
            onDiscard() {
            },
            children: h(SettingsValueField, {
              id: inputId,
              label: t("path.label"),
              placeholder: t("path.placeholder"),
              hint: t("path.hint"),
              text: value,
              disabled: disabled || !snapshot.writable,
              overridden: false,
              overriddenLabel: "",
              resetLabel: "",
              onReset() {
              },
              invalid: false,
              invalidLabel: "",
              onEdit(text) {
                setDraft((previous) => ({ text, revision: previous ? previous.revision : snapshot.revision }));
              }
            })
          }),
          notice?.key === "rebuild.ok" ? h(Toast, { tone: "success", text: t(notice.key), onDone: dismiss }) : notice && h(
            Modal,
            { open: true, title: t(notice.key), closeLabel: t("close"), onClose: dismiss },
            notice.key === "save.review" ? notice.path?.trim() ? withCode(React, t("save.reviewDetail"), { path: notice.path }) : t("save.reviewEmpty") : notice.reason ? renderFailure(React, t, notice.reason) : t("form.unavailable")
          )
        );
      }
      return {
        inject: ["slots", "configForms", "locale"],
        async apply(ctx) {
          await registerClientLocale(ctx, ns, "git-bash-on-win");
          if (ctx.fiber.uid === null) return;
          const form = ctx.configForms.get("pwsh-sandbox");
          ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
            name: "plugins.bundle.config",
            key: ns,
            locale: ns,
            inject: () => ({ shellForm: form, hooks: { shellForm: form } })
          }, GitBashPage));
        }
      };
    }
  });
})();
