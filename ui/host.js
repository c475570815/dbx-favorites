// Shared host plumbing: one sandbox page hosts both the favorites and the settings workbench,
// selected by the contribution id in the init payload.
(function () {
  var api = window.dbxPlugin;

  function ready() {
    return api.ready;
  }

  function invoke(method, params) {
    return api.invoke(method, params || {});
  }

  function host(method, params) {
    return api.request(method, params || {});
  }

  function messageOf(error) {
    if (!error) return "未知错误";
    if (error.data && error.data.message) return error.data.message;
    return error.message || String(error);
  }

  function el(tag, attributes, children) {
    var node = document.createElement(tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        if (key === "class") node.className = attributes[key];
        else if (key === "text") node.textContent = attributes[key];
        else if (key === "html") node.innerHTML = attributes[key];
        else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2).toLowerCase(), attributes[key]);
        else if (attributes[key] !== null && attributes[key] !== undefined && attributes[key] !== false) {
          node.setAttribute(key, attributes[key]);
        }
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function toast(text, kind) {
    var host = document.getElementById("toasts");
    if (!host) return;
    var node = el("div", { class: "toast toast--" + (kind || "info"), text: text });
    host.appendChild(node);
    setTimeout(function () {
      node.className += " toast--out";
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 260);
    }, kind === "error" ? 6000 : 2600);
  }

  function qualifiedName(item) {
    var parts = [];
    if (item.database) parts.push(item.database);
    if (item.schema) parts.push(item.schema);
    parts.push(item.table);
    return parts.join(".");
  }

  var connectionsCache = { at: 0, list: null };

  function connections(force) {
    var now = Date.now();
    if (!force && connectionsCache.list && now - connectionsCache.at < 30000) {
      return Promise.resolve(connectionsCache.list);
    }
    return host("host.listConnections", {}).then(
      function (result) {
        var list = result && result.connections ? result.connections : [];
        connectionsCache = { at: now, list: list };
        return list;
      },
      function (error) {
        // The host only offers this on newer builds; the favorites list still works without names.
        toast("读取连接列表失败：" + messageOf(error), "error");
        connectionsCache = { at: now, list: [] };
        return [];
      }
    );
  }

  function connectionName(list, connectionId) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === connectionId) return list[i].name || list[i].label || connectionId;
    }
    return connectionId ? connectionId.slice(0, 8) : "-";
  }

  // The workbench iframe is sandboxed with allow-scripts only, so alert / confirm / prompt are
  // unavailable; every in-plugin question goes through this modal instead.
  function dialog(title, blocks, actions) {
    var root = document.getElementById("modal");
    if (!root) return { close: function () {} };
    root.textContent = "";
    function close() {
      root.classList.remove("modal--open");
      root.textContent = "";
      document.removeEventListener("keydown", onKey, true);
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    var footer = el("div", { class: "dialog__footer" }, (actions || []).map(function (action) {
      return el("button", {
        class: "dbx-btn" + (action.kind === "primary" ? " dbx-btn--primary" : action.kind === "danger" ? " dbx-btn--danger" : ""),
        text: action.label,
        title: action.title || "",
        onclick: function () {
          close();
          var result = action.action && action.action();
          if (result && result.catch) result.catch(function () {});
        }
      });
    }));
    var card = el("div", { class: "dialog" }, [el("h3", { class: "dialog__title", text: title })]
      .concat(blocks || [])
      .concat([footer]));
    root.appendChild(card);
    root.classList.add("modal--open");
    root.onclick = function (event) {
      if (event.target === root) close();
    };
    document.addEventListener("keydown", onKey, true);
    var focusable = footer.querySelector("button") || card.querySelector("input, select, textarea");
    if (focusable && focusable.focus) focusable.focus();
    return { close: close, card: card };
  }

  function confirmDialog(title, message, confirmLabel, kind) {
    return new Promise(function (resolve) {
      var settled = false;
      var root = document.getElementById("modal");
      function answer(value) {
        if (settled) return;
        settled = true;
        // Detach after settle: dialog() reuses one persistent root, otherwise every confirm
        // dialog ever opened leaves a closure listening on it.
        root.removeEventListener("click", onBackdrop);
        resolve(value);
      }
      function onBackdrop(event) {
        if (event.target === root) answer(false);
      }
      dialog(title, [el("p", { text: message })], [
        {
          label: confirmLabel || "确认",
          kind: kind || "danger",
          action: function () {
            answer(true);
          }
        },
        { label: "取消", action: function () { answer(false); } }
      ]);
      root.addEventListener("click", onBackdrop);
    });
  }

  function promptDialog(title, label, initial, confirmLabel) {
    return new Promise(function (resolve) {
      var input = el("input", { class: "dbx-input", type: "text", value: initial || "", placeholder: label });
      function submit() {
        var value = input.value.trim();
        if (value) {
          close();
          resolve(value);
        }
      }
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") submit();
      });
      var handle = dialog(title, [fieldRow(label, input)], [
        { label: confirmLabel || "确定", kind: "primary", action: function () { resolve(input.value.trim() || null); } },
        { label: "取消", action: function () { resolve(null); } }
      ]);
      function close() {
        handle.close();
      }
    });
  }

  function fieldRow(label, node) {
    return el("div", { class: "field" }, [el("label", { class: "dbx-label", text: label }), node]);
  }

  function context() {
    return api.context || {};
  }

  // The host skins the iframe through CSS custom properties (--color-background etc.) but never
  // announces its appearance, so UA-drawn surfaces — the native <select> listbox and scrollbars —
  // stay light even inside a dark DBX window. Infer the scheme from the rendered background and
  // tag <html>; cabinet.css keys its dark palette (incl. color-scheme: dark) off that attribute.
  function parseColor(text) {
    if (!text) return null;
    var match = text.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    var parts = match[1].split(",").map(function (piece) { return parseFloat(piece); });
    if (parts.length < 3 || parts.some(isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function colorLuminance(color) {
    return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  }

  function syncTheme() {
    var dark = false;
    var bodyStyle = document.body ? getComputedStyle(document.body) : null;
    var htmlStyle = getComputedStyle(document.documentElement);
    // Prefer the actually painted body background; fall back to the raw host variable, then to
    // the OS-level preference if the host leaves everything transparent.
    var bg = (bodyStyle && parseColor(bodyStyle.backgroundColor))
      || parseColor(htmlStyle.backgroundColor);
    if (bg && bg.a > 0.05) {
      dark = colorLuminance(bg) < 0.5;
    } else {
      var raw = (bodyStyle && bodyStyle.getPropertyValue("--color-background"))
        || htmlStyle.getPropertyValue("--color-background") || "";
      var rawColor = parseColor(raw);
      if (rawColor) dark = colorLuminance(rawColor) < 0.5;
      else if (window.matchMedia) dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    document.documentElement.setAttribute("data-dbx-theme", dark ? "dark" : "light");
  }

  function startThemeSync() {
    syncTheme();
    if (window.MutationObserver) {
      var observer = new MutationObserver(syncTheme);
      // Host flips appearance by swapping style/class (and therefore the CSS variables).
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class", "data-theme"]
      });
      if (document.body) {
        observer.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
      } else {
        document.addEventListener("DOMContentLoaded", function () {
          observer.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
          syncTheme();
        });
      }
    }
    if (window.matchMedia) {
      var query = window.matchMedia("(prefers-color-scheme: dark)");
      if (query.addEventListener) query.addEventListener("change", syncTheme);
      else if (query.addListener) query.addListener(syncTheme);
    }
    // Some hosts inject the theme variables a tick after the iframe loads.
    setTimeout(syncTheme, 300);
    if (api.ready && api.ready.then) api.ready.then(syncTheme).catch(function () {});
  }
  startThemeSync();

  window.Fav = {
    api: api,
    ready: ready,
    invoke: invoke,
    host: host,
    el: el,
    toast: toast,
    messageOf: messageOf,
    qualifiedName: qualifiedName,
    connections: connections,
    connectionName: connectionName,
    context: context,
    dialog: dialog,
    confirmDialog: confirmDialog,
    promptDialog: promptDialog,
    fieldRow: fieldRow,
    onEvent: function (fn) {
      return api.onEvent ? api.onEvent(function (event) {
        syncTheme();
        fn(event);
      }) : function () {};
    },
    onContext: function (fn) {
      return api.onContext ? api.onContext(fn) : function () {};
    }
  };
})();
