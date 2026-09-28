// Folder + favorite tree: nested model, connection-rail rendering, keyboard navigation and
// drag-to-move. Folders and their stashed tables form one tree, so a browse target and its
// Chinese display name sit on the same row.
(function () {
  var F = window.Fav;
  var el = F.el;

  var GLYPH = {
    chevron: "M5 3l5 5-5 5",
    drawer: "M1.5 2.5h11v4h-11zM1.5 8.5h11v4h-11z M8 4.5h1.5 M8 10.5h1.5",
    table: "M1.5 2.5h11v10h-11z M1.5 6h11 M5.5 6v6.5",
    plus: "M7 2.5v9 M2.5 7h9",
    dots: "M3 7h1.4 M7 7h1.4 M11 7h1.4",
    star: "M7 1l1.7 3.5 3.8.5-2.8 2.7.7 3.8L7 9.7l-3.4 1.8.7-3.8L1.5 5l3.8-.5z"
  };

  function icon(name, extra) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    // Without intrinsic width/height an inline SVG resolves to 100% of an auto-sized button and
    // collapses to nothing, which is why the action icons rendered as empty boxes.
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.3");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (extra) svg.setAttribute("class", extra);
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", GLYPH[name] || GLYPH.dots);
    svg.appendChild(path);
    return svg;
  }

  function text(node) {
    return node && node.label ? node.label : (node && node.name ? node.name : "");
  }

  function order(a, b) {
    var byOrder = (a.order || 0) - (b.order || 0);
    if (byOrder) return byOrder;
    return String(text(a)).localeCompare(String(text(b)), "zh-Hans-CN");
  }

  function matches(item, needle) {
    if (!needle) return true;
    var haystack = [item.label, item.table, item.note, item.database, item.schema, item.connectionName]
      .join(" ")
      .toLowerCase();
    return haystack.indexOf(needle) >= 0;
  }

  // build() returns {roots, stats}. Query mode flattens to the branches that hold a hit so search
  // never hides half of a folder behind a collapsed parent.
  function build(options) {
    var folders = (options.folders || []).slice();
    var favorites = (options.favorites || []).slice();
    var needle = (options.query || "").trim().toLowerCase();
    var collapsed = {};
    (options.collapsed || []).forEach(function (id) {
      collapsed[id] = true;
    });

    favorites.sort(function (a, b) {
      return String(text(a) || a.table).localeCompare(String(text(b) || b.table), "zh-Hans-CN");
    });

    var kids = {};
    folders.forEach(function (folder) {
      var key = folder.parentId || "#";
      (kids[key] = kids[key] || []).push(folder);
    });
    Object.keys(kids).forEach(function (key) {
      kids[key].sort(order);
    });

    var inFolder = {};
    favorites.forEach(function (item) {
      var key = item.folderId || "inbox";
      (inFolder[key] = inFolder[key] || []).push(item);
    });

    function holdsHit(folder) {
      if (needle && text(folder).toLowerCase().indexOf(needle) >= 0) return true;
      var direct = inFolder[folder.id] || [];
      for (var i = 0; i < direct.length; i++) {
        if (matches(direct[i], needle)) return true;
      }
      var branches = kids[folder.id] || [];
      for (var j = 0; j < branches.length; j++) {
        if (holdsHit(branches[j])) return true;
      }
      return false;
    }

    function countAll(folder) {
      var total = (inFolder[folder.id] || []).length;
      (kids[folder.id] || []).forEach(function (child) {
        total += countAll(child);
      });
      return total;
    }

    function walk(folder) {
      var own = (inFolder[folder.id] || []).filter(function (item) {
        return needle ? matches(item, needle) || text(folder).toLowerCase().indexOf(needle) >= 0 : true;
      });
      var branches = (kids[folder.id] || []).filter(function (child) {
        return !needle || holdsHit(child);
      });
      var node = {
        kind: "folder",
        id: folder.id,
        folder: folder,
        name: text(folder) || "未命名",
        total: countAll(folder),
        direct: own.length,
        open: needle ? true : !collapsed[folder.id],
        children: []
      };
      branches.forEach(function (child) {
        node.children.push(walk(child));
      });
      own.forEach(function (item) {
        node.children.push({ kind: "leaf", id: item.id, item: item, children: [] });
      });
      return node;
    }

    function parentMissing(folder) {
      if (!folder.parentId) return false;
      for (var i = 0; i < folders.length; i++) {
        if (folders[i].id === folder.parentId) return false;
      }
      return true;
    }

    var roots = folders
      .filter(function (folder) {
        return !folder.parentId || parentMissing(folder);
      })
      .sort(order)
      .filter(function (folder) {
        return !needle || holdsHit(folder);
      })
      .map(walk);

    var orphans = favorites.filter(function (item) {
      if (needle && !matches(item, needle)) return false;
      var known = false;
      for (var i = 0; i < folders.length; i++) {
        if (folders[i].id === item.folderId) known = true;
      }
      return !known;
    });
    if (orphans.length) {
      roots.push({
        kind: "folder",
        id: "__loose",
        name: "散表",
        total: orphans.length,
        direct: orphans.length,
        open: needle ? true : !collapsed.__loose,
        children: orphans.map(function (item) {
          return { kind: "leaf", id: item.id, item: item, children: [] };
        })
      });
    }

    return {
      roots: roots,
      stats: {
        folders: folders.length,
        favorites: favorites.length,
        hits: needle ? countLeaves(roots) : favorites.length
      }
    };
  }

  function countLeaves(nodes) {
    var total = 0;
    nodes.forEach(function (node) {
      if (node.kind === "leaf") total++;
      else total += countLeaves(node.children);
    });
    return total;
  }

  // ---------------------------------------------------------------- rendering

  // Prefer the live connection name: the snapshot stored on the favorite goes stale when the
  // connection is renamed in DBX.
  function connectionTag(ctx, item) {
    if (item.connectionId) {
      for (var i = 0; i < ctx.connections.length; i++) {
        var connection = ctx.connections[i];
        if (connection.id === item.connectionId) {
          return connection.name || connection.label || item.connectionName || item.connectionId;
        }
      }
    }
    return item.connectionName || F.connectionName(ctx.connections, item.connectionId);
  }

  function leafRow(node, ctx) {
    var item = node.item;
    var named = !!item.label;
    var open = el("button", { class: "act act--go", text: "打开", title: "在 DBX 原生表视图中打开" });
    open.addEventListener("click", function (event) {
      event.stopPropagation();
      ctx.onOpen(item, open);
    });
    var row = el("div", {
      class: "row row--leaf" + (named ? "" : " row--anon"),
      tabindex: "-1",
      draggable: "true",
      "data-fav": item.id
    }, [
      el("span", { class: "row__icon" }, [icon("table")]),
      el("span", { class: "row__name", text: item.label || item.table, title: item.label || "" }),
      el("span", { class: "row__path", text: F.qualifiedName(item) }),
      el("span", { class: "row__tag", text: connectionTag(ctx, item) }),
      el("span", { class: "row__num", text: String(item.openCount || 0) }),
      el("span", { class: "row__acts" }, [open, el("button", { class: "act", text: "结构", title: "查看列定义" }), el("button", { class: "act act--icon", title: "更多操作" }, [icon("dots")])])
    ]);
    var acts = row.querySelectorAll(".act");
    acts[1].addEventListener("click", function (event) {
      event.stopPropagation();
      ctx.onPreview(item);
    });
    acts[2].addEventListener("click", function (event) {
      event.stopPropagation();
      ctx.onLeafMenu(item);
    });
    row.addEventListener("click", function () {
      ctx.onOpen(item, open);
    });
    row.addEventListener("dblclick", function () {
      ctx.onOpen(item, open);
    });
    row.addEventListener("dragstart", function (event) {
      row.classList.add("row--dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.id);
      }
    });
    row.addEventListener("dragend", function () {
      row.classList.remove("row--dragging");
    });
    return row;
  }

  // Expanding only inserts (or removes) this one branch, so a click never repaints the whole tree.
  function toggleInPlace(node, li, row, ctx) {
    node.open = !node.open;
    var caret = row.querySelector(".caret");
    if (caret) caret.className = "caret" + (node.open ? " caret--open" : "");
    row.className = "row row--folder" + (node.open ? " row--on" : "");
    var existing = li.querySelector(":scope > .branch");
    if (node.open && !existing && node.children.length) {
      var branch = el("ul", { class: "tree branch stagger" });
      node.children.forEach(function (child) {
        branch.appendChild(paintNode(child, ctx));
      });
      li.appendChild(branch);
    } else if (!node.open && existing) {
      li.removeChild(existing);
    }
    if (ctx.onToggle) ctx.onToggle(node);
  }

  function folderRow(node, ctx, li) {
    var open = el("span", { class: "caret" + (node.open ? " caret--open" : "") }, [icon("chevron")]);
    var row = el("div", {
      class: "row row--folder" + (node.open ? " row--on" : ""),
      tabindex: "-1",
      "data-dir": node.id
    }, [
      open,
      el("span", { class: "row__name", text: node.name }),
      el("span", { class: "row__count", text: String(node.total) }),
      el("span", { class: "row__acts" }, [
        el("button", { class: "act act--icon", title: "往此文件夹收表" }, [icon("plus")]),
      el("button", { class: "act act--icon", title: "文件夹操作" }, [icon("dots")])
      ])
    ]);
    row.querySelectorAll(".act")[0].addEventListener("click", function (event) {
      event.stopPropagation();
      ctx.onAddTo(node);
    });
    row.querySelectorAll(".act")[1].addEventListener("click", function (event) {
      event.stopPropagation();
      ctx.onFolderMenu(node);
    });
    row.addEventListener("click", function () {
      toggleInPlace(node, li, row, ctx);
    });
    row.addEventListener("dragover", function (event) {
      if (node.id === "__loose") return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      row.classList.add("row--drop");
    });
    row.addEventListener("dragleave", function () {
      row.classList.remove("row--drop");
    });
    row.addEventListener("drop", function (event) {
      event.preventDefault();
      row.classList.remove("row--drop");
      var id = event.dataTransfer ? event.dataTransfer.getData("text/plain") : null;
      if (id && node.id !== "__loose") ctx.onMoveTo(id, node.id, row);
    });
    return row;
  }

  function paintNode(node, ctx) {
    var li = el("li", { class: "node" + (node.kind === "leaf" ? " node--kid" : "") });
    li.appendChild(node.kind === "folder" ? folderRow(node, ctx, li) : leafRow(node, ctx));
    if (node.kind === "folder" && node.open && node.children.length) {
      var branch = el("ul", { class: "tree branch stagger" });
      node.children.forEach(function (child) {
        branch.appendChild(paintNode(child, ctx));
      });
      li.appendChild(branch);
    }
    return li;
  }

  function paint(host, model, ctx, animate) {
    host.textContent = "";
    if (!model.roots.length) {
      host.appendChild(emptyState(ctx));
      return;
    }
    var tree = el("ul", { class: "tree" + (animate === false ? "" : " stagger") });
    model.roots.forEach(function (node) {
      tree.appendChild(paintNode(node, ctx));
    });
    host.appendChild(tree);
    wireKeyboard(tree, ctx);
  }

  function emptyState(ctx) {
    return el("div", { class: "empty" }, [
      icon("drawer", ""),
      el("div", {}, [
        el("h4", { text: "柜子是空的" }),
        el("p", {}, [document.createTextNode("在左侧数据库树右键任意表，选 "), el("b", { text: "收藏此表" }), document.createTextNode("；或点上方 "), el("b", { text: "收表" }), document.createTextNode(" 按连接浏览。")]),
        el("p", { class: "dbx-hint", text: "收藏时可以填一个中文名称，之后在树里就按中文名找表。视图和物化视图只能在“收表”里勾选（DBX 只在表节点上挂插件右键菜单）。按 / 聚焦搜索，↑↓ 移动，→ 展开，Enter 打开。" })
      ])
    ]);
  }

  function rowsOf(tree) {
    return Array.prototype.slice.call(tree.querySelectorAll(".row"));
  }

  function wireKeyboard(tree, ctx) {
    tree.setAttribute("tabindex", "-1");
    var at = 0;
    // Rows are queried live: collapsing removes a branch from the DOM, expanding inserts one, so
    // a snapshot taken at paint time either hides new rows or points at detached ones.
    function visibleRows() {
      return rowsOf(tree);
    }
    function syncAt(rows) {
      var active = document.activeElement;
      var index = rows.indexOf(active);
      if (index >= 0) at = index;
    }
    function focus(index) {
      var rows = visibleRows();
      if (!rows.length) return;
      at = Math.max(0, Math.min(rows.length - 1, index));
      var row = rows[at];
      if (row && row.focus) row.focus();
    }
    // Keep the cursor in sync when the user moves focus with the mouse.
    tree.addEventListener("focusin", function () {
      syncAt(visibleRows());
    });
    tree.addEventListener("keydown", function (event) {
      var rows = visibleRows();
      if (!rows.length) return;
      syncAt(rows);
      var key = event.key;
      if (key === "ArrowDown") {
        event.preventDefault();
        focus(at + 1);
      } else if (key === "ArrowUp") {
        event.preventDefault();
        focus(at - 1);
      } else if (key === "Enter") {
        // Focus on an action button: let the browser activate that button itself instead of
        // firing both the button and the row (which would open the table twice).
        var target = event.target;
        if (target && target.closest && target.closest("button, input, select, textarea, a")) return;
        // Row click already means "open" for leaves and "toggle" for folders — reuse it so the
        // keyboard path performs exactly the same DOM update as the mouse path.
        var row = rows[at];
        if (row) {
          event.preventDefault();
          row.click();
        }
      } else if (key === "ArrowRight" || key === "ArrowLeft") {
        var folderRow = rows[at];
        var dir = folderRow && folderRow.getAttribute("data-dir");
        if (!dir) return;
        var node = ctx.byFolderId(dir);
        if (!node) return;
        if ((key === "ArrowRight" && !node.open) || (key === "ArrowLeft" && node.open)) {
          event.preventDefault();
          folderRow.click();
        }
      }
    });
  }

  window.Tree = { build: build, paint: paint, icon: icon, rowsOf: rowsOf };
})();
