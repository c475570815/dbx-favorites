// StashBox cabinet: folders and stashed tables rendered as one tree, with a Chinese display name per
// table and native reopen straight from the row.
(function () {
  var F = window.Fav;
  var el = F.el;
  var dialog = F.dialog;

  var state = {
    store: { folders: [], favorites: [], settings: {}, ui: { collapsed: [] } },
    connections: [],
    query: "",
    busy: false,
    model: null
  };

  var wired = false;

  function folders() {
    return state.store.folders || [];
  }

  function favorites() {
    return state.store.favorites || [];
  }

  function collapsed() {
    return (state.store.ui && state.store.ui.collapsed) || [];
  }

  function settings() {
    return state.store.settings || {};
  }

  // Persists the folder used most recently (single key, single file write) so the next stash
  // dialog opens on it. Failures are non-fatal: the dialog still works with its default folder.
  function rememberFolder(folderId) {
    if (!folderId || settings().rememberLastFolder === folderId) return Promise.resolve();
    return F.invoke("favorites/settings/update", { settings: { rememberLastFolder: folderId } })
      .then(reload)
      .catch(function () {});
  }

  function reload() {
    return F.invoke("favorites/store/get").then(function (store) {
      state.store = store || { folders: [], favorites: [], settings: {}, ui: { collapsed: [] } };
      if (!state.store.ui) state.store.ui = { collapsed: [] };
    });
  }

  function run(method, params, ok) {
    if (state.busy) return Promise.reject(new Error("正在处理上一步操作"));
    state.busy = true;
    render();
    return F.invoke(method, params || {})
      .then(function (result) {
        return reload().then(function () {
          state.busy = false;
          if (ok) F.toast(ok, "success");
          render();
          return result;
        });
      })
      .catch(function (error) {
        state.busy = false;
        render();
        F.toast(F.messageOf(error), "error");
        throw error;
      });
  }

  // ------------------------------------------------------------------- actions

  function openItem(item, button) {
    var label = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "打开中";
    }
    function restore() {
      if (button) {
        button.disabled = false;
        button.textContent = label;
      }
    }
    return F.invoke("favorites/open", { id: item.id }).then(
      function (result) {
        restore();
        if (result.ok) {
          var succeeded = (result.attempts || []).filter(function (attempt) { return attempt.ok; })[0] || {};
          F.toast("已打开 " + (item.label || item.table) + " · " + (result.channel || "bridge") + " " + (succeeded.latencyMs != null ? succeeded.latencyMs + "ms" : ""), "success");
          reload().then(render);
        } else {
          showFailure(item, result);
        }
      },
      function (error) {
        restore();
        F.toast("打开失败：" + F.messageOf(error), "error");
      }
    );
  }

  function showFailure(item, result) {
    var lines = ((result && result.attempts) || []).map(function (attempt) {
      return "· " + attempt.channel + " " + (attempt.ok ? "成功" : attempt.detail || "失败") + " (" + attempt.latencyMs + "ms)";
    });
    var sql = "SELECT * FROM " + F.qualifiedName(item) + " LIMIT 100";
    dialog("打不开 " + (item.label || item.table), [
      el("p", { class: "dbx-hint", text: "原生视图没打开。可以复制下面的语句到查询编辑器执行，或复制表名后在左侧对象树定位。" }),
      el("pre", { class: "code", text: sql }),
      el("div", { class: "attempts", text: lines.join("\n") })
    ], [
      { label: "复制 SQL", kind: "primary", action: function () { return F.api.copy(sql).then(function () { F.toast("SQL 已复制", "success"); }); } },
      { label: "复制表名", action: function () { return F.api.copy(F.qualifiedName(item)).then(function () { F.toast("表名已复制", "success"); }); } },
      { label: "收藏配置", action: function () { window.Stash.show("settings"); } },
      { label: "关闭", action: function () {} }
    ]);
  }

  function preview(item) {
    return F.invoke("favorites/table/describe", {
      connectionId: item.connectionId,
      connectionName: item.connectionName,
      database: item.database,
      schema: item.schema,
      table: item.table
    }).then(
      function (result) {
        var rows = result.rows || [];
        var table = el("table", { class: "dbx-table" }, [
          el("thead", {}, [el("tr", {}, ["列", "类型", "空", "注释"].map(function (title) {
            return el("th", { text: title });
          }))]),
          el("tbody", {}, rows.map(function (column) {
            return el("tr", {}, [
              el("td", {}, [el("span", { class: "mono", text: column.name }), column.is_primary_key ? el("span", { class: "dbx-badge", text: "PK" }) : null]),
              el("td", { class: "mono", text: column.data_type || "" }),
              el("td", { text: column.is_nullable ? "NULL" : "NOT NULL" }),
              el("td", { text: column.comment || "" })
            ]);
          }))
        ]);
        dialog(item.label || item.table, [el("p", { class: "mono dbx-hint", text: F.qualifiedName(item) + " · " + rows.length + " 列" }), el("div", { class: "scroll" }, [table])], [
          { label: "复制表名", action: function () { return F.api.copy(F.qualifiedName(item)); } },
          { label: "关闭", action: function () {} }
        ]);
      },
      function (error) {
        F.toast("读取结构失败：" + F.messageOf(error), "error");
      }
    );
  }

  function renameItem(item) {
    var input = el("input", { class: "dbx-input", value: item.label || "", placeholder: "例如：风险区表" });
    dialog("改中文名", [
      el("div", { class: "labelrow" }, [el("span", { text: "名称" }), input]),
      el("p", { class: "dbx-hint", text: "物理表名 " + F.qualifiedName(item) + " 不受影响，树里优先显示这个中文名。" })
    ], [
      {
        label: "保存",
        kind: "primary",
        action: function () {
          return run("favorites/update", { id: item.id, label: input.value.trim() }, "名称已更新");
        }
      },
      { label: "取消", action: function () {} }
    ]);
    input.focus();
    input.select();
  }

  function editNote(item) {
    var input = el("textarea", { class: "dbx-textarea", rows: 3 });
    input.value = item.note || "";
    dialog("备注 · " + (item.label || item.table), [input], [
      { label: "保存", kind: "primary", action: function () { return run("favorites/update", { id: item.id, note: input.value }, "备注已更新"); } },
      { label: "取消", action: function () {} }
    ]);
  }

  function moveItem(item) {
    var select = el("select", { class: "dbx-select" }, folders().map(function (folder) {
      var option = el("option", { value: folder.id, text: folder.name });
      if (folder.id === item.folderId) option.selected = true;
      return option;
    }));
    dialog("移动到文件夹", [el("div", { class: "field" }, [el("label", { class: "dbx-label", text: "目标" }), select])], [
      { label: "移动", kind: "primary", action: function () { return run("favorites/move", { id: item.id, folderId: select.value }, "已移动"); } },
      { label: "取消", action: function () {} }
    ]);
  }

  function removeItem(item) {
    return F.confirmDialog("移除收藏", (item.label || item.table) + "（" + F.qualifiedName(item) + "）将从柜子中移除，不影响数据库里的表。", "移除").then(function (yes) {
      if (!yes) return null;
      return run("favorites/remove", { id: item.id }, "已移除");
    });
  }

  function leafMenu(item) {
    dialog((item.label || item.table) + " · 操作", [
      el("p", { class: "mono dbx-hint", text: F.qualifiedName(item) + " @ " + (item.connectionName || item.connectionId) }),
      el("div", { class: "toolbar" }, [
        el("button", { class: "dbx-btn dbx-btn--primary", text: "打开", onclick: function () { closeMenu(); openItem(item); } }),
        el("button", { class: "dbx-btn", text: "查看结构", onclick: function () { closeMenu(); preview(item); } }),
        el("button", { class: "dbx-btn", text: "改中文名", onclick: function () { closeMenu(); renameItem(item); } }),
        el("button", { class: "dbx-btn", text: "备注", onclick: function () { closeMenu(); editNote(item); } }),
        el("button", { class: "dbx-btn", text: "移动到…", onclick: function () { closeMenu(); moveItem(item); } }),
        el("button", { class: "dbx-btn dbx-btn--danger", text: "移除", onclick: function () { closeMenu(); removeItem(item); } })
      ])
    ], [{ label: "关闭", action: function () {} }]);
  }

  function closeMenu() {
    var root = document.getElementById("modal");
    root.classList.remove("modal--open");
    root.textContent = "";
  }

  function renameFolder(node) {
    var input = el("input", { class: "dbx-input", value: node.name });
    dialog("重命名文件夹", [el("div", { class: "field" }, [input])], [
      {
        label: "保存",
        kind: "primary",
        action: function () {
          var name = input.value.trim();
          if (!name) return Promise.resolve();
          return run("favorites/folder/rename", { id: node.id, name: name }, "已重命名");
        }
      },
      { label: "取消", action: function () {} }
    ]);
    input.focus();
    input.select();
  }

  function newFolder(parentId) {
    var input = el("input", { class: "dbx-input", placeholder: "例如：核心业务" });
    dialog("新建文件夹", [el("div", { class: "field" }, [el("label", { class: "dbx-label", text: "名称" }), input])], [
      {
        label: "创建",
        kind: "primary",
        action: function () {
          var name = input.value.trim();
          if (!name) return Promise.resolve();
          return run("favorites/folder/add", { name: name, parentId: parentId || null }, "已创建 " + name);
        }
      },
      { label: "取消", action: function () {} }
    ]);
    input.focus();
  }

  function deleteFolder(node) {
    return F.confirmDialog("删除文件夹", "删除“" + node.name + "”（含 " + node.total + " 条收藏）后，其中的收藏会退回“未分类”，子文件夹保留并移到顶层。", "删除文件夹").then(function (yes) {
      if (!yes) return null;
      return run("favorites/folder/remove", { id: node.id, force: true }, "已删除文件夹");
    });
  }

  function folderMenu(node) {
    dialog(node.name + " · 操作", [
      el("div", { class: "toolbar" }, [
        el("button", { class: "dbx-btn dbx-btn--primary", text: "往这里收表", onclick: function () { closeMenu(); browseDialog(node.id); } }),
        el("button", { class: "dbx-btn", text: "新建子文件夹", onclick: function () { closeMenu(); newFolder(node.id); } }),
        el("button", { class: "dbx-btn", text: "重命名", onclick: function () { closeMenu(); renameFolder(node); } }),
        el("button", { class: "dbx-btn", text: node.open ? "折叠" : "展开", onclick: function () { closeMenu(); toggle(node); render({ animate: false }); } }),
        el("button", { class: "dbx-btn dbx-btn--danger", text: "删除", onclick: function () { closeMenu(); deleteFolder(node); } })
      ])
    ], [{ label: "关闭", action: function () {} }]);
  }

  // The tree already flipped itself in the DOM; this only records the new state.
  function toggle(node) {
    var list = collapsed().filter(function (id) {
      return id !== node.id;
    });
    if (!node.open) list.push(node.id);
    state.store.ui.collapsed = list;
    return F.invoke("favorites/ui/toggle", { id: node.id, collapsed: !node.open }).catch(function () {});
  }

  function setAll(collapse) {
    state.store.ui.collapsed = collapse ? folders().map(function (folder) {
      return folder.id;
    }) : [];
    render();
    return F.invoke("favorites/ui/collapse-all", { collapsed: collapse })
      .then(reload)
      .then(function () { render({ animate: false }); })
      .catch(function (error) {
        F.toast("操作失败：" + F.messageOf(error), "error");
        return reload().then(render);
      });
  }

  function moveToFolder(favoriteId, folderId) {
    return run("favorites/move", { id: favoriteId, folderId: folderId }, "已移入").then(function () {
      // The row was rebuilt by render(), so flash the node that now stands for this table.
      var row = document.querySelector('[data-fav="' + favoriteId + '"]');
      if (!row) return;
      row.classList.add("row--hit");
      setTimeout(function () {
        row.classList.remove("row--hit");
      }, 620);
    });
  }

  // ------------------------------------------------------------------- browse

  function browseDialog(presetFolder) {
    var connectionSelect = el("select", { class: "dbx-select" }, [el("option", { value: "", text: "选择连接…" })].concat(
      state.connections.map(function (connection) {
        return el("option", { value: connection.id, text: (connection.name || connection.id) + " · " + (connection.dbType || "") });
      })
    ));
    var databaseInput = el("input", { class: "dbx-input", placeholder: "库名，留空用连接默认库" });
    var schemaInput = el("input", { class: "dbx-input", placeholder: "模式，如 zhd_dp" });
    var remembered = settings().rememberLastFolder;
    var folderSelect = el("select", { class: "dbx-select" }, folders().map(function (folder) {
      var option = el("option", { value: folder.id, text: folder.name });
      var preferred = presetFolder || remembered;
      if (preferred && folder.id === preferred) option.selected = true;
      return option;
    }));
    var filter = el("input", { class: "dbx-input", placeholder: "过滤表名 / 注释" });
    var list = el("div", { class: "tablelist" });
    var status = el("div", { class: "dbx-hint", text: "列表来自 DBX 本机桥接，不额外申请执行权限；视图 / 物化视图同样可收（DBX 只在表节点上挂右键菜单），勾选后可逐条填中文名。" });
    var loaded = [];

    function currentConnection() {
      for (var i = 0; i < state.connections.length; i++) {
        if (state.connections[i].id === connectionSelect.value) return state.connections[i];
      }
      return null;
    }

    function paint() {
      var needle = filter.value.trim().toLowerCase();
      list.textContent = "";
      var visible = loaded.filter(function (row) {
        return !needle || (row.name + " " + (row.comment || "")).toLowerCase().indexOf(needle) >= 0;
      });
      if (!visible.length) {
        list.appendChild(el("div", { class: "dbx-hint", text: loaded.length ? "没有匹配的表" : "先选连接，点“加载表”" }));
        return;
      }
      visible.forEach(function (row) {
        var box = el("input", { type: "checkbox" });
        var suggestion = row.comment ? firstWords(row.comment) : "";
        var name = el("input", { class: "dbx-input", placeholder: "中文名，可留空", value: row.label === undefined ? suggestion : row.label });
        // Re-filtering rebuilds these inputs, so checkbox state and the edited name live on the
        // row object; otherwise filtering after ticking rows silently dropped the selection.
        box.checked = !!row.checked;
        box.addEventListener("change", function () {
          row.checked = box.checked;
        });
        name.addEventListener("input", function () {
          row.label = name.value;
        });
        list.appendChild(el("label", { class: "picker" }, [
          box,
          el("span", { class: "picker__name", text: row.name, title: row.name }),
          el("span", { class: "picker__type", text: row.table_type || "" }),
          el("span", { class: "picker__cn" }, [name])
        ]));
      });
    }

    function load() {
      var connection = currentConnection();
      if (!connection) {
        F.toast("请先选择连接", "error");
        return Promise.resolve();
      }
      status.textContent = "加载中…";
      return F.invoke("favorites/tables/list", {
        connectionId: connection.id,
        connectionName: connection.name || "",
        database: databaseInput.value.trim(),
        schema: schemaInput.value.trim()
      }).then(
        function (result) {
          loaded = result.rows || [];
          status.textContent = "共 " + loaded.length + " 个对象 · 桥接端口 " + result.port;
          paint();
        },
        function (error) {
          loaded = [];
          status.textContent = "加载失败：" + F.messageOf(error);
          paint();
        }
      );
    }

    filter.addEventListener("input", paint);
    databaseInput.addEventListener("change", load);
    schemaInput.addEventListener("change", load);
    connectionSelect.addEventListener("change", load);

    var body = el("div", {}, [
      el("div", { class: "grid" }, [
        el("div", { class: "field" }, [el("label", { class: "dbx-label", text: "连接" }), connectionSelect]),
        el("div", { class: "field" }, [el("label", { class: "dbx-label", text: "数据库" }), databaseInput]),
        el("div", { class: "field" }, [el("label", { class: "dbx-label", text: "模式" }), schemaInput]),
        el("div", { class: "field" }, [el("label", { class: "dbx-label", text: "存入文件夹" }), folderSelect])
      ]),
      el("div", { class: "toolbar" }, [el("button", { class: "dbx-btn dbx-btn--primary", text: "加载表", onclick: load }), filter]),
      status,
      el("div", { class: "dbx-hint", text: "提示：勾上表以后，右侧中文名留空则取注释的前几个字，双击行可直接改。" }),
      list
    ]);

    dialog("收表", [body], [
      {
        label: "加入收藏",
        kind: "primary",
        action: function () {
          // Selections are read from the row model, not the rebuilt DOM, so filtered-out ticks count.
          var picked = loaded.filter(function (row) { return row.checked; });
          if (!picked.length) {
            F.toast("没有勾选任何表", "error");
            return Promise.resolve();
          }
          var connection = currentConnection();
          var created = 0;
          var existed = 0;
          var chain = Promise.resolve();
          picked.forEach(function (row) {
            chain = chain.then(function () {
              return F.invoke("favorites/add", {
                connectionId: connection ? connection.id : "",
                connectionName: connection ? connection.name || "" : "",
                database: databaseInput.value.trim(),
                schema: schemaInput.value.trim(),
                table: row.name,
                label: row.label === undefined ? (row.comment ? firstWords(row.comment) : "") : String(row.label).trim(),
                folderId: folderSelect.value
              }).then(function (result) {
                if (result && result.existing) existed++;
                else created++;
              });
            });
          });
          return chain
            .then(function () {
              return rememberFolder(folderSelect.value);
            })
            .then(function () {
              return reload();
            })
            .then(function () {
              render();
              F.toast("新增 " + created + " 条收藏" + (existed ? "，已在该文件夹中 " + existed + " 条" : ""), "success");
            });
        }
      },
      { label: "取消", action: function () {} }
    ]);
  }

  // Comment text is often a full sentence; the first clause makes a decent default display name.
  function firstWords(comment) {
    var cleaned = String(comment).replace(/\s+/g, " ").split(/[（(，,。；:：/]/)[0].trim();
    return cleaned.length > 18 ? cleaned.slice(0, 18) : cleaned;
  }

  // ------------------------------------------------------------------- shell

  var shell = { tally: null, cabinet: null, busy: null, mounted: null };

  function mount() {
    var root = document.getElementById("app");
    // The settings page clears #app, which detaches the cached shell nodes without changing the
    // root reference: also verify the cabinet is still connected before reusing the cache.
    if (shell.mounted === root && shell.cabinet && shell.cabinet.parentNode === root) return;
    root.textContent = "";
    shell.tally = el("div", { class: "mast__tally" });
    var mast = el("header", { class: "mast" }, [
      el("div", { class: "mast__brand" }, [
        window.Tree.icon("star", "mast__mark"),
        el("span", { class: "mast__name", text: "StashBox" }),
        el("span", { class: "mast__sub", text: "表收藏柜" })
      ]),
      shell.tally
    ]);
    shell.cabinet = el("div", { class: "cabinet" });
    shell.busy = el("div", { class: "busy", text: "处理中" });
    shell.busy.style.display = "none";
    root.appendChild(mast);
    root.appendChild(tools());
    root.appendChild(ruler());
    root.appendChild(shell.cabinet);
    root.appendChild(shell.busy);
    shell.mounted = root;
  }

  function applyDoc(parsed) {
    return F.invoke("favorites/store/replace", { data: parsed })
      .then(reload)
      .then(function () {
        render({ animate: false });
        F.toast("已导入 " + (parsed.favorites || []).length + " 条收藏", "success");
      })
      .catch(function (error) {
        F.toast("导入失败：" + F.messageOf(error), "error");
      });
  }

  function paintTally() {
    var stats = state.model ? state.model.stats : { folders: 0, favorites: 0, hits: 0 };
    var recent = favorites().filter(function (item) {
      return item.lastOpenedAt;
    }).sort(function (a, b) {
      return String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt));
    })[0];
    shell.tally.textContent = "";
    [
      el("span", {}, [el("b", { text: String(stats.favorites) }), document.createTextNode(" 张表")]),
      el("span", {}, [el("b", { text: String(stats.folders) }), document.createTextNode(" 个文件夹")]),
      state.query ? el("span", {}, [el("i", { text: "命中 " + stats.hits })]) : null,
      recent ? el("span", {}, [document.createTextNode("最近 "), el("i", { text: recent.label || recent.table })]) : null
    ].forEach(function (node) {
      if (node) shell.tally.appendChild(node);
    });
  }

  function treeCtx() {
    return {
      connections: state.connections,
      byFolderId: function (id) {
        var found = null;
        function walk(nodes) {
          nodes.forEach(function (node) {
            if (node.kind === "folder") {
              if (node.id === id) found = node;
              walk(node.children);
            }
          });
        }
        walk(state.model.roots);
        return found;
      },
      onToggle: toggle,
      onOpen: openItem,
      onPreview: preview,
      onLeafMenu: leafMenu,
      onFolderMenu: folderMenu,
      onAddTo: function (node) {
        browseDialog(node.id);
      },
      onMoveTo: moveToFolder
    };
  }

  function render(options) {
    var opts = options || {};
    mount();
    state.model = window.Tree.build({
      folders: folders(),
      favorites: favorites(),
      query: state.query,
      collapsed: collapsed()
    });
    paintTally();
    shell.busy.style.display = state.busy ? "" : "none";
    window.Tree.paint(shell.cabinet, state.model, treeCtx(), opts.animate === false ? false : true);
  }

  function tools() {
    var search = el("input", {
      type: "search",
      placeholder: "搜中文名 / 表名 / 备注",
      value: state.query,
      oninput: function () {
        state.query = search.value;
        render({ animate: false });
      }
    });
    return el("div", { class: "tools" }, [
      el("div", { class: "tools__search" }, [
        el("label", { text: "找" }),
        search,
        el("span", { class: "tools__key", text: "/" })
      ]),
      el("div", { class: "tools__right" }, [
        el("button", { class: "tbtn tbtn--go", text: "收表", onclick: function () { browseDialog(null); } }),
        el("button", { class: "tbtn", text: "新建文件夹", onclick: function () { newFolder(null); } }),
        el("button", { class: "tbtn tbtn--quiet", text: "展开全部", onclick: function () { setAll(false); } }),
        el("button", { class: "tbtn tbtn--quiet", text: "折叠全部", onclick: function () { setAll(true); } }),
        el("button", { class: "tbtn tbtn--quiet", text: "导入导出", onclick: function () { window.Porter.menu(state.store, applyDoc); } }),
        el("button", { class: "tbtn tbtn--quiet", text: "刷新", onclick: function () { F.connections(true).then(function (list) { state.connections = list; }); reload().then(function () { render({ animate: false }); }); } }),
        el("button", { class: "tbtn tbtn--quiet", text: "配置", onclick: function () { window.Stash.show("settings"); } })
      ])
    ]);
  }

  function ruler() {
    return el("div", { class: "ruler" }, [
      el("span", { text: "文件夹 · 中文名 · 库.模式.表" }),
      el("span", { class: "ruler__num", text: "打开" }),
      el("span", { class: "ruler__act", text: "操作" })
    ]);
  }

  // ------------------------------------------------------------------ context

  function handleContext() {
    var context = F.context() || {};
    var plugin = context.plugin || {};
    if (plugin.mode === "open" && plugin.favoriteId) {
      var id = plugin.favoriteId;
      var item = null;
      favorites().forEach(function (candidate) {
        if (candidate.id === id) item = candidate;
      });
      if (!item) {
        F.toast("这条收藏已经不在柜子里了", "error");
        return;
      }
      openItem(item, null);
      return;
    }
    if (context.table) offerAdd(context);
  }

  function offerAdd(context) {
    var identity = {
      connectionId: context.connectionId || "",
      connectionName: context.connectionName || "",
      database: context.database || "",
      schema: context.schema || "",
      table: context.table
    };
    var nameInput = el("input", { class: "dbx-input", placeholder: "例如：风险区表" });
    // Reopen the folder chosen last time instead of always landing on the first entry.
    var preferredFolder = settings().rememberLastFolder;
    var folderSelect = el("select", { class: "dbx-select" }, folders().map(function (folder) {
      var option = el("option", { value: folder.id, text: folder.name });
      if (preferredFolder && folder.id === preferredFolder) option.selected = true;
      return option;
    }));
    function stash() {
      return F.invoke("favorites/add", {
        connectionId: identity.connectionId,
        connectionName: identity.connectionName,
        database: identity.database,
        schema: identity.schema,
        table: identity.table,
        label: nameInput.value.trim(),
        folderId: folderSelect.value
      });
    }
    // The settings toggle only decides which action is the default (primary); both are always
    // offered so the user can stash a table without leaving the current view.
    var openAfterStash = settings().openOnAdd !== false;
    function openFavorite(result) {
      return F.invoke("favorites/open", { id: result.favorite.id }).then(function (opened) {
        if (opened.ok) F.toast("已打开 " + identity.table, "success");
        else showFailure(result.favorite, opened);
      });
    }
    // Shared persist step: add on the sidecar, remember the chosen folder, refresh the tree.
    function persistStash() {
      return stash()
        .then(function (result) {
          return rememberFolder(folderSelect.value).then(function () { return result; });
        })
        .then(reload)
        .then(function (result) {
          render();
          return result;
        });
    }
    function saveOnly() {
      return persistStash().then(function (result) {
        F.toast("已收藏 " + (result.favorite.label || identity.table), "success");
      });
    }
    function saveAndOpen() {
      return persistStash().then(openFavorite);
    }
    var saveOnlyAction = { label: "仅收藏", title: "收藏但不打开表", action: saveOnly };
    var saveAndOpenAction = { label: "收藏并打开", title: "收藏并立即打开原生表视图", action: saveAndOpen };
    var actions = openAfterStash ? [saveAndOpenAction, saveOnlyAction] : [saveOnlyAction, saveAndOpenAction];
    actions[0].kind = "primary";
    actions.push({ label: "取消", action: function () {} });
    dialog("收藏这张表", [
      el("div", { class: "labelrow" }, [
        el("span", { text: "表" }),
        el("code", { text: (identity.connectionName || identity.connectionId.slice(0, 8)) + " · " + (identity.database || "?") + "." + (identity.schema || "?") + "." + identity.table })
      ]),
      el("div", { class: "grid" }, [
        el("div", { class: "field" }, [el("label", { class: "dbx-label", text: "中文名称" }), nameInput]),
        el("div", { class: "field" }, [el("label", { class: "dbx-label", text: "文件夹" }), folderSelect])
      ])
    ], actions);
    nameInput.focus();
  }

  // --------------------------------------------------------------------- boot

  function boot() {
    return Promise.all([reload(), F.connections()])
      .then(function (results) {
        state.connections = results[1] || [];
        render();
        handleContext();
        if (wired) return;
        wired = true;
        F.onContext(function (context) {
          if (window.Stash.current() === "favorites" && context && context.table) handleContext();
        });
        F.onEvent(function (event) {
          if (event && (event.method === "host.pluginsChanged" || event.type === "env")) render();
        });
        if (window.Porter) {
          window.Porter.onDrop(function (text, name) {
            window.Porter.fromText(text, name, state.store, applyDoc);
          });
        }
        document.addEventListener("keydown", function (event) {
          if (window.Stash.current() !== "favorites") return;
          var target = event.target;
          var typing = target && /input|textarea|select/i.test(target.tagName || "");
          if (event.key === "/" && !typing) {
            event.preventDefault();
            var input = document.querySelector(".tools__search input");
            if (input) input.focus();
          }
        });
      })
      .catch(function (error) {
        var root = document.getElementById("app");
        if (root) root.appendChild(el("div", { class: "block", text: "初始化失败：" + F.messageOf(error) }));
      });
  }

  window.FavoritesPage = { boot: boot };
})();
