// Loopback transports used to reopen tables inside the running DBX desktop app.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace DbxFavorites
{
    sealed class HttpReply
    {
        public int Status;
        public string Body = "";
        public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public bool Ok
        {
            get { return Status >= 200 && Status < 300; }
        }

        public string Header(string name)
        {
            string value;
            return Headers.TryGetValue(name, out value) ? value : null;
        }
    }

    // DBX's MCP bridge (src-tauri/src/commands/mcp_bridge.rs) reads the request headers and then
    // issues one more read before routing, so a keep-alive client that only sends Content-Length
    // bytes makes it wait forever. Half-closing after the body is what unblocks it; curl and
    // reqwest do not do this, which is why MCP UI tools hang on the desktop side.
    static class Bridge
    {
        public static HttpReply Post(int port, string path, string body, int timeoutMs)
        {
            var payload = Encoding.UTF8.GetBytes(body);
            var head = new StringBuilder();
            head.Append("POST ").Append(path).Append(" HTTP/1.1\r\n");
            head.Append("Host: 127.0.0.1:").Append(port.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            head.Append("Content-Type: application/json\r\n");
            head.Append("Content-Length: ").Append(payload.Length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            // Ask the server to close after responding so a body without Content-Length can be read
            // to EOF instead of hanging on a kept-alive socket.
            head.Append("Connection: close\r\n");
            head.Append("\r\n");
            var headBytes = Encoding.ASCII.GetBytes(head.ToString());

            using (var client = new TcpClient())
            {
                client.SendTimeout = timeoutMs;
                client.ReceiveTimeout = timeoutMs;
                client.Connect(IPAddress.Loopback, port);
                using (var stream = client.GetStream())
                {
                    stream.Write(headBytes, 0, headBytes.Length);
                    stream.Write(payload, 0, payload.Length);
                    stream.Flush();
                    client.Client.Shutdown(SocketShutdown.Send);
                    return ReadResponse(stream);
                }
            }
        }

        const int MaxResponseBytes = 33554432;

        static HttpReply ReadResponse(Stream stream)
        {
            var buffer = new byte[16384];
            var all = new MemoryStream();
            int separator = -1;
            // End of the region already searched for the header terminator; rescanning only the
            // last few bytes plus new data keeps this O(n) for large table-list responses.
            var scanned = 0;
            while (separator < 0)
            {
                var read = stream.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                all.Write(buffer, 0, read);
                if (all.Length > MaxResponseBytes) throw new IOException("Bridge response is larger than 32 MiB");
                var buffered = all.GetBuffer();
                var length = (int)all.Length;
                var from = Math.Max(0, scanned - 3);
                for (var i = from; i + 3 < length; i++)
                {
                    if (buffered[i] == 13 && buffered[i + 1] == 10 && buffered[i + 2] == 13 && buffered[i + 3] == 10)
                    {
                        separator = i;
                        break;
                    }
                }
                scanned = length;
            }

            var reply = new HttpReply();
            if (separator < 0)
            {
                reply.Status = 0;
                reply.Body = Encoding.UTF8.GetString(all.ToArray());
                return reply;
            }

            var headerBytes = all.GetBuffer();
            var headerText = Encoding.ASCII.GetString(headerBytes, 0, separator);
            var lines = headerText.Split('\n');
            var statusLine = lines.Length > 0 ? lines[0].Trim() : "";
            var parts = statusLine.Split(' ');
            if (parts.Length > 1) int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out reply.Status);
            for (var i = 1; i < lines.Length; i++)
            {
                var line = lines[i].Trim('\r', ' ', '\t');
                var colon = line.IndexOf(':');
                if (colon > 0) reply.Headers[line.Substring(0, colon).Trim()] = line.Substring(colon + 1).Trim();
            }

            var body = ReadBody(stream, all, separator + 4, buffer, reply.Header("Content-Length"), reply.Header("Transfer-Encoding"));
            reply.Body = Encoding.UTF8.GetString(body);
            return reply;
        }

        // Reads the full body: exact bytes for Content-Length, de-chunked for chunked TE, and
        // until server close otherwise. Stopping at the header terminator truncated responses
        // larger than one TCP segment (thousands of tables in /data/list-tables).
        static byte[] ReadBody(Stream stream, MemoryStream all, int bodyStart, byte[] buffer, string contentLength, string transferEncoding)
        {
            var chunked = transferEncoding != null && transferEncoding.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0;
            int length;
            if (contentLength != null && int.TryParse(contentLength.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out length) && length >= 0)
            {
                while (all.Length - bodyStart < length)
                {
                    var read = stream.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                    all.Write(buffer, 0, read);
                    if (all.Length > MaxResponseBytes) throw new IOException("Bridge response is larger than 32 MiB");
                }
                var take = Math.Min(length, (int)all.Length - bodyStart);
                var exact = new byte[take];
                Buffer.BlockCopy(all.GetBuffer(), bodyStart, exact, 0, take);
                return exact;
            }

            while (true)
            {
                var read = stream.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                all.Write(buffer, 0, read);
                if (all.Length > MaxResponseBytes) throw new IOException("Bridge response is larger than 32 MiB");
            }
            var raw = all.ToArray();
            bodyStart = Math.Min(bodyStart, raw.Length);
            return chunked ? Dechunk(raw, bodyStart) : Slice(raw, bodyStart, raw.Length - bodyStart);
        }

        static byte[] Slice(byte[] source, int start, int count)
        {
            var result = new byte[count];
            Buffer.BlockCopy(source, start, result, 0, count);
            return result;
        }

        static int IndexOfBytes(byte[] source, int start, byte[] pattern)
        {
            for (var i = start; i + pattern.Length <= source.Length; i++)
            {
                var match = true;
                for (var j = 0; j < pattern.Length; j++)
                {
                    if (source[i + j] != pattern[j]) { match = false; break; }
                }
                if (match) return i;
            }
            return -1;
        }

        // Minimal HTTP/1.1 chunked decoder: <hex size>;ext CRLF, chunk, CRLF, ..., 0-size trailer.
        static byte[] Dechunk(byte[] raw, int start)
        {
            var crlf = new byte[] { 13, 10 };
            var output = new MemoryStream();
            var pos = start;
            while (pos < raw.Length)
            {
                var lineEnd = IndexOfBytes(raw, pos, crlf);
                if (lineEnd < 0) break;
                var sizeText = Encoding.ASCII.GetString(raw, pos, lineEnd - pos).Split(';')[0].Trim();
                int size;
                if (!int.TryParse(sizeText, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out size)) break;
                pos = lineEnd + 2;
                if (size == 0) break;
                var available = Math.Min(size, raw.Length - pos);
                if (available > 0) output.Write(raw, pos, available);
                pos += size + 2; // chunk data plus its trailing CRLF
            }
            return output.ToArray();
        }

        // A path the bridge does not know answers 404 as soon as the request is parsed, which makes
        // it a side-effect-free liveness probe.
        public static bool IsAlive(int port, int timeoutMs)
        {
            try
            {
                var reply = Post(port, "/dbx-favorites-probe", "{}", timeoutMs);
                return reply.Status == 404 || reply.Ok;
            }
            catch
            {
                return false;
            }
        }

        public static string Describe(Exception error)
        {
            if (error == null) return "unknown error";
            if (error is SocketException)
            {
                var socket = (SocketException)error;
                return "socket " + socket.SocketErrorCode + " (" + socket.Message + ")";
            }
            if (error is IOException) return "io " + error.Message;
            return error.GetType().Name + ": " + error.Message;
        }
    }

    static class PortDiscovery
    {
        public sealed class Found
        {
            public int Port;
            public string Source = "";
            public string Detail = "";
        }

        public static Found Resolve(int overridePort, string overrideFile)
        {
            var result = new Found();
            if (overridePort > 0)
            {
                result.Port = overridePort;
                result.Source = "settings";
                return result;
            }
            var candidates = new List<string>();
            if (Values.HasText(overrideFile)) candidates.Add(overrideFile.Trim());
            var fromEnv = Environment.GetEnvironmentVariable("DBX_DATA_DIR");
            if (Values.HasText(fromEnv)) candidates.Add(Path.Combine(fromEnv, "mcp-bridge-port"));
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            if (Values.HasText(appData)) candidates.Add(Path.Combine(appData, Path.Combine("com.dbx.app", "mcp-bridge-port")));

            foreach (var candidate in candidates)
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    int port;
                    if (!int.TryParse(File.ReadAllText(candidate).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out port) || port <= 0)
                    {
                        result.Detail = candidate + " 内容不是端口号";
                        continue;
                    }
                    result.Port = port;
                    result.Source = candidate;
                    return result;
                }
                catch (Exception error)
                {
                    result.Detail = candidate + ": " + error.Message;
                }
            }
            return result;
        }
    }
}
