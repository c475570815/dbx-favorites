// DBX Table Favorites — native sidecar.
// Speaks Sidecar Protocol v1 (JSONL over stdio) and drives DBX's loopback MCP bridge
// to reopen tables in the native table view.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace DbxFavorites
{
    // ---------------------------------------------------------------- JSON

    static class Json
    {
        public static string Write(object value)
        {
            var builder = new StringBuilder();
            WriteValue(builder, value);
            return builder.ToString();
        }

        static void WriteValue(StringBuilder builder, object value)
        {
            if (value == null)
            {
                builder.Append("null");
                return;
            }
            if (value is bool)
            {
                builder.Append((bool)value ? "true" : "false");
                return;
            }
            if (value is string)
            {
                WriteString(builder, (string)value);
                return;
            }
            if (value is double)
            {
                var number = (double)value;
                if (!double.IsNaN(number) && !double.IsInfinity(number) && number == Math.Floor(number) && Math.Abs(number) < 9.007199254740992E15)
                {
                    builder.Append(((long)number).ToString(CultureInfo.InvariantCulture));
                    return;
                }
                builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (value is long)
            {
                builder.Append(((long)value).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is int)
            {
                builder.Append(((int)value).ToString(CultureInfo.InvariantCulture));
                return;
            }
            var dictionary = value as IDictionary<string, object>;
            if (dictionary != null)
            {
                builder.Append('{');
                var first = true;
                foreach (var pair in dictionary)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    WriteString(builder, pair.Key);
                    builder.Append(':');
                    WriteValue(builder, pair.Value);
                }
                builder.Append('}');
                return;
            }
            var items = value as IEnumerable<object>;
            if (items != null)
            {
                builder.Append('[');
                var first = true;
                foreach (var item in items)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    WriteValue(builder, item);
                }
                builder.Append(']');
                return;
            }
            WriteString(builder, value.ToString());
        }

        // Non-ASCII is escaped so every protocol line is pure ASCII, which keeps the host
        // decoder independent of the console code page.
        static void WriteString(StringBuilder builder, string text)
        {
            builder.Append('"');
            foreach (var character in text)
            {
                if (character == '"' || character == '\\')
                {
                    builder.Append('\\').Append(character);
                }
                else if (character == '\b') builder.Append("\\b");
                else if (character == '\f') builder.Append("\\f");
                else if (character == '\n') builder.Append("\\n");
                else if (character == '\r') builder.Append("\\r");
                else if (character == '\t') builder.Append("\\t");
                else if (character < ' ')
                {
                    builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                }
                else if (character > '~')
                {
                    builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                }
                else builder.Append(character);
            }
            builder.Append('"');
        }

        public static object Parse(string text)
        {
            var reader = new JsonReader(text);
            reader.SkipWhitespace();
            var value = reader.readValue();
            reader.SkipWhitespace();
            if (!reader.AtEnd) throw new FormatException("Unexpected trailing characters in JSON");
            return value;
        }

        sealed class JsonReader
        {
            readonly string text;
            int index;

            public JsonReader(string text)
            {
                this.text = text;
            }

            public bool AtEnd
            {
                get { return index >= text.Length; }
            }

            public void SkipWhitespace()
            {
                while (index < text.Length && (text[index] == ' ' || text[index] == '\t' || text[index] == '\n' || text[index] == '\r')) index++;
            }

            public object readValue()
            {
                SkipWhitespace();
                if (AtEnd) throw new FormatException("Unexpected end of JSON");
                var head = text[index];
                switch (head)
                {
                    case '{': return ReadObject();
                    case '[': return ReadArray();
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default: return ReadNumber();
                }
            }

            void Expect(string literal)
            {
                if (index + literal.Length > text.Length || text.Substring(index, literal.Length) != literal)
                    throw new FormatException("Expected " + literal);
                index += literal.Length;
            }

            Dictionary<string, object> ReadObject()
            {
                var result = new Dictionary<string, object>(StringComparer.Ordinal);
                index++; // {
                SkipWhitespace();
                if (!AtEnd && text[index] == '}')
                {
                    index++;
                    return result;
                }
                while (true)
                {
                    SkipWhitespace();
                    var key = ReadString();
                    SkipWhitespace();
                    if (AtEnd || text[index] != ':') throw new FormatException("Expected : in JSON object");
                    index++;
                    result[key] = readValue();
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("Unterminated JSON object");
                    if (text[index] == ',')
                    {
                        index++;
                        continue;
                    }
                    if (text[index] == '}')
                    {
                        index++;
                        return result;
                    }
                    throw new FormatException("Expected , or } in JSON object");
                }
            }

            List<object> ReadArray()
            {
                var result = new List<object>();
                index++; // [
                SkipWhitespace();
                if (!AtEnd && text[index] == ']')
                {
                    index++;
                    return result;
                }
                while (true)
                {
                    result.Add(readValue());
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("Unterminated JSON array");
                    if (text[index] == ',')
                    {
                        index++;
                        continue;
                    }
                    if (text[index] == ']')
                    {
                        index++;
                        return result;
                    }
                    throw new FormatException("Expected , or ] in JSON array");
                }
            }

            string ReadString()
            {
                if (AtEnd || text[index] != '"') throw new FormatException("Expected string in JSON");
                index++;
                var builder = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw new FormatException("Unterminated JSON string");
                    var character = text[index++];
                    if (character == '"') return builder.ToString();
                    if (character != '\\')
                    {
                        builder.Append(character);
                        continue;
                    }
                    if (AtEnd) throw new FormatException("Unterminated escape in JSON string");
                    var escape = text[index++];
                    switch (escape)
                    {
                        case '"': builder.Append('"'); break;
                        case '\\': builder.Append('\\'); break;
                        case '/': builder.Append('/'); break;
                        case 'b': builder.Append('\b'); break;
                        case 'f': builder.Append('\f'); break;
                        case 'n': builder.Append('\n'); break;
                        case 'r': builder.Append('\r'); break;
                        case 't': builder.Append('\t'); break;
                        case 'u':
                            if (index + 4 > text.Length) throw new FormatException("Truncated \\u escape");
                            builder.Append((char)int.Parse(text.Substring(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            index += 4;
                            break;
                        default: throw new FormatException("Invalid escape in JSON string");
                    }
                }
            }

            double ReadNumber()
            {
                var start = index;
                if (!AtEnd && (text[index] == '-' || text[index] == '+')) index++;
                while (!AtEnd && (char.IsDigit(text[index]) || text[index] == '.' || text[index] == 'e' || text[index] == 'E' || text[index] == '-' || text[index] == '+')) index++;
                var slice = text.Substring(start, index - start);
                double parsed;
                if (!double.TryParse(slice, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
                    throw new FormatException("Invalid JSON number: " + slice);
                return parsed;
            }
        }
    }

    // ------------------------------------------------------------ utilities

    static class Values
    {
        public static Dictionary<string, object> Map(params object[] pairs)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            for (var i = 0; i + 1 < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1];
            return result;
        }

        public static string Str(object value, string fallback)
        {
            var text = value as string;
            return string.IsNullOrEmpty(text) ? fallback : text;
        }

        public static int Int(object value, int fallback)
        {
            var number = value as double?;
            if (number == null) return fallback;
            var rounded = (int)Math.Round(number.Value);
            return rounded <= 0 ? fallback : rounded;
        }

        public static bool Flag(object value, bool fallback)
        {
            var flag = value as bool?;
            return flag == null ? fallback : flag.Value;
        }

        public static bool HasText(string text)
        {
            return !string.IsNullOrEmpty(text) && text.Trim().Length > 0;
        }

        public static object Get(Dictionary<string, object> source, string key)
        {
            if (source == null) return null;
            object value;
            return source.TryGetValue(key, out value) ? value : null;
        }

        public static Dictionary<string, object> AsMap(object value)
        {
            var map = value as Dictionary<string, object>;
            return map ?? new Dictionary<string, object>(StringComparer.Ordinal);
        }

        public static List<object> AsList(object value)
        {
            var list = value as List<object>;
            return list ?? new List<object>();
        }
    }

    // ------------------------------------------------------------- JSON-RPC

    sealed class RpcError : Exception
    {
        public readonly int Code;

        public RpcError(int code, string message) : base(message)
        {
            Code = code;
        }
    }
}
