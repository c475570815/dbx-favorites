// Entry point: Sidecar Protocol v1 loop plus the favorites RPC surface.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;

namespace DbxFavorites
{
    static class Program
    {
        static StreamWriter output;
        static readonly object OutputLock = new object();
        static Store store;

        static int Main(string[] args)
        {
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false };

            if (args.Length > 0 && args[0] == "--selftest") return Selftest();

            var directory = Environment.GetEnvironmentVariable("DBX_PLUGIN_DATA_DIR");
            if (string.IsNullOrEmpty(directory))
                directory = Path.Combine(Path.GetTempPath(), "dbx-favorites-dev");
            store = Store.Open(directory);

            Log("sidecar started; dataDir=" + directory + " appVersion=" + Env("DBX_APP_VERSION") +
                " hostApi=" + Env("DBX_HOST_API_VERSION") + " DBX_DATA_DIR=" + Env("DBX_DATA_DIR"));

            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0) continue;
                try
                {
                    Handle(trimmed);
                }
                catch (Exception error)
                {
                    Log("frame failed: " + error);
                }
            }
            Log("stdin closed; exiting");
            return 0;
        }

        static string Env(string name)
        {
            var value = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(value) ? "-" : value;
        }

        static void Handle(string frame)
        {
            var request = Values.AsMap(Json.Parse(frame));
            var id = Values.Get(request, "id");
            var method = Values.Str(Values.Get(request, "method"), "");
            var parameters = Values.AsMap(Values.Get(request, "params"));

            if (method == "plugin/initialize")
            {
                var host = Values.AsMap(Values.Get(parameters, "host"));
                var versions = Values.AsList(Values.Get(host, "protocolVersions"));
                var supported = false;
                foreach (var version in versions)
                {
                    var number = version as double?;
                    if (number != null && (int)number.Value == 1) supported = true;
                }
                if (!supported && versions.Count > 0)
                {
                    Respond(id, null, new RpcError(-32001, "DBX and plugin do not share a protocol version"));
                    return;
                }
                // The host rejects an identity mismatch, so the environment is authoritative and the
                // initialize payload is only a fallback for hosts that do not set it.
                var announced = Values.AsMap(Values.Get(parameters, "plugin"));
                Respond(id, Values.Map(
                    "protocolVersion", 1,
                    "capabilities", new List<object>(),
                    "plugin", Values.Map(
                        "id", Values.Str(Values.Get(announced, "id"), Env("DBX_PLUGIN_ID")),
                        "version", Values.Str(Values.Get(announced, "version"), Env("DBX_PLUGIN_VERSION")))), null);
                return;
            }

            var started = Stopwatch.StartNew();
            try
            {
                var result = Dispatch(method, parameters);
                started.Stop();
                if (id != null) Respond(id, result, null);
                Log(method + " ok " + started.ElapsedMilliseconds + "ms");
            }
            catch (RpcError error)
            {
                started.Stop();
                if (id != null) Respond(id, null, error);
                Log(method + " error " + error.Code + " " + error.Message);
            }
            catch (Exception error)
            {
                started.Stop();
                if (id != null) Respond(id, null, new RpcError(-32603, Bridge.Describe(error)));
                Log(method + " crash " + error);
            }
        }

        static void Respond(object id, object result, RpcError error)
        {
            Dictionary<string, object> message;
            if (error != null)
            {
                message = Values.Map("jsonrpc", "2.0", "id", id, "error",
                    Values.Map("code", error.Code, "message", error.Message));
            }
            else
            {
                message = Values.Map("jsonrpc", "2.0", "id", id, "result", result);
            }
            lock (OutputLock)
            {
                output.Write(Json.Write(message));
                output.Write("\n");
                output.Flush();
            }
        }

        static void Log(string message)
        {
            try
            {
                Console.Error.WriteLine("[dbx-favorites] " + message);
            }
            catch
            {
                // Stderr may be closed when the host tears the child down.
            }
        }

        // ------------------------------------------------------------ dispatch

        static object Dispatch(string method, Dictionary<string, object> parameters)
        {
            switch (method)
            {
                case "favorites/store/get":
                    return store.Data;
                case "favorites/store/replace":
                    return ReplaceStore(parameters);
                case "favorites/add":
                    return AddFavorite(parameters);
                case "favorites/remove":
                    return RemoveFavorite(parameters);
                case "favorites/move":
                    return MoveFavorite(parameters);
                case "favorites/update":
                    return UpdateFavorite(parameters);
                case "favorites/ui/toggle":
                    return ToggleUi(parameters);
                case "favorites/folder/add":
                    return AddFolder(parameters);
                case "favorites/folder/rename":
                    return RenameFolder(parameters);
                case "favorites/folder/remove":
                    return RemoveFolder(parameters);
                case "favorites/settings/update":
                    return UpdateSettings(parameters);
                case "favorites/ui/collapse-all":
                    return CollapseAll(parameters);
                case "favorites/open":
                    return OpenTable(parameters);
                case "favorites/launch-options":
                    return LaunchOptions();
                case "favorites/probe":
                    return Probe();
                case "favorites/table/describe":
                    return BridgeData("/data/describe-table", parameters);
                default:
                    throw new RpcError(-32601, "Method not found: " + method);
            }
        }

        // ---------------------------------------------------------------- store

        static object ReplaceStore(Dictionary<string, object> parameters)
        {
            var incoming = Values.AsMap(Values.Get(parameters, "data"));
            if (incoming.Count == 0) throw new RpcError(-32602, "favorites/store/replace needs data");
            store.Data = incoming;
            store.Save();
            return store.Data;
        }

        static object AddFavorite(Dictionary<string, object> parameters)
        {
            var identity = IdentityOf(parameters);
            var folderId = Values.Str(Values.Get(parameters, "folderId"), "inbox");
            var note = Values.Str(Values.Get(parameters, "note"), "");

            foreach (var existing in store.Favorites())
            {
                var stored = Values.AsMap(existing);
                if (SameIdentity(stored, identity) && Values.Str(Values.Get(stored, "folderId"), "") == folderId)
                {
                    store.Save();
                    return Values.Map("favorite", stored, "existing", true);
                }
            }

            var favorite = Values.Map(
                "id", Store.NewId("fav"),
                "folderId", folderId,
                "label", Values.Str(Values.Get(parameters, "label"), ""),
                "connectionId", identity["connectionId"],
                "connectionName", identity["connectionName"],
                "database", identity["database"],
                "schema", identity["schema"],
                "table", identity["table"],
                "note", note,
                "addedAt", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                "openCount", 0,
                "lastOpenedAt", null);
            store.Favorites().Add(favorite);
            store.Save();
            return Values.Map("favorite", favorite, "existing", false);
        }

        static object RemoveFavorite(Dictionary<string, object> parameters)
        {
            var id = Required(parameters, "id");
            var favorites = store.Favorites();
            var kept = new List<object>();
            foreach (var item in favorites)
            {
                var favorite = Values.AsMap(item);
                if (Values.Str(Values.Get(favorite, "id"), "") != id) kept.Add(item);
            }
            if (kept.Count == favorites.Count) throw new RpcError(-32004, "收藏不存在: " + id);
            store.Data["favorites"] = kept;
            store.Save();
            return Values.Map("removed", true, "count", kept.Count);
        }

        static object MoveFavorite(Dictionary<string, object> parameters)
        {
            var favorite = MustFind(Required(parameters, "id"));
            favorite["folderId"] = Values.Str(Values.Get(parameters, "folderId"), "inbox");
            store.Save();
            return Values.Map("favorite", favorite);
        }

        static object UpdateFavorite(Dictionary<string, object> parameters)
        {
            var favorite = MustFind(Required(parameters, "id"));
            var patch = Values.Str(Values.Get(parameters, "note"), null);
            if (patch != null) favorite["note"] = patch;
            var label = Values.Str(Values.Get(parameters, "label"), null);
            if (label != null) favorite["label"] = label;
            store.Save();
            return Values.Map("favorite", favorite);
        }

        static object AddFolder(Dictionary<string, object> parameters)
        {
            var name = Required(parameters, "name");
            var parentId = Values.Get(parameters, "parentId");
            var folder = Values.Map(
                "id", Store.NewId("dir"),
                "name", name,
                "parentId", string.IsNullOrEmpty(Values.Str(parentId, "")) ? null : parentId,
                "order", store.Folders().Count);
            store.Folders().Add(folder);
            store.Save();
            return Values.Map("folder", folder);
        }

        static object RenameFolder(Dictionary<string, object> parameters)
        {
            var folder = MustFindFolder(Required(parameters, "id"));
            folder["name"] = Required(parameters, "name");
            store.Save();
            return Values.Map("folder", folder);
        }

        static object RemoveFolder(Dictionary<string, object> parameters)
        {
            var id = Required(parameters, "id");
            if (id == "inbox") throw new RpcError(-32005, "内置的\"未分类\"不能删除");
            MustFindFolder(id);

            var inside = 0;
            foreach (var item in store.Favorites())
            {
                if (Values.Str(Values.Get(Values.AsMap(item), "folderId"), "") == id) inside++;
            }
            var below = 0;
            foreach (var item in store.Folders())
            {
                if (Values.Str(Values.Get(Values.AsMap(item), "parentId"), "") == id) below++;
            }
            if (inside + below > 0 && !Values.Flag(Values.Get(parameters, "force"), false))
            {
                throw new RpcError(-32006, "文件夹非空（收藏 " + inside + " 条、子文件夹 " + below + " 个），先移动或确认强制删除");
            }

            var folders = new List<object>();
            foreach (var item in store.Folders())
            {
                if (Values.Str(Values.Get(Values.AsMap(item), "id"), "") != id) folders.Add(item);
            }
            // Orphans fall back to the built-in folder rather than disappearing with the folder.
            foreach (var item in store.Favorites())
            {
                var favorite = Values.AsMap(item);
                if (Values.Str(Values.Get(favorite, "folderId"), "") == id) favorite["folderId"] = "inbox";
            }
            store.Data["folders"] = folders;
            store.Save();
            return Values.Map("removed", id, "movedToFavorites", inside);
        }

        // Expand/collapse lives in the store so the tree reopens the way it was left.
        static object ToggleUi(Dictionary<string, object> parameters)
        {
            var id = Required(parameters, "id");
            var collapse = Values.Flag(Values.Get(parameters, "collapsed"), false);
            var ui = Values.AsMap(Values.Get(store.Data, "ui"));
            var kept = new List<object>();
            foreach (var item in Values.AsList(Values.Get(ui, "collapsed")))
            {
                if (Values.Str(item, "") != id) kept.Add(item);
            }
            if (collapse) kept.Add(id);
            ui["collapsed"] = kept;
            store.Data["ui"] = ui;
            store.Save();
            return Values.Map("collapsed", kept);
        }

        // One write for "expand all / collapse all" instead of N toggles each rewriting the file.
        static object CollapseAll(Dictionary<string, object> parameters)
        {
            var collapse = Values.Flag(Values.Get(parameters, "collapsed"), false);
            var kept = new List<object>();
            if (collapse)
            {
                foreach (var item in store.Folders())
                {
                    var id = Values.Str(Values.Get(Values.AsMap(item), "id"), "");
                    if (id.Length > 0) kept.Add(id);
                }
            }
            var ui = Values.AsMap(Values.Get(store.Data, "ui"));
            ui["collapsed"] = kept;
            store.Data["ui"] = ui;
            store.Save();
            return Values.Map("collapsed", kept);
        }

        // Keys the UI is allowed to patch in bulk; unknown keys are ignored on purpose.
        static readonly HashSet<string> SettableKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "bridgePort", "bridgePortFile", "timeoutMs", "openOnAdd", "rememberLastFolder"
        };

        static object UpdateSettings(Dictionary<string, object> parameters)
        {
            var settings = store.Settings();
            var patch = Values.AsMap(Values.Get(parameters, "settings"));
            foreach (var pair in patch)
            {
                if (!SettableKeys.Contains(pair.Key)) continue;
                object value = pair.Value;
                if (pair.Key == "bridgePort")
                {
                    var port = value as double?;
                    value = port == null ? 0 : Math.Max(0, (int)Math.Round(port.Value));
                }
                else if (pair.Key == "timeoutMs")
                {
                    var ms = Values.Int(value, 6000);
                    value = Math.Min(60000, ms);
                }
                else if (pair.Key == "openOnAdd")
                {
                    value = Values.Flag(value, true);
                }
                else
                {
                    value = Values.Str(value, "");
                }
                settings[pair.Key] = value;
            }
            store.Save();
            return Values.Map("settings", settings);
        }


        static Dictionary<string, object> MustFind(string id)
        {
            var favorite = store.FindFavorite(id);
            if (favorite == null) throw new RpcError(-32004, "收藏不存在: " + id);
            return favorite;
        }

        static Dictionary<string, object> MustFindFolder(string id)
        {
            foreach (var item in store.Folders())
            {
                var folder = Values.AsMap(item);
                if (Values.Str(Values.Get(folder, "id"), "") == id) return folder;
            }
            throw new RpcError(-32007, "文件夹不存在: " + id);
        }

        // ----------------------------------------------------------------- open

        static Dictionary<string, object> IdentityOf(Dictionary<string, object> parameters)
        {
            var source = Values.Get(parameters, "identity");
            var identity = Values.AsMap(source);
            if (identity.Count == 0) identity = parameters;

            var table = Values.Str(Values.Get(identity, "table"), "");
            if (table.Length == 0) table = Values.Str(Values.Get(identity, "tableName"), "");
            if (table.Length == 0) throw new RpcError(-32602, "缺少 table");

            return Values.Map(
                "connectionId", Values.Str(Values.Get(identity, "connectionId"), ""),
                "connectionName", Values.Str(Values.Get(identity, "connectionName"), ""),
                "database", Values.Str(Values.Get(identity, "database"), ""),
                "schema", Values.Str(Values.Get(identity, "schema"), ""),
                "table", table);
        }

        static bool SameIdentity(Dictionary<string, object> left, Dictionary<string, object> right)
        {
            if (Values.Str(Values.Get(left, "table"), "") != Values.Str(Values.Get(right, "table"), "")) return false;
            if (Values.Str(Values.Get(left, "database"), "") != Values.Str(Values.Get(right, "database"), "")) return false;
            if (Values.Str(Values.Get(left, "schema"), "") != Values.Str(Values.Get(right, "schema"), "")) return false;
            // A match needs a real connection identifier on at least one side; two empty strings
            // must not collapse tables from different connections into one favorite.
            var leftId = Values.Str(Values.Get(left, "connectionId"), "");
            var rightId = Values.Str(Values.Get(right, "connectionId"), "");
            if (Values.HasText(leftId) && leftId == rightId) return true;
            var leftName = Values.Str(Values.Get(left, "connectionName"), "");
            var rightName = Values.Str(Values.Get(right, "connectionName"), "");
            return Values.HasText(leftName) && leftName == rightName;
        }

        static object OpenTable(Dictionary<string, object> parameters)
        {
            Dictionary<string, object> identity;
            var id = Values.Str(Values.Get(parameters, "id"), "");
            if (id.Length > 0)
            {
                var favorite = MustFind(id);
                identity = IdentityOf(favorite);
            }
            else
            {
                identity = IdentityOf(parameters);
            }

            var settings = Values.AsMap(Values.Get(parameters, "settings"));
            if (settings.Count == 0) settings = store.Settings();
            var attempts = TryOpen(identity, settings);

            var succeeded = Values.Str(Values.Get(FirstOk(attempts), "channel"), "");
            if (succeeded.Length > 0 && id.Length > 0)
            {
                var favorite = store.FindFavorite(id);
                if (favorite != null)
                {
                    favorite["openCount"] = Values.Int(Values.Get(favorite, "openCount"), 0) + 1;
                    favorite["lastOpenedAt"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
                    store.Save();
                }
            }
            return Values.Map("ok", succeeded.Length > 0, "channel", succeeded, "attempts", attempts, "identity", identity);
        }

        static Dictionary<string, object> FirstOk(List<object> attempts)
        {
            foreach (var item in attempts)
            {
                var attempt = Values.AsMap(item);
                if (Values.Flag(Values.Get(attempt, "ok"), false)) return attempt;
            }
            return Values.Map("channel", "");
        }

        // Only the native DBX loopback bridge is supported; the response keeps an attempts array
        // (always a single "bridge" entry) so the UI contract stays stable.
        static List<object> TryOpen(Dictionary<string, object> identity, Dictionary<string, object> settings)
        {
            var timeout = Values.Int(Values.Get(settings, "timeoutMs"), 6000);
            var attempts = new List<object>();
            var started = Stopwatch.StartNew();
            var attempt = Values.Map("channel", "bridge", "ok", false, "detail", "");
            try
            {
                string detail;
                attempt["ok"] = OpenViaBridge(identity, settings, timeout, out detail);
                attempt["detail"] = detail;
            }
            catch (Exception error)
            {
                attempt["detail"] = Bridge.Describe(error);
            }
            started.Stop();
            attempt["latencyMs"] = (int)started.ElapsedMilliseconds;
            attempts.Add(attempt);
            return attempts;
        }

        static bool OpenViaBridge(Dictionary<string, object> identity, Dictionary<string, object> settings, int timeout, out string detail)
        {
            var found = PortDiscovery.Resolve(Values.Int(Values.Get(settings, "bridgePort"), 0), Values.Str(Values.Get(settings, "bridgePortFile"), ""));
            if (found.Port <= 0)
            {
                detail = "未发现桥接端口" + (Values.HasText(found.Detail) ? "：" + found.Detail : "");
                return false;
            }
            var body = Json.Write(BridgeBody(identity));
            var reply = Bridge.Post(found.Port, "/open-table", body, timeout);
            if (reply.Ok)
            {
                detail = "端口 " + found.Port + " 返回 " + reply.Status + " " + Trim(reply.Body);
                return true;
            }
            detail = "端口 " + found.Port + " 返回 HTTP " + reply.Status + " " + Trim(reply.Body);
            return false;
        }

        // The bridge declares connection_name as a required (non-optional) string even when the
        // caller resolves by connection_id, so the field is always sent.
        static Dictionary<string, object> BridgeBody(Dictionary<string, object> identity)
        {
            return Values.Map(
                "connection_id", Values.Str(Values.Get(identity, "connectionId"), ""),
                "connection_name", Values.Str(Values.Get(identity, "connectionName"), ""),
                "database", Values.Str(Values.Get(identity, "database"), ""),
                "schema", Values.Str(Values.Get(identity, "schema"), ""),
                "table", Values.Str(Values.Get(identity, "table"), ""));
        }

        static object BridgeData(string path, Dictionary<string, object> parameters)
        {
            var identity = IdentityOf(parameters);
            var settings = store.Settings();
            var timeout = Values.Int(Values.Get(settings, "timeoutMs"), 6000);
            var found = PortDiscovery.Resolve(Values.Int(Values.Get(settings, "bridgePort"), 0), Values.Str(Values.Get(settings, "bridgePortFile"), ""));
            if (found.Port <= 0) throw new RpcError(-32008, "未发现桥接端口，无法查询表结构");

            var body = Json.Write(BridgeBody(identity));
            var reply = Bridge.Post(found.Port, path, body, timeout);
            if (!reply.Ok) throw new RpcError(-32009, path + " 返回 HTTP " + reply.Status + " " + Trim(reply.Body));

            object rows;
            try
            {
                rows = Json.Parse(reply.Body);
            }
            catch (Exception error)
            {
                throw new RpcError(-32010, path + " 响应不是 JSON：" + error.Message);
            }
            return Values.Map("rows", rows, "port", found.Port);
        }

        static object LaunchOptions()
        {
            var entries = new List<object>();
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var item in store.Folders())
            {
                var folder = Values.AsMap(item);
                names[Values.Str(Values.Get(folder, "id"), "")] = Values.Str(Values.Get(folder, "name"), "");
            }
            foreach (var item in store.Favorites())
            {
                var favorite = Values.AsMap(item);
                var table = Values.Str(Values.Get(favorite, "table"), "");
                var database = Values.Str(Values.Get(favorite, "database"), "");
                var schema = Values.Str(Values.Get(favorite, "schema"), "");
                var connection = Values.Str(Values.Get(favorite, "connectionName"), Values.Str(Values.Get(favorite, "connectionId"), ""));
                var parts = new List<string>();
                if (database.Length > 0) parts.Add(database);
                if (schema.Length > 0) parts.Add(schema);
                parts.Add(table);
                var path = string.Join(".", parts.ToArray());
                var folderId = Values.Str(Values.Get(favorite, "folderId"), "");
                var folderName = names.ContainsKey(folderId) ? names[folderId] : "未分类";
                entries.Add(Values.Map(
                    "label", Values.Str(Values.Get(favorite, "label"), table),
                    "description", connection + " · " + path + " · " + folderName,
                    "context", Values.Map("mode", "open", "favoriteId", Values.Str(Values.Get(favorite, "id"), ""))));
            }
            return Values.Map("entries", entries);
        }

        static object Probe()
        {
            var settings = store.Settings();
            var timeout = Values.Int(Values.Get(settings, "timeoutMs"), 6000);
            var found = PortDiscovery.Resolve(Values.Int(Values.Get(settings, "bridgePort"), 0), Values.Str(Values.Get(settings, "bridgePortFile"), ""));
            var bridgeAlive = found.Port > 0 && Bridge.IsAlive(found.Port, timeout);

            return Values.Map(
                "env", Values.Map(
                    "pluginId", Env("DBX_PLUGIN_ID"),
                    "pluginVersion", Env("DBX_PLUGIN_VERSION"),
                    "appVersion", Env("DBX_APP_VERSION"),
                    "hostApiVersion", Env("DBX_HOST_API_VERSION"),
                    "protocolVersion", Env("DBX_PLUGIN_PROTOCOL_VERSION"),
                    "pluginDataDir", store.FilePath,
                    "dbxDataDir", Env("DBX_DATA_DIR")),
                "bridge", Values.Map(
                    "port", found.Port,
                    "source", found.Source,
                    "detail", found.Detail,
                    "alive", bridgeAlive),
                "store", Values.Map(
                    "favorites", store.Favorites().Count,
                    "folders", store.Folders().Count,
                    "loadError", Values.Str(Values.Get(store.Data, "loadError"), "")));
        }

        // -------------------------------------------------------------- selftest

        // Verifies the protocol plumbing and both transports without a DBX window:
        //   DBX_MCP_TEST=... csc output --selftest
        static int Selftest()
        {
            var directory = Path.Combine(Path.GetTempPath(), "dbx-favorites-selftest-" + Guid.NewGuid().ToString("N").Substring(0, 6));
            store = Store.Open(directory);
            Log("selftest dir " + directory);

            var parsed = Json.Parse("{\"a\":[1,2,{\"b\":\"中文\"}],\"c\":null,\"d\":true,\"e\":1.5}");
            var roundTrip = Json.Write(parsed);
            Log("json roundtrip " + roundTrip);
            if (roundTrip.IndexOf("中文") >= 0) { Log("FAIL: 非 ASCII 未转义"); return 1; }

            store.Data["favorites"] = new List<object> { Values.Map(
                "id", "fav-1", "folderId", "inbox", "connectionId", "c", "connectionName", "n",
                "database", "d", "schema", "s", "table", "t", "note", "", "addedAt", "", "openCount", 0, "lastOpenedAt", null) };
            store.Save();
            var reloaded = Store.Open(directory);
            if (reloaded.Favorites().Count != 1) { Log("FAIL: 存储回读"); return 1; }
            if (reloaded.Folders().Count == 0) { Log("FAIL: 默认文件夹未补齐"); return 1; }

            var options = Values.AsMap(LaunchOptions());
            if (Values.AsList(Values.Get(options, "entries")).Count != 1) { Log("FAIL: launch-options"); return 1; }

            var probes = Probe();
            Log("probe " + Json.Write(probes));
            return 0;
        }

        static string Trim(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            var oneLine = text.Replace("\r", " ").Replace("\n", " ").Trim();
            return oneLine.Length <= 200 ? oneLine : oneLine.Substring(0, 200) + "…";
        }

        static string Required(Dictionary<string, object> parameters, string key)
        {
            var value = Values.Str(Values.Get(parameters, key), "");
            if (value.Length == 0) throw new RpcError(-32602, "缺少参数 " + key);
            return value;
        }
    }
}
