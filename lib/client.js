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
      const { createSnapshotStore } = require2("@deepseek-ai/dsh-client-store");
      const { SettingsForm, SettingsValueField, Button, Modal, Toast } = require2("@deepseek-ai/dsh-client-ui-primitives");
      const feedbackUrl = "api/git-bash-on-win/feedback";
      function pathChange(text, snapshot) {
        if (!text.trim()) {
          if (snapshot.user && Object.hasOwn(snapshot.user, "gitBashPath")) return { op: "unset", path: ["gitBashPath"] };
        } else if (text !== snapshot.value?.gitBashPath) {
          return { op: "set", path: ["gitBashPath"], value: text };
        }
      }
      function GitBashPage({ t, shellForm, useShellForm, useLinkProgress, notify }) {
        const snapshot = useShellForm((s) => s);
        const [draft, setDraft] = React.useState();
        const [busy, setBusy] = React.useState(false);
        const progress = useLinkProgress((p) => busy ? p : void 0);
        const locked = React.useRef(false);
        const inputId = React.useId();
        const value = draft?.text ?? snapshot.value?.gitBashPath ?? "";
        const disabled = busy || snapshot.status !== "ready";
        async function savePath(change, text, revision) {
          try {
            if (await shellForm.mutate([change], revision)) return true;
            const confirmed = shellForm.getSnapshot();
            if (confirmed.status === "ready") {
              setDraft({ text, revision: confirmed.revision });
              notify({ key: "save.review", path: confirmed.value?.gitBashPath });
            } else {
              setDraft({ text, revision });
              notify({ key: "save.failed" });
            }
          } catch (error) {
            setDraft({ text, revision });
            notify({ key: "save.failed", reason: asFailure(error) });
          }
          return false;
        }
        async function saveAndLink() {
          if (locked.current) return;
          locked.current = true;
          setBusy(true);
          try {
            const latest = shellForm.getSnapshot();
            if (latest.status !== "ready") return;
            const text = draft?.text ?? latest.value?.gitBashPath ?? "";
            const change = pathChange(text, latest);
            if (change && !latest.writable) return;
            if (change && !await savePath(change, text, draft ? draft.revision : latest.revision)) return;
            setDraft(void 0);
            const failureKey = change ? "link.failedAfterSave" : "link.failed";
            try {
              const response = await fetch("api/git-bash-on-win/rebuild", { method: "POST", redirect: "error" });
              if (response.ok) notify({ key: "link.ok" });
              else notify({ key: failureKey, reason: await readFailure(response) });
            } catch (error) {
              notify({ key: failureKey, reason: asFailure(error) });
            }
          } finally {
            locked.current = false;
            setBusy(false);
          }
        }
        const h = React.createElement;
        let hint = t("path.hint");
        if (typeof progress === "object") {
          hint = progress.completed !== void 0 ? t("link.files", { count: String(progress.completed), total: String(progress.total), path: progress.path }) : t("link.path", { path: progress.path });
        } else if (progress) {
          hint = t("link." + progress);
        }
        return h(
          "div",
          {
            className: "dsh-git-bash-settings",
            "data-linking": progress ? true : void 0,
            title: typeof progress === "object" ? progress.path : void 0
          },
          h("style", null, `
          .dsh-git-bash-settings > div { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 0.5rem; }
          .dsh-git-bash-settings > div > :last-child { padding-top: 0; }
          .dsh-git-bash-settings[data-linking] p[id] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        `),
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
              save: t("action.saveLink"),
              saving: t("action.linking")
            },
            onSave: () => {
              void saveAndLink();
            },
            onDiscard() {
            }
          }, h(SettingsValueField, {
            id: inputId,
            label: t("path.label"),
            placeholder: t("path.placeholder"),
            hint,
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
          }))
        );
      }
      function answer(action, id) {
        return fetch(feedbackUrl + "?action=" + action + "&id=" + encodeURIComponent(id), { method: "POST", redirect: "error" });
      }
      return {
        inject: ["slots", "configForms", "locale", "remote"],
        async apply(ctx) {
          await registerClientLocale(ctx, ns, "git-bash-on-win");
          if (ctx.fiber.uid === null) return;
          const progress = createSnapshotStore(void 0);
          const notices = createSnapshotStore(null);
          let sequence = 0;
          const notify = (message2) => notices.set({ ...message2, id: ++sequence });
          let projection;
          async function mountFeedback(signal) {
            const reply = await fetch(feedbackUrl, { signal, cache: "no-store", redirect: "error" });
            if (!reply.ok) throw new Error("Git Bash feedback: HTTP " + reply.status);
            const contract = await reply.json();
            signal.throwIfAborted();
            await ctx.remote.$mount(contract);
          }
          function FeedbackOverlay({ t }) {
            const local = React.useSyncExternalStore(notices.subscribe, notices.getSnapshot);
            const [automatic, setAutomatic] = React.useState({});
            const [submitted, setSubmitted] = React.useState();
            const watching = React.useRef(false);
            React.useEffect(() => {
              const controller = new AbortController();
              let retry;
              const connect = async () => {
                try {
                  await (projection ??= mountFeedback(controller.signal).catch((error) => {
                    projection = void 0;
                    throw error;
                  }));
                  if (controller.signal.aborted) return;
                  for await (const snapshot of ctx.get("remote.gitBashFeedback").watch(controller.signal)) {
                    if (controller.signal.aborted) return;
                    watching.current = true;
                    progress.set(snapshot.progress);
                    setAutomatic(snapshot);
                    if (snapshot.success) notify({ key: "link.ok" });
                  }
                } catch {
                }
                if (!controller.signal.aborted) {
                  progress.set(void 0);
                  watching.current = false;
                  setAutomatic((previous) => ({ failure: previous.failure }));
                  retry = setTimeout(() => {
                    void connect();
                  }, 1500);
                }
              };
              void connect();
              return () => {
                controller.abort();
                clearTimeout(retry);
                progress.set(void 0);
              };
            }, []);
            React.useEffect(() => {
              if (!submitted) return;
              const retry = () => setSubmitted((current) => current === submitted ? void 0 : current);
              void answer("confirm", submitted).then((response) => {
                if (!response.ok && response.status !== 409) retry();
              }, retry);
            }, [submitted]);
            const confirmation = automatic.confirmation;
            const open = confirmation && confirmation.id !== submitted;
            React.useLayoutEffect(() => {
              if (open) {
                const close = document.querySelector(".dsh-git-bash-confirm button[aria-label]");
                if (close) close.disabled = true;
              }
            }, [open, confirmation?.id]);
            if (open) {
              return React.createElement(Modal, {
                key: "confirmation",
                open: true,
                className: "dsh-git-bash-confirm",
                title: "Git Bash",
                description: t(confirmation.sourceChanged ? "link.confirmChanged" : "link.confirmSetup"),
                closeLabel: t("close"),
                onClose() {
                },
                footer: React.createElement(Button, {
                  type: "button",
                  autoFocus: true,
                  onClick: () => setSubmitted(confirmation.id)
                }, t("action.confirm"))
              });
            }
            const failure = automatic.failure;
            const notice = failure ? { key: "link.failed", ...failure } : local;
            if (!notice) return null;
            const dismiss = () => {
              if (failure) {
                const close = () => setAutomatic((previous) => previous.failure?.id === failure.id ? { ...previous, failure: void 0 } : previous);
                if (!watching.current) {
                  close();
                  return;
                }
                void answer("dismiss", failure.id).then((response) => {
                  if (response.ok || response.status === 404 || response.status === 409) close();
                }, () => {
                });
              } else if (notices.getSnapshot() === local) notices.set(null);
            };
            if (notice.key === "link.ok") {
              return React.createElement(Toast, { key: notice.id, text: t(notice.key), tone: "success", onDone: dismiss });
            }
            const h = React.createElement;
            let description;
            if (notice.key === "save.review") {
              description = notice.path?.trim() ? withCode(React, t("save.reviewDetail"), { path: notice.path }) : t("save.reviewEmpty");
            } else if (!notice.reason) {
              description = t("form.unavailable");
            } else {
              description = renderFailure(React, t, notice.reason);
            }
            return h(Modal, { open: true, title: t(notice.key), description, closeLabel: t("close"), onClose: dismiss });
          }
          ctx.slots.inject("shell.overlay", () => ctx.slots.register({
            name: "shell.overlay",
            id: ns,
            locale: ns
          }, FeedbackOverlay));
          const form = ctx.configForms.get("pwsh-sandbox");
          ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
            name: "plugins.bundle.config",
            key: ns,
            locale: ns,
            inject: () => ({ notify, shellForm: form, hooks: { shellForm: form, linkProgress: progress } })
          }, GitBashPage));
        }
      };
    }
  });
})();
