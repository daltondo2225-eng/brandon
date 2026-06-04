using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Patterns;
using FlaUI.UIA3;

// BrandonCaptions: reads text out of Windows 11's Live Captions overlay via UI Automation
// and emits NDJSON deltas on stdout. Designed to be spawned by Brandon's Electron main process.
//
// Output protocol (one JSON object per line, stdout):
//   {"type":"status","captionsRunning":true|false,"hint":"..."}
//   {"type":"delta","text":"appended chunk","full":"current full text"}
//   {"type":"error","message":"..."}
//
// Reading logic adapted from LCCopier_C/LiveCaption.cpp:
//   1. Walk the UIA tree; the first descendant exposing the TextPattern returns
//      the entire caption string via TextPattern.DocumentRange.GetText(-1).
//      This sidesteps the longest-Name guessing and the duplication that arises
//      when UIA propagates Name properties up the element tree.
//   2. History merge uses suffix-pattern anchoring (UpdateCaptionHistory in
//      LCCopier): take a 20-char window from the end of the previous read, find
//      it in the current read, splice. The prefix of the cumulative history
//      never mutates, so consumer-side mark-points stay valid forever.

internal static class Program
{
    private const string LiveCaptionsClass = "LiveCaptionsDesktopWindow";
    private const int PollIntervalMs = 300;
    // The 20-char anchor window length is what LCCopier uses; long enough to be
    // statistically unique inside a caption sentence, short enough that the LC
    // engine rarely rewrites more than that at once.
    private const int AnchorPatternLen = 20;
    // Scan window: how far back from the end of the previous read we are
    // willing to shift the 20-char anchor before giving up. 200 covers normal
    // tail-revision; beyond that we fall back to a clean append.
    private const int AnchorScanMax = 200;

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };
    private static readonly object StdoutLock = new();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowExW(IntPtr hWndParent, IntPtr hWndChildAfter, string? lpszClass, string? lpszWindow);

    // We can't make Microsoft's Live Captions window invisible to screen-share
    // from another process — SetWindowDisplayAffinity requires owning the window.
    // Instead, park it far off-screen. The window keeps running and the UIA text
    // stream we read from it is unaffected; the user reads the captions from
    // Brandon's own overlay strip (which is properly cloaked).
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);

    private const int OFFSCREEN_X = -32000;
    private const int OFFSCREEN_Y = -32000;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    private static IntPtr FindLiveCaptionsHwnd() => FindWindowExW(IntPtr.Zero, IntPtr.Zero, LiveCaptionsClass, null);

    private static void Emit(object payload)
    {
        var line = JsonSerializer.Serialize(payload, JsonOpts);
        lock (StdoutLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        try { RunLoop(); }
        catch (Exception ex)
        {
            Emit(new { type = "error", message = ex.Message });
            Environment.Exit(1);
        }
    }

    private static void RunLoop()
    {
        using var automation = new UIA3Automation();

        IntPtr hwnd = IntPtr.Zero;
        AutomationElement? captionsWindow = null;
        string previousRead = string.Empty;   // last full text we saw from LC (sliding window)
        string history = string.Empty;        // cumulative, monotonic transcript we emit
        DateTime nextWindowScan = DateTime.MinValue;
        bool reportedMissing = false;
        IntPtr parkedHwnd = IntPtr.Zero;      // the LC window we've already moved off-screen
        // Opt-in: set BRANDON_PARK_LC=1 to move Live Captions far off-screen so it's
        // hidden from both user and screen-share. Default off — most users want LC
        // visible so they can interact with it.
        bool parkOffscreen = Environment.GetEnvironmentVariable("BRANDON_PARK_LC") == "1";

        while (true)
        {
            try
            {
                if (hwnd == IntPtr.Zero || captionsWindow == null)
                {
                    if (DateTime.UtcNow >= nextWindowScan)
                    {
                        nextWindowScan = DateTime.UtcNow.AddSeconds(1);
                        hwnd = FindLiveCaptionsHwnd();
                        if (hwnd == IntPtr.Zero)
                        {
                            if (!reportedMissing)
                            {
                                Emit(new
                                {
                                    type = "status",
                                    captionsRunning = false,
                                    hint = "Press Win+Ctrl+L to start Windows Live Captions.",
                                });
                                reportedMissing = true;
                            }
                            Thread.Sleep(500);
                            continue;
                        }
                        captionsWindow = automation.FromHandle(hwnd);
                        reportedMissing = false;
                        // OPT-IN parking: only move LC off-screen if the user explicitly
                        // set BRANDON_PARK_LC=1 in the env. Default (no env var) leaves
                        // LC visible so the user can interact with it (toggle on/off,
                        // resize, etc.). Brandon's own caption strip is always cloaked
                        // from screen-share regardless.
                        if (parkOffscreen && parkedHwnd != hwnd)
                        {
                            try
                            {
                                SetWindowPos(hwnd, IntPtr.Zero, OFFSCREEN_X, OFFSCREEN_Y, 0, 0,
                                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                            }
                            catch { /* non-fatal */ }
                            parkedHwnd = hwnd;
                        }
                        Emit(new { type = "status", captionsRunning = true, hint = (string?)null });
                    }
                    else { Thread.Sleep(200); continue; }
                }

                if (FindLiveCaptionsHwnd() != hwnd)
                {
                    hwnd = IntPtr.Zero;
                    captionsWindow = null;
                    continue;
                }

                string current = ReadCaptionText(captionsWindow!);
                if (!string.IsNullOrEmpty(current) && current != previousRead)
                {
                    string mergedHistory = MergeHistory(history, previousRead, current);
                    if (mergedHistory.Length > history.Length || mergedHistory != history)
                    {
                        // Compute the appended slice so consumers that care about
                        // incremental updates have it; for the renderer we mostly
                        // rely on `full` because the merge can also splice tail-revisions.
                        string delta = mergedHistory.Length > history.Length
                            ? mergedHistory.Substring(history.Length)
                            : string.Empty;
                        history = mergedHistory;
                        Emit(new { type = "delta", text = delta, full = history });
                    }
                    previousRead = current;
                }

                Thread.Sleep(PollIntervalMs);
            }
            catch (Exception)
            {
                // Transient UIA failure — re-find the window next loop without
                // clearing previousRead/history so the merge stays anchored.
                hwnd = IntPtr.Zero;
                captionsWindow = null;
                Thread.Sleep(PollIntervalMs);
            }
        }
    }

    /// <summary>
    /// LCCopier's <c>CollectTextFromElement</c>: walk the UIA tree depth-first,
    /// return the text of the first descendant that exposes the TextPattern
    /// document range. Falls back to concatenating Name properties (skipping
    /// UI chrome labels) when no element exposes TextPattern.
    /// </summary>
    private static string ReadCaptionText(AutomationElement root)
    {
        // First pass: look for an element with TextPattern.
        string? viaTextPattern = TryReadViaTextPattern(root);
        if (!string.IsNullOrEmpty(viaTextPattern)) return viaTextPattern!;

        // Fallback: walk and collect Name properties from text-bearing controls,
        // skipping known chrome labels. This mirrors LCCopier's secondary path.
        var sb = new StringBuilder();
        var stack = new Stack<AutomationElement>();
        stack.Push(root);
        int visited = 0;
        while (stack.Count > 0 && visited < 256)
        {
            visited++;
            var node = stack.Pop();
            try
            {
                if (node.ControlType == ControlType.Text ||
                    node.ControlType == ControlType.Document ||
                    node.ControlType == ControlType.Edit)
                {
                    string name = node.Name ?? string.Empty;
                    if (!IsUiChrome(name))
                    {
                        if (sb.Length > 0) sb.Append("\r\n");
                        sb.Append(name);
                    }
                }
                foreach (var child in node.FindAllChildren()) stack.Push(child);
            }
            catch { /* stale elements during a UIA update — skip */ }
        }
        return sb.ToString();
    }

    private static string? TryReadViaTextPattern(AutomationElement root)
    {
        // Depth-first; return as soon as we find a non-chrome text-pattern string.
        var stack = new Stack<AutomationElement>();
        stack.Push(root);
        int visited = 0;
        while (stack.Count > 0 && visited < 256)
        {
            visited++;
            var node = stack.Pop();
            try
            {
                ITextPattern? text = null;
                try { text = node.Patterns.Text.PatternOrDefault; } catch { text = null; }
                if (text != null)
                {
                    var range = text.DocumentRange;
                    string candidate = range.GetText(-1) ?? string.Empty;
                    if (!string.IsNullOrEmpty(candidate) && !IsUiChrome(candidate))
                    {
                        return candidate;
                    }
                }
                // Push children (reverse so siblings are visited left-to-right via Stack).
                var children = node.FindAllChildren();
                for (int i = children.Length - 1; i >= 0; i--) stack.Push(children[i]);
            }
            catch { /* skip stale element */ }
        }
        return null;
    }

    private static bool IsUiChrome(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return true;
        string lower = s.ToLowerInvariant().Trim();
        if (lower.Contains("live caption")) return true;
        if (lower == "settings" || lower == "position" || lower == "preferences") return true;
        if (lower.Contains("caption style")) return true;
        // Short generic "edit" / "editN" labels — control names, not caption text.
        if (lower.StartsWith("edit") && lower.Length <= 5) return true;
        return false;
    }

    /// <summary>
    /// Port of LCCopier's <c>UpdateCaptionHistory</c>. Splices new content into
    /// the accumulated history at the position of a 20-char anchor pulled from
    /// the end of the previous read.
    ///
    /// Invariant: characters BEFORE the splice point in <paramref name="history"/>
    /// are never mutated — so external character offsets (like the overlay's
    /// click-to-mark position) stay valid.
    /// </summary>
    private static string MergeHistory(string history, string previousRead, string currentRead)
    {
        if (string.IsNullOrEmpty(previousRead)) return currentRead;
        if (currentRead == previousRead) return history;

        int prevLen = previousRead.Length;
        int currLen = currentRead.Length;

        // LC shrank — likely a UI flicker / re-render. Don't touch history.
        if (currLen < prevLen) return history;
        // Tiny delta (≤1 char appended): nothing meaningful changed yet.
        if (currLen <= prevLen + 1) return history;
        // Previous read is too short to anchor against — reset.
        if (prevLen < AnchorPatternLen) return currentRead;

        string currentLower = currentRead.ToLowerInvariant();

        // Try anchor windows from the very end of previousRead, shifting backward
        // up to AnchorScanMax positions. The first one that appears in currentRead
        // identifies where the new content starts.
        int maxShift = Math.Min(prevLen - AnchorPatternLen, AnchorScanMax);
        for (int shift = 0; shift <= maxShift; shift++)
        {
            int endPos = prevLen - shift;
            int startPos = endPos - AnchorPatternLen;
            string pattern = previousRead.Substring(startPos, AnchorPatternLen);
            string patternLower = pattern.ToLowerInvariant();

            int posInCurrent = currentLower.LastIndexOf(patternLower, StringComparison.Ordinal);
            if (posInCurrent < 0) continue;

            string newPart = currentRead.Substring(posInCurrent); // includes the pattern itself
            int posInHistory = history.LastIndexOf(pattern, StringComparison.Ordinal);
            if (posInHistory >= 0)
            {
                // Splice: keep history up to (not including) the anchor, then
                // append the new content (which starts with the anchor pattern).
                return history.Substring(0, posInHistory) + newPart;
            }
            // Anchor matched in current but not in history (first-ever read).
            return history + newPart;
        }

        // No anchor matched anywhere — caption engine rewrote the tail beyond
        // our scan window. Clean-append with a space separator (mirrors LCCopier).
        if (history.Length == 0) return currentRead;
        return history + " " + currentRead;
    }
}
