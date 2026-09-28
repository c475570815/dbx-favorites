// File import/export through the host's streaming transfer bridge. The sandbox cannot open dialogs
// or touch the disk itself, so every path here goes through window.dbxPlugin.fileTransfer and falls
// back to the clipboard when that group is unavailable.
(function () {
  var F = window.Fav;
  var el = F.el;
  var CHUNK = 256 * 1024;

  function transfer() {
    return F.api.fileTransfer || null;
  }

  function supported() {
    var ft = transfer();
    return !!(ft && ft.pick && ft.read && ft.beginSave && ft.write && ft.finish);
  }

  function toBytes(text) {
    var bytes = new Uint8Array(text.length * 3);
    var used = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        bytes[used++] = code;
      } else if (code < 0x800) {
        bytes[used++] = 0xc0 | (code >> 6);
        bytes[used++] = 0x80 | (code & 0x3f);
      } else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        var point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
        bytes[used++] = 0xf0 | (point >> 18);
        bytes[used++] = 0x80 | ((point >> 12) & 0x3f);
        bytes[used++] = 0x80 | ((point >> 6) & 0x3f);
        bytes[used++] = 0x80 | (point & 0x3f);
      } else {
        bytes[used++] = 0xe0 | (code >> 12);
        bytes[used++] = 0x80 | ((code >> 6) & 0x3f);
        bytes[used++] = 0x80 | (code & 0x3f);
      }
    }
    return bytes.subarray(0, used);
  }

  function fromBytes(bytes) {
    if (typeof TextDecoder === "function") {
      return new TextDecoder("utf-8").decode(bytes);
    }
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    try {
      return decodeURIComponent(escape(text));
    } catch (error) {
      return text;
    }
  }

  function decode64(value) {
    if (typeof F.api.decodeBase64 === "function") return F.api.decodeBase64(value);
    return Uint8Array.from(atob(value), function (character) {
      return character.charCodeAt(0);
    });
  }

  function readAll(file) {
    var ft = transfer();
    var chunks = [];
    var offset = 0;
    function step() {
      return ft.read(file.handleId, offset, CHUNK).then(function (result) {
        if (result && result.dataBase64) chunks.push(decode64(result.dataBase64));
        offset += (result && result.length) || 0;
        if (result && result.eof) return null;
        if (offset > 32 * 1024 * 1024) throw new Error("导入文件超过 32 MiB");
        return step();
      });
    }
    return step()
      .then(function () {
        var total = 0;
        chunks.forEach(function (chunk) {
          total += chunk.length;
        });
        var merged = new Uint8Array(total);
        var at = 0;
        chunks.forEach(function (chunk) {
          merged.set(chunk, at);
          at += chunk.length;
        });
        return fromBytes(merged);
      })
      .catch(function (error) {
        return ft.cancel(file.handleId).then(function () {
          throw error;
        }, function () {
          throw error;
        });
      });
  }

  function stamp() {
    var now = new Date();
    function pad(value) {
      return value < 10 ? "0" + value : String(value);
    }
    return "" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
  }

  // Returns { channel: "file" | "clipboard", name }.
  function exportText(text, baseName) {
    if (!supported()) {
      return F.api.copy(text).then(function () {
        return { channel: "clipboard", name: baseName };
      });
    }
    var ft = transfer();
    var name = baseName.replace(/\.json$/, "") + "-" + stamp() + ".json";
    var bytes = toBytes(text);
    return ft.beginSave({ name: name, size: bytes.byteLength, contentType: "application/json" }).then(function (target) {
      if (!target) return { channel: "cancelled", name: name };
      return ft.write(target.handleId, 0, bytes).then(function (written) {
        var offset = (written && written.nextOffset) || bytes.byteLength;
        if (offset < bytes.byteLength) return ft.cancel(target.handleId).then(function () {
          throw new Error("宿主只接受了 " + offset + "/" + bytes.byteLength + " 字节");
        });
        return ft.finish(target.handleId).then(function () {
          return { channel: "file", name: name };
        });
      });
    });
  }

  // Returns { text, name } or null when the user cancels.
  function importText() {
    if (!supported()) return Promise.resolve(null);
    var ft = transfer();
    return ft.pick({ multiple: false }).then(function (result) {
      var files = (result && result.files) || [];
      if (!files.length) return null;
      return readAll(files[0]).then(function (text) {
        return { text: text, name: files[0].name };
      });
    });
  }

  function onDrop(handler) {
    var ft = transfer();
    if (!ft || !ft.onDrop) return function () {};
    return ft.onDrop(function (files) {
      if (!files || !files.length) return;
      readAll(files[0]).then(function (text) {
        handler(text, files[0].name);
      }, function (error) {
        F.toast(F.messageOf(error), "error");
      });
    });
  }

  // ------------------------------------------------------------- store payloads

  function parseDoc(text, name) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(name + " 不是合法 JSON：" + error.message);
    }
    if (!parsed || !Array.isArray(parsed.favorites) || !Array.isArray(parsed.folders)) {
      throw new Error(name + " 里没有 favorites / folders 数组，不是 StashBox 导出文件");
    }
    if (!parsed.settings) parsed.settings = {};
    if (!parsed.ui) parsed.ui = { collapsed: [] };
    return parsed;
  }

  function exportDoc(doc) {
    return exportText(JSON.stringify(doc, null, 2), "stashbox-favorites.json");
  }

  function exportFlow(doc) {
    return exportDoc(doc).then(
      function (result) {
        if (result.channel === "file") F.toast("已导出 " + result.name, "success");
        else if (result.channel === "clipboard") F.toast("宿主未提供文件对话框，已把 JSON 复制到剪贴板", "info");
        return result;
      },
      function (error) {
        F.toast("导出失败：" + F.messageOf(error), "error");
      }
    );
  }

  function copyFlow(doc) {
    return F.api.copy(JSON.stringify(doc, null, 2)).then(
      function () {
        F.toast("完整 JSON 已复制到剪贴板", "success");
      },
      function (error) {
        F.toast("复制失败：" + F.messageOf(error), "error");
      }
    );
  }

  function confirmApply(parsed, name, current, onApply) {
    var before = ((current && current.favorites) || []).length;
    return F.confirmDialog(
      "导入收藏",
      name + " 含 " + parsed.favorites.length + " 条收藏、" + parsed.folders.length + " 个文件夹，将整体替换当前 " + before + " 条收藏与全部设置。",
      "导入并替换"
    ).then(function (yes) {
      if (!yes) return false;
      onApply(parsed);
      return true;
    });
  }

  function fromText(text, name, current, onApply) {
    var parsed;
    try {
      parsed = parseDoc(text, name);
    } catch (error) {
      F.toast(error.message, "error");
      return Promise.resolve(false);
    }
    return confirmApply(parsed, name, current, onApply);
  }

  function importFile(current, onApply) {
    if (!supported()) return pasteImport(current, onApply);
    return importText().then(function (result) {
      if (!result) return false;
      return fromText(result.text, result.name, current, onApply);
    });
  }

  function pasteImport(current, onApply) {
    var area = el("textarea", { class: "dbx-textarea", rows: 12, placeholder: "粘贴 StashBox 导出的 JSON" });
    F.dialog("粘贴导入", [el("div", { class: "dbx-hint", text: "导入会整体替换当前收藏、文件夹与设置。" }), area], [
      {
        label: "导入并替换",
        kind: "primary",
        action: function () {
          fromText(area.value, "剪贴板内容", current, onApply);
        }
      },
      { label: "取消", action: function () {} }
    ]);
    return Promise.resolve(false);
  }

  // The cabinet page keeps a single entry point instead of four buttons.
  function menu(current, onApply) {
    function withClose(action) {
      return function () {
        var root = document.getElementById("modal");
        root.classList.remove("modal--open");
        root.textContent = "";
        action();
      };
    }
    F.dialog("收藏数据", [
      el("p", { class: "dbx-hint", text: supported() ? "导出走系统原生保存对话框；导入支持选择文件，也可以直接把 JSON 拖到收藏页或配置页。" : "当前宿主没有开放文件对话框，导出会退回剪贴板。" }),
      el("div", { class: "toolbar" }, [
        el("button", { class: "dbx-btn dbx-btn--primary", text: "导出为 JSON 文件", onclick: withClose(function () { exportFlow(current); }) }),
        el("button", { class: "dbx-btn", text: "从 JSON 文件导入", onclick: withClose(function () { importFile(current, onApply); }) }),
        el("button", { class: "dbx-btn dbx-btn--ghost", text: "复制到剪贴板", onclick: withClose(function () { copyFlow(current); }) }),
        el("button", { class: "dbx-btn dbx-btn--ghost", text: "粘贴导入", onclick: withClose(function () { pasteImport(current, onApply); }) })
      ])
    ], [{ label: "关闭", action: function () {} }]);
  }

  window.Transfer = {
    supported: supported,
    exportText: exportText,
    importText: importText,
    onDrop: onDrop,
    toBytes: toBytes,
    parseDoc: parseDoc,
    fromText: fromText,
    exportFlow: exportFlow,
    copyFlow: copyFlow,
    importFile: importFile,
    pasteImport: pasteImport,
    menu: menu
  };
  window.Porter = window.Transfer;
})();
