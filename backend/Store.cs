// Favorites, folders and channel settings live in the sidecar's own data directory so the
// command-palette launcher can read them without a UI window, and so the store is not capped by
// the 1 MiB host.storage quota.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace DbxFavorites
{
    sealed class Store
    {
        public string FilePath = "";
        public Dictionary<string, object> Data;

        static readonly Dictionary<string, object> DefaultSettings = Values.Map(
            "bridgePort", 0,
            "bridgePortFile", "",
            "timeoutMs", 6000,
            "openOnAdd", true,
            "rememberLastFolder", "");

        // Settings removed when the MCP channel was dropped; mcpToken in particular was plaintext.
        static readonly HashSet<string> ObsoleteSettings = new HashSet<string>(StringComparer.Ordinal)
        {
            "channel", "mcpUrl", "mcpToken"
        };

        public static Store Open(string directory)
        {
            var store = new Store();
            store.FilePath = Path.Combine(directory, "favorites-store.json");
            store.Data = Defaults();
            if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
            if (!File.Exists(store.FilePath)) return store;
            try
            {
                var loaded = Values.AsMap(Json.Parse(File.ReadAllText(store.FilePath, Encoding.UTF8)));
                MergeOnto(store.Data, loaded);
            }
            catch (Exception error)
            {
                // Keep the unreadable file for forensics instead of letting the first Save()
                // silently destroy whatever favorites it held.
                store.Data = Defaults();
                store.Data["loadError"] = error.Message;
                try
                {
                    var backup = store.FilePath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
                    File.Copy(store.FilePath, backup, true);
                    store.Data["loadErrorBackup"] = backup;
                }
                catch
                {
                    // Best-effort backup; never block startup on it.
                }
            }
            return store;
        }

        static Dictionary<string, object> Defaults()
        {
            return Values.Map(
                "version", 1,
                "folders", new List<object> { Values.Map("id", "inbox", "name", "未分类", "parentId", null, "order", 0) },
                "favorites", new List<object>(),
                "settings", Clone(DefaultSettings),
                "ui", Values.Map("collapsed", new List<object>()));
        }

        static Dictionary<string, object> Clone(Dictionary<string, object> source)
        {
            var copy = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var pair in source) copy[pair.Key] = pair.Value;
            return copy;
        }

        // Missing keys keep their defaults; a stored settings object may predate newer keys.
        // Wrong-typed collections are dropped (not silently wiped to empty on the next Save), and
        // settings retired from the product are purged so an old plaintext token does not linger.
        static void MergeOnto(Dictionary<string, object> target, Dictionary<string, object> source)
        {
            foreach (var pair in source)
            {
                if (pair.Key == "settings")
                {
                    var settings = Clone(DefaultSettings);
                    foreach (var entry in Values.AsMap(pair.Value))
                    {
                        if (ObsoleteSettings.Contains(entry.Key)) continue;
                        settings[entry.Key] = entry.Value;
                    }
                    target["settings"] = settings;
                    continue;
                }
                if ((pair.Key == "favorites" || pair.Key == "folders") && !(pair.Value is List<object>)) continue;
                if (pair.Key == "ui" && !(pair.Value is Dictionary<string, object>)) continue;
                target[pair.Key] = pair.Value;
            }
        }

        public Dictionary<string, object> Settings()
        {
            return Values.AsMap(Values.Get(Data, "settings"));
        }

        public List<object> Folders()
        {
            return Values.AsList(Values.Get(Data, "folders"));
        }

        public List<object> Favorites()
        {
            return Values.AsList(Values.Get(Data, "favorites"));
        }

        // Atomic on Windows: temp file in the same directory, then File.Replace swaps it in place
        // without a window where the real file is missing (the old Delete+Move sequence lost the
        // whole store if the process died between the two calls).
        public void Save()
        {
            var temporary = FilePath + ".tmp";
            File.WriteAllText(temporary, Json.Write(Data), new UTF8Encoding(false));
            if (File.Exists(FilePath))
            {
                try
                {
                    File.Replace(temporary, FilePath, null);
                }
                catch
                {
                    // File.Replace can reject unusual file states (hidden/readonly, AV locks); the
                    // delete-then-move fallback is still safer than not saving at all.
                    File.Delete(FilePath);
                    File.Move(temporary, FilePath);
                }
            }
            else
            {
                File.Move(temporary, FilePath);
            }
        }

        public Dictionary<string, object> FindFavorite(string id)
        {
            foreach (var item in Favorites())
            {
                var favorite = Values.AsMap(item);
                if (Values.Str(Values.Get(favorite, "id"), "") == id) return favorite;
            }
            return null;
        }

        public static string NewId(string prefix)
        {
            return prefix + "-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) +
                   "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        }
    }
}
