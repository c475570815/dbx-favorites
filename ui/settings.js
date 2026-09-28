// Settings workbench: configure the native DBX loopback bridge used to reopen tables, and diagnose it.
(function () {
  var F = window.Fav;
  var el = F.el;

  var doc = null;
  var lastProbe = null;
  var dropOff = null;

  function settings() {
    return (doc && doc.settings) || {};
  }

  function bind(node, key, read) {
    node.addEventListener("change", function () {
      settings()[key] = read(node);
      save(false);
    });
    return node;
  }

  function text(node) {
    return node.value.trim();
  }

  function number(node) {
    return parseInt(node.value, 10) || 0;
  }

  function checked(node) {
    return !!node.checked;
  }

  function save(notify) {
    return F.invoke("favorites/store/replace", { data: doc }).then(
      function () {
        if (notify !== false) F.toast("已保存", "success");
      },
      function (error) {
        F.toast("保存失败：" + F.messageOf(error), "error");
      }
    );
  }

  function row(label, node, hint) {
    return el("div", { class: "srow" }, [
      el("label", { class: "dbx-label", text: label }),
      el("div", { class: "srow__body" }, [node, hint ? el("div", { class: "dbx-hint", text: hint }) : null])
    ]);
  }

  function portInput() {
    var node = el("input", { class: "dbx-input", type: "number", min: "1", max: "65535", placeholder: "0 = 自动发现" });
    node.value = String(settings().bridgePort || 0);
    return bind(node, "bridgePort", number);
  }

  function portFileInput() {
    var node = el("input", { class: "dbx-input", type: "text", placeholder: "留空则依次尝试 DBX_DATA_DIR 与 %APPDATA%\\com.dbx.app" });
    node.value = settings().bridgePortFile || "";
    return bind(node, "bridgePortFile", text);
  }

  function timeoutInput() {
    var node = el("input", { class: "dbx-input", type: "number", min: "500", max: "60000", step: "500" });
    node.value = String(settings().timeoutMs || 6000);
    return bind(node, "timeoutMs", number);
  }

  function openOnAddInput() {
    var node = el("input", { type: "checkbox" });
    node.checked = settings().openOnAdd !== false;
    return bind(node, "openOnAdd", checked);
  }

  function testChannel() {
    return F.invoke("favorites/probe").then(
      function (probe) {
        lastProbe = probe;
        renderProbe();
        F.toast(probe.bridge && probe.bridge.alive ? "桥接可用" : "桥接不可用，详见下方诊断", probe.bridge && probe.bridge.alive ? "success" : "error");
      },
      function (error) {
        F.toast("诊断失败：" + F.messageOf(error), "error");
      }
    );
  }

  function renderProbe() {
    var holder = document.getElementById("probe");
    if (!holder || !lastProbe) return;
    holder.textContent = "";
    var bridge = lastProbe.bridge || {};
    var env = lastProbe.env || {};
    var storeInfo = lastProbe.store || {};

    function line(name, ok, detail) {
      return el("tr", {}, [
        el("td", { text: name }),
        el("td", {}, [el("span", { class: "dbx-badge", text: ok === null ? "—" : ok ? "正常" : "异常" })]),
        el("td", { class: "mono", text: detail === null || detail === undefined ? "" : String(detail) })
      ]);
    }

    holder.appendChild(el("table", { class: "dbx-table" }, [
      el("thead", {}, [el("tr", {}, [el("th", { text: "通路" }), el("th", { text: "状态" }), el("th", { text: "细节" })])]),
      el("tbody", {}, [
        line("DBX 本机桥接", bridge.alive, "端口 " + (bridge.port || "未发现") + " · 来源 " + (bridge.source || "-") + (bridge.detail ? " · " + bridge.detail : "")),
        line("收藏数据", true, (storeInfo.favorites || 0) + " 条收藏 · " + (storeInfo.folders || 0) + " 个文件夹" + (storeInfo.loadError ? " · 读取警告：" + storeInfo.loadError : "")),
        line("Sidecar 环境", true, "DBX " + (env.appVersion || "-") + " · hostApi " + (env.hostApiVersion || "-") + " · 数据文件 " + (env.pluginDataDir || "-"))
      ])
    ]));
  }

  function applyDoc(parsed) {
    doc = parsed;
    render();
    return save(true).then(function () {
      F.toast("已导入 " + parsed.favorites.length + " 条收藏", "success");
    });
  }

  function exportFile() {
    return window.Porter.exportFlow(doc);
  }

  function copyToClipboard() {
    return window.Porter.copyFlow(doc);
  }

  function importFile() {
    return window.Porter.importFile(doc, applyDoc);
  }

  function pasteImport() {
    return window.Porter.pasteImport(doc, applyDoc);
  }

  function transferHint() {
    if (!window.Transfer || !window.Transfer.supported()) {
      return "当前宿主没有开放文件对话框，导出会退回剪贴板；也可以直接把 JSON 拖进本页面导入。";
    }
    return "导出走系统原生保存对话框，导入支持选择文件或直接把 JSON 拖到本页面。";
  }

  function render() {
    var root = document.getElementById("app");
    root.textContent = "";
    root.appendChild(el("header", { class: "mast" }, [
      el("div", { class: "mast__brand" }, [
        window.Tree.icon("star", "mast__mark"),
        el("span", { class: "mast__name", text: "StashBox" }),
        el("span", { class: "mast__sub", text: "通道配置" })
      ]),
      el("div", { class: "tools__right" }, [
        el("button", { class: "tbtn tbtn--go", text: "测试通路", onclick: testChannel }),
        el("button", { class: "tbtn", text: "返回收藏柜", onclick: function () { window.Stash.show("favorites"); } })
      ])
    ]));

    root.appendChild(el("section", { class: "block" }, [
      el("h3", { class: "block__title", text: "原生打开" }),
      el("div", { class: "dbx-hint", text: "通过 DBX 桌面端自带的 127.0.0.1 本机桥接直接唤起原生表视图，无需令牌或额外配置。" }),
      row("桥接端口", portInput(), "0 表示自动从 mcp-bridge-port 文件发现（每次启动都会变，建议保持自动）。"),
      row("桥接端口文件", portFileInput()),
      row("调用超时（毫秒）", timeoutInput(), "桥接正常时约 20–60ms；超时通常意味着 DBX 未运行或桥接未启动。")
    ]));

    root.appendChild(el("section", { class: "block" }, [
      el("h3", { class: "block__title", text: "行为" }),
      row("从右键菜单收藏后立即打开", openOnAddInput())
    ]));

    root.appendChild(el("section", { class: "block" }, [
      el("h3", { class: "block__title", text: "通路诊断" }),
      el("div", { id: "probe", class: "probe" }, [el("div", { class: "dbx-hint", text: "点上方“测试通路”查看本机桥接、收藏数据文件与 Sidecar 环境。" })])
    ]));

    root.appendChild(el("section", { class: "block" }, [
      el("h3", { class: "block__title", text: "数据 · 导入导出" }),
      el("div", { class: "toolbar" }, [
        el("button", { class: "dbx-btn dbx-btn--primary", text: "导出为 JSON 文件", onclick: exportFile }),
        el("button", { class: "dbx-btn", text: "从 JSON 文件导入", onclick: importFile }),
        el("button", { class: "dbx-btn dbx-btn--ghost", text: "复制到剪贴板", onclick: copyToClipboard }),
        el("button", { class: "dbx-btn dbx-btn--ghost", text: "粘贴导入", onclick: pasteImport })
      ]),
      el("div", { class: "dbx-hint", text: transferHint() }),
      el("div", { class: "dbx-hint", text: "收藏、文件夹与设置都保存在 Sidecar 的 DBX_PLUGIN_DATA_DIR/favorites-store.json，不受宿主 1 MiB 存储上限影响；导出的 JSON 就是这份文件的完整内容。" })
    ]));

    renderProbe();
  }

  function boot() {
    return F.invoke("favorites/store/get").then(
      function (store) {
        doc = store || { folders: [], favorites: [], settings: {} };
        if (!doc.settings) doc.settings = {};
        render();
        if (window.Porter && !dropOff) {
          dropOff = window.Porter.onDrop(function (text, name) {
            window.Porter.fromText(text, name, doc, applyDoc);
          });
        }
      },
      function (error) {
        document.getElementById("app").appendChild(el("div", { class: "block", text: "初始化失败：" + F.messageOf(error) }));
      }
    );
  }

  function teardown() {
    if (dropOff) {
      dropOff();
      dropOff = null;
    }
  }

  window.SettingsPage = { boot: boot, teardown: teardown };
})();
