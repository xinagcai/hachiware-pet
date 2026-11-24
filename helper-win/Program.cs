// HachiwarePet (Windows) — the native shell for the desktop pet.
//
// The macOS helper is a Swift .app; this is its C#/WebView2 twin. Both read the
// same state files written by the plugin host (index.js) and serve the same
// pet/index.html page, so the page talks to either one through the identical
// window.pet bridge:
//
//   page -> native :  window.webkit.messageHandlers.pet.postMessage({type:...})
//   native -> page :  window.__petState(json), window.__petSkinApply({config,dataUrl})
//
// Only the window chrome is platform specific: a transparent, always-on-top
// borderless Form that gets out of the way with WS_EX_TRANSPARENT whenever the
// pointer is not over the pet or its panel.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Native
{
    public const int GwlExStyle = -20;
    public const int WsExTransparent = 0x00000020;
    public const int SwRestore = 9;

    [StructLayout(LayoutKind.Sequential)]
    public struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    /// Toggles WS_EX_TRANSPARENT so the window, or a child of it, stops taking
    /// mouse input and the click falls through to the window underneath.
    public static void SetTransparent(IntPtr hWnd, bool transparent)
    {
        if (hWnd == IntPtr.Zero) return;
        var style = GetWindowLong(hWnd, GwlExStyle);
        style = transparent ? style | WsExTransparent : style & ~WsExTransparent;
        SetWindowLong(hWnd, GwlExStyle, style);
    }
}

internal sealed class PetForm : Form
{
    private const int WindowWidth = 320;
    private const int WindowHeight = 360;

    private readonly string statePath = Env("DSH_HACHIWARE_PET_STATE");
    private readonly string posPath = Env("DSH_HACHIWARE_PET_POS");
    private readonly string logPath = Env("DSH_HACHIWARE_PET_LOG");
    private readonly string commandPath = Env("DSH_HACHIWARE_PET_COMMAND");
    private readonly string skinsPath = Env("DSH_HACHIWARE_PET_SKINS");
    private readonly string petPath = Env("DSH_HACHIWARE_PET_PETDIR");
    private readonly int parentPid = Int(Env("DSH_HACHIWARE_PET_PARENT"));
    private readonly int appPid = Int(Env("DSH_HACHIWARE_PET_APP_PID"));

    private WebView2 web = null!;
    private readonly System.Windows.Forms.Timer stateTimer = new() { Interval = 450 };
    private readonly System.Windows.Forms.Timer hoverTimer = new() { Interval = 120 };
    private readonly System.Windows.Forms.Timer parentTimer = new() { Interval = 1000 };
    private readonly System.Windows.Forms.Timer saveTimer = new() { Interval = 400 };

    private string lastState = "";
    private string injectedSkin = "";
    private bool clickThrough;
    private bool mouseDown;
    private bool ready;
    private bool pageReady;
    private Rectangle petRect;
    private Rectangle panelRect;

    public PetForm()
    {
        Text = "Hachiware pet";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(WindowWidth, WindowHeight);
        MinimumSize = MaximumSize = Size;
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        DoubleBuffered = true;
        AllowTransparency = true;
        ApplySavedPosition();
    }

    protected override bool ShowWithoutActivation => true;

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        Log("launch (parent " + parentPid + ", app " + appPid + ")");
        try
        {
            await CreateWebViewAsync();
            ready = true;
            stateTimer.Tick += (_, _) => PushState();
            hoverTimer.Tick += (_, _) => UpdateClickThrough();
            parentTimer.Tick += (_, _) => CheckParent();
            saveTimer.Tick += (_, _) => { saveTimer.Stop(); SavePosition(); };
            Move += (_, _) => { saveTimer.Stop(); saveTimer.Start(); };
            stateTimer.Start();
            hoverTimer.Start();
            parentTimer.Start();
        }
        catch (Exception error)
        {
            Log("webview failed: " + error.Message);
            Close();
        }
    }

    private async System.Threading.Tasks.Task CreateWebViewAsync()
    {
        web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Transparent };
        Controls.Add(web);
        var userData = Path.Combine(Path.GetDirectoryName(statePath) ?? Path.GetTempPath(), "webview");
        Directory.CreateDirectory(userData);
        var environment = await CoreWebView2Environment.CreateAsync(null, userData);
        await web.EnsureCoreWebView2Async(environment);
        // Keep the WebView surface click-through for its whole life: it must
        // never take the mouse, the Form forwards input into the page instead.
        Native.SetTransparent(web.Handle, true);
        web.CoreWebView2.Settings.AreDevToolsEnabled = false;
        web.CoreWebView2.Settings.IsStatusBarEnabled = false;
        web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        web.CoreWebView2.WebMessageReceived += OnWebMessage;
        await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
        web.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            Log("page finished ok=" + args.IsSuccess);
            pageReady = args.IsSuccess;
            if (!pageReady) return;
            // A fresh document knows nothing: re-send the state and the skin.
            lastState = "";
            injectedSkin = "";
            PushState();
            InjectSkin();
        };
        var page = Path.Combine(petPath, "index.html");
        web.Source = new Uri(page);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeNode)) return;
            switch (typeNode.GetString())
            {
                case "drag":
                    DragBy(root);
                    break;
                case "park":
                    Park();
                    break;
                case "focus":
                    FocusHarness();
                    break;
                case "install":
                    WriteCommand("install-skin", Str(root, "slug"));
                    Log("install: button pressed (" + Str(root, "slug") + ")");
                    break;
                case "switch":
                    WriteCommand("switch-skin", Str(root, "slug"));
                    Log("switch: " + Str(root, "slug"));
                    break;
                case "delete":
                    WriteCommand("delete-skin", Str(root, "slug"));
                    Log("delete: " + Str(root, "slug"));
                    break;
                case "new-skin":
                    WriteCommand("new-skin", null);
                    Log("new skin requested");
                    break;
                case "hitbox":
                    ReadHitbox(root);
                    break;
                case "debug":
                    Log("page debug: " + Str(root, "message"));
                    break;
            }
        }
        catch (Exception error)
        {
            Log("message failed: " + error.Message);
        }
    }

    private void DragBy(JsonElement root)
    {
        if (!root.TryGetProperty("dx", out var dxNode) || !root.TryGetProperty("dy", out var dyNode)) return;
        var scale = DeviceDpi / 96.0;
        Location = new Point(
            Location.X + (int)Math.Round(dxNode.GetDouble() * scale),
            Location.Y + (int)Math.Round(dyNode.GetDouble() * scale));
    }

    private void Park()
    {
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.Right - Width - 16, area.Bottom - Height - 16);
        Log("parked " + Location.X + "," + Location.Y);
    }

    private void FocusHarness()
    {
        foreach (var candidate in new[] { appPid, parentPid })
        {
            if (candidate <= 0) continue;
            try
            {
                using var process = Process.GetProcessById(candidate);
                var handle = process.MainWindowHandle;
                if (handle != IntPtr.Zero)
                {
                    Native.ShowWindow(handle, Native.SwRestore);
                    var raised = Native.SetForegroundWindow(handle);
                    Log("focus: " + process.ProcessName + " pid " + candidate + " raised " + raised);
                    return;
                }
            }
            catch
            {
                /* try the next candidate */
            }
        }
        foreach (var process in Process.GetProcessesByName("DeepSeek Harness"))
        {
            var handle = process.MainWindowHandle;
            if (handle == IntPtr.Zero) continue;
            Native.ShowWindow(handle, Native.SwRestore);
            Native.SetForegroundWindow(handle);
            Log("focus: DeepSeek Harness pid " + process.Id);
            return;
        }
        Log("focus: harness window not found");
    }

    private void ReadHitbox(JsonElement root)
    {
        petRect = RectOf(root, "pet");
        panelRect = RectOf(root, "panel");
    }

    private static Rectangle RectOf(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var node) || node.ValueKind != JsonValueKind.Object) return Rectangle.Empty;
        // renderer.js posts {x,y,w,h}; accept the long names too.
        int Read(string key) => node.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number
            ? (int)Math.Round(value.GetDouble())
            : 0;
        var width = node.TryGetProperty("w", out _) ? Read("w") : Read("width");
        var height = node.TryGetProperty("h", out _) ? Read("h") : Read("height");
        return new Rectangle(Read("x"), Read("y"), width, height);
    }

    private void UpdateClickThrough()
    {
        if (!ready || !IsHandleCreated || mouseDown) return;
        Native.GetWindowRect(Handle, out var windowRect);
        Native.GetCursorPos(out var cursor);
        var scale = DeviceDpi / 96.0;
        var x = (cursor.X - windowRect.Left) / scale;
        var y = (cursor.Y - windowRect.Top) / scale;
        var over = petRect.Contains((int)x, (int)y) ||
                   (!panelRect.IsEmpty && panelRect.Contains((int)x, (int)y));
        // The page cannot set the cursor while it is click-through, so the shell
        // mirrors it: a hand over the pet or the open panel, an arrow elsewhere.
        if (Cursor != (over ? Cursors.Hand : Cursors.Default)) Cursor = over ? Cursors.Hand : Cursors.Default;
        SetClickThrough(!over);
    }

    private void SetClickThrough(bool inactive)
    {
        if (clickThrough == inactive) return;
        clickThrough = inactive;
        // Only the layered parent is toggled. The WebView2 render widget keeps
        // WS_EX_TRANSPARENT for good: that flag is what makes the transparent
        // stage composite, and clearing it blanks the pet (issue #1). So the
        // WebView never receives the mouse on Windows; the Form does, and
        // forwards it into the page as synthetic events (ForwardMouse).
        Native.SetTransparent(Handle, inactive);
        if (web != null && web.IsHandleCreated) Native.SetTransparent(web.Handle, true);
    }

    private double UiScale => DeviceDpi / 96.0;

    // The page is click-through in the WebView, so every mouse message the Form
    // gets is replayed into the page. The page's handlers only need client and
    // screen coordinates, both expressed in CSS pixels like on macOS.
    private void ForwardMouse(string kind, MouseEventArgs e, int deltaY = 0)
    {
        if (!ready || !pageReady || web?.CoreWebView2 == null) return;
        var scale = UiScale;
        var cursor = Cursor.Position;
        var buttons = (e.Button & MouseButtons.Left) != 0 ? 1 : 0;
        var script = "window.__petInput && window.__petInput('" + kind + "'," +
                     Num(e.X / scale) + "," + Num(e.Y / scale) + "," +
                     Num(cursor.X / scale) + "," + Num(cursor.Y / scale) + "," +
                     buttons + "," + deltaY + ")";
        _ = web.CoreWebView2.ExecuteScriptAsync(script);
    }

    private static string Num(double value) =>
        value.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button == MouseButtons.Left)
        {
            // Capture so a fast drag keeps feeding the page even when the
            // pointer leaves the small window rectangle.
            mouseDown = true;
            Capture = true;
        }
        ForwardMouse("down", e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        ForwardMouse("move", e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (mouseDown)
        {
            mouseDown = false;
            Capture = false;
        }
        ForwardMouse("up", e);
    }

    protected override void OnMouseDoubleClick(MouseEventArgs e)
    {
        base.OnMouseDoubleClick(e);
        ForwardMouse("dbl", e);
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        ForwardMouse("wheel", e, e.Delta);
    }

    private void PushState()
    {
        if (!ready || !pageReady || web.CoreWebView2 == null) return;
        try
        {
            if (!File.Exists(statePath)) return;
            var json = File.ReadAllText(statePath, Encoding.UTF8);
            if (json.Length == 0 || json == lastState) return;
            lastState = json;
            _ = web.CoreWebView2.ExecuteScriptAsync("window.__petState && window.__petState(" + json + ")");
        }
        catch (IOException)
        {
            /* the host rewrites the file atomically; a locked read is fine to skip */
        }
        catch (Exception error)
        {
            Log("state inject failed: " + error.Message);
        }
        InjectSkin();
    }

    private void InjectSkin()
    {
        if (!ready || !pageReady || web.CoreWebView2 == null) return;
        try
        {
            var currentFile = Path.Combine(skinsPath, "current.json");
            if (!File.Exists(currentFile)) return;
            var configText = File.ReadAllText(currentFile, Encoding.UTF8);
            if (configText.Length == 0) return;
            using var document = JsonDocument.Parse(configText);
            var root = document.RootElement;
            var slug = root.TryGetProperty("slug", out var slugNode) ? slugNode.GetString() : null;
            if (string.IsNullOrEmpty(slug)) return;
            var version = root.TryGetProperty("installedAt", out var versionNode)
                ? versionNode.GetString()
                : configText;
            if (version == injectedSkin) return;
            var sheet = root.TryGetProperty("spritesheet", out var sheetNode) && sheetNode.GetString() is { Length: > 0 } name
                ? name
                : "spritesheet.webp";
            var sheetPath = Path.Combine(skinsPath, slug!, sheet);
            if (!File.Exists(sheetPath)) return;
            var mime = sheet.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "image/webp";
            var dataUrl = "data:" + mime + ";base64," + Convert.ToBase64String(File.ReadAllBytes(sheetPath));
            // No frame counts from here: inside WebView2 a data: URL image does
            // not taint the canvas, so the page measures its own rows.
            var payload = "{\"config\":" + configText + ",\"dataUrl\":\"" + dataUrl + "\"}";
            injectedSkin = version ?? configText;
            _ = web.CoreWebView2.ExecuteScriptAsync("window.__petSkinApply && window.__petSkinApply(" + payload + ")");
            Log("skin injected: " + slug);
        }
        catch (Exception error)
        {
            Log("skin inject failed: " + error.Message);
        }
    }

    private void CheckParent()
    {
        if (parentPid <= 0) return;
        try
        {
            using var process = Process.GetProcessById(parentPid);
            if (process.HasExited) Exit();
        }
        catch
        {
            Exit();
        }
    }

    private void Exit()
    {
        Log("parent gone, exiting");
        parentTimer.Stop();
        BeginInvoke(new Action(Close));
    }

    private void WriteCommand(string action, string? slug)
    {
        try
        {
            if (string.IsNullOrEmpty(commandPath))
            {
                Log("command path missing");
                return;
            }
            var json = string.IsNullOrEmpty(slug)
                ? "{\"action\":\"" + action + "\"}"
                : "{\"action\":\"" + action + "\",\"slug\":\"" + slug + "\"}";
            var temporary = commandPath + ".tmp";
            File.WriteAllText(temporary, json, Encoding.UTF8);
            File.Move(temporary, commandPath, true);
        }
        catch (Exception error)
        {
            Log("command write failed: " + error.Message);
        }
    }

    private void ApplySavedPosition()
    {
        try
        {
            if (!string.IsNullOrEmpty(posPath) && File.Exists(posPath))
            {
                using var document = JsonDocument.Parse(File.ReadAllText(posPath, Encoding.UTF8));
                var x = document.RootElement.GetProperty("x").GetInt32();
                var y = document.RootElement.GetProperty("y").GetInt32();
                var bounds = Screen.FromPoint(new Point(x + 60, y + 60)).WorkingArea;
                Location = new Point(
                    Math.Max(bounds.Left - 96, Math.Min(x, bounds.Right - 96)),
                    Math.Max(bounds.Top - 96, Math.Min(y, bounds.Bottom - 96)));
                return;
            }
        }
        catch
        {
            /* fall through to the parked position */
        }
        var area = Screen.PrimaryScreen!.WorkingArea;
        Location = new Point(area.Right - WindowWidth - 16, area.Bottom - WindowHeight - 16);
    }

    private void SavePosition()
    {
        try
        {
            if (string.IsNullOrEmpty(posPath)) return;
            File.WriteAllText(posPath, "{\"x\":" + Location.X + ",\"y\":" + Location.Y + "}", Encoding.UTF8);
        }
        catch (Exception error)
        {
            Log("position save failed: " + error.Message);
        }
    }

    private void Log(string message)
    {
        if (string.IsNullOrEmpty(logPath)) return;
        try
        {
            File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ssZ") + " " + message + Environment.NewLine, Encoding.UTF8);
        }
        catch
        {
            /* logging must never take the pet down */
        }
    }

    private static string Env(string name) => Environment.GetEnvironmentVariable(name) ?? "";

    private static int Int(string value) => int.TryParse(value, out var parsed) ? parsed : 0;

    private static string Str(JsonElement root, string name) =>
        root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.String ? node.GetString()! : "";

    // Mirrors the Swift user script: the page only knows window.webkit /
    // window.pet, so WebView2 gets the same shape on top of postMessage.
    private const string BridgeScript = """
(function () {
  const post = function (message) {
    try { window.chrome.webview.postMessage(message); } catch (error) { /* host gone */ }
  };
  window.webkit = window.webkit || { messageHandlers: {} };
  window.webkit.messageHandlers.pet = { postMessage: post };
  window.pet = {
    onState: function (callback) { window.__petState = callback; },
    drag: function (delta) { post({ type: 'drag', dx: delta.dx, dy: delta.dy }); },
    park: function () { post({ type: 'park' }); },
    interactive: function () {},
    focusHarness: function () { post({ type: 'focus' }); },
    install: function (slug) { post({ type: 'install', slug: slug || '' }); },
    switchSkin: function (slug) { post({ type: 'switch', slug: slug || '' }); },
    deleteSkin: function (slug) { post({ type: 'delete', slug: slug || '' }); },
    newSkin: function () { post({ type: 'new-skin' }); }
  };
  window.addEventListener('error', function (event) {
    try { post({ type: 'debug', message: String(event.message) }); } catch (ignored) {}
  });
})();
""";
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PetForm());
    }
}
