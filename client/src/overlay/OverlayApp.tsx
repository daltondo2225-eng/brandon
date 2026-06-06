import type { ChatTurn, ProfileWithFiles } from "@brandon/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { bridge } from "../lib/bridge";
import { Markdown } from "../lib/Markdown";
import { fileToImage, imagesFromClipboard } from "../lib/image";
import { BrandonMark } from "../lib/BrandonMark";
import { useOverlayPrefs, prefsToCssVars, THEMES } from "./prefs";

interface ParsedResponse {
  bullets: string[];
  script: string;
  raw: string;
}

interface DisplayTurn {
  /** Short label shown in the user bubble (e.g. the marked text). */
  label: string;
  /** Verbatim user message that was sent to Claude (used to feed back as priorTurns). */
  user: string;
  /** Claude's response (raw text). */
  assistant: string;
}

const TRANSCRIPT_MAX_CHARS = 30_000;
const TRANSCRIPT_KEEP_CHARS = 25_000;

function parseResponse(raw: string): ParsedResponse {
  const bulletsMatch = raw.match(/##\s*Bullets\s*([\s\S]*?)(?=^##\s|$)/im);
  const scriptMatch = raw.match(/##\s*Script\s*([\s\S]*?)(?=^##\s|$)/im);
  const bullets = bulletsMatch
    ? bulletsMatch[1]
        .split(/\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- ") || l.startsWith("* "))
        .map((l) => l.replace(/^[-*]\s+/, "").trim())
    : [];
  const script = scriptMatch ? scriptMatch[1].trim() : "";
  return { bullets, script, raw };
}

interface CaptionToken { text: string; start: number; isSpace: boolean; }
function tokenizeCaptions(s: string): CaptionToken[] {
  const out: CaptionToken[] = [];
  const re = /\S+|\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ text: m[0], start: m.index, isSpace: /^\s+$/.test(m[0]) });
  }
  return out;
}

/* ---------------------- Component ------------------------- */

interface Weather { tempF: number; description: string; localTime: string; }

// Weather now comes from the server proxy (api.getWeather) — the client makes
// no direct external API calls. The server returns the location's local time as
// an ISO-ish string; we format it for display here (pure presentation).
const weatherCache = new Map<string, { fetchedAt: number; weather: Weather }>();
const WEATHER_TTL_MS = 10 * 60 * 1000;

async function fetchWeather(location: string): Promise<Weather | null> {
  const cached = weatherCache.get(location);
  if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS) return cached.weather;
  try {
    const w = await api.getWeather(location);
    if (!w) return null;
    const localTime = w.localTime
      ? new Date(w.localTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "";
    const weather: Weather = { tempF: w.tempF, description: w.description, localTime };
    weatherCache.set(location, { fetchedAt: Date.now(), weather });
    return weather;
  } catch {
    return null;
  }
}

export function OverlayApp() {
  const [activeProfile, setActiveProfile] = useState<ProfileWithFiles | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  /** Char offset into `transcript` where the marked region starts. Stable across
   *  caption updates because the sidecar's merge guarantees the prefix is never
   *  mutated (LCCopier-style anchor splice). null = no mark. */
  const [markPos, setMarkPos] = useState<number | null>(null);
  const [note, setNote] = useState<string>("");
  /** Images attached to the next chat — pasted from clipboard or picked from
   *  the file dialog. Each is a base64 data URL + media type ready for the
   *  ChatRequest's `images` field. */
  const [pendingImages, setPendingImages] = useState<Array<{ mediaType: string; data: string; previewUrl: string }>>([]);
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  /** Code-tool calls Brandon made during the in-flight chat — rendered as inline
   *  progress lines above the streaming response. Cleared at the start of every
   *  new chat trigger. */
  const [toolCalls, setToolCalls] = useState<Array<{ summary: string; ok: boolean }>>([]);
  // Overlay appearance prefs (font/size/theme/accent/opacity) — persisted +
  // tuned live from the gear popover. fontSize kept as a derived shortcut.
  const { prefs, update: updatePrefs } = useOverlayPrefs();
  const fontSize = prefs.fontSize;
  const bumpFontSize = (delta: number) =>
    updatePrefs({ fontSize: Math.max(12, Math.min(32, prefs.fontSize + delta)) });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsWrapRef = useRef<HTMLDivElement>(null);
  // Close the appearance popover on a click anywhere outside it (NOT on
  // mouse-leave, which closed it the moment you moved toward the slider).
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (settingsWrapRef.current && !settingsWrapRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [settingsOpen]);

  // Listen for Ctrl+V paste anywhere in the overlay; if the clipboard has an
  // image, attach it as a pending image for the next chat.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const imgs = imagesFromClipboard(e);
      if (!imgs.length) return;
      e.preventDefault();
      const converted = await Promise.all(imgs.map(fileToImage));
      setPendingImages((prev) => [...prev, ...converted]);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const attachFromFileDialog = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const out: typeof pendingImages = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type.startsWith("image/")) out.push(await fileToImage(f));
    }
    if (out.length) setPendingImages((prev) => [...prev, ...out]);
  }, []);

  const removeImage = useCallback((idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const [weather, setWeather] = useState<Weather | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [response, setResponse] = useState<ParsedResponse | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string>("");
  const [turns, setTurns] = useState<DisplayTurn[]>([]);
  const [error, setError] = useState<string>("");
  const turnsRef = useRef<DisplayTurn[]>([]);
  turnsRef.current = turns;
  const [captionsStatus, setCaptionsStatus] = useState<"unknown" | "running" | "not-running" | "missing">("unknown");
  const [captionsHint, setCaptionsHint] = useState<string>("");
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => formatTime(new Date()));
  const abortRef = useRef<AbortController | null>(null);
  const responseScrollRef = useRef<HTMLDivElement>(null);
  const captionsViewRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const responseAtBottomRef = useRef(true);

  // Auto-stick the captions viewer to the latest text on each update.
  useEffect(() => {
    const el = captionsViewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // Reduce wheel scroll sensitivity inside the small overlay panels — at the
  // default OS step the view jumps several lines per tick, which feels wrong on
  // ~100-150px tall panels with 13px text.
  useEffect(() => {
    const els: (HTMLElement | null)[] = [
      responseScrollRef.current,
      noteInputRef.current,
    ];
    const factor = 0.35;
    const handler = (e: WheelEvent) => {
      const target = e.currentTarget as HTMLElement;
      if (e.ctrlKey) return; // allow zoom
      e.preventDefault();
      target.scrollTop += e.deltaY * factor;
    };
    for (const el of els) {
      if (el) el.addEventListener("wheel", handler as EventListener, { passive: false });
    }
    return () => {
      for (const el of els) {
        if (el) el.removeEventListener("wheel", handler as EventListener);
      }
    };
  }, []);

  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const noteRef = useRef(note);
  noteRef.current = note;
  const markPosRef = useRef(markPos);
  markPosRef.current = markPos;
  const prevFullRef = useRef<string>("");

  const refreshProfile = useCallback(async () => {
    try {
      const list = await api.listProfiles();
      const active = list.find((p) => p.isActive);
      if (!active) { setActiveProfile(null); return null; }
      const detail = await api.getProfile(active.id);
      setActiveProfile(detail);
      return detail;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshProfile();
    const t = setInterval(refreshProfile, 10_000);
    return () => clearInterval(t);
  }, [refreshProfile]);

  useEffect(() => {
    const t = setInterval(() => setNow(formatTime(new Date())), 30_000);
    return () => clearInterval(t);
  }, []);

  // Fetch weather for the active profile's location; refresh every 10 minutes.
  useEffect(() => {
    const loc = activeProfile?.location?.trim();
    if (!loc) { setWeather(null); return; }
    let cancelled = false;
    fetchWeather(loc).then((w) => { if (!cancelled) setWeather(w); });
    const t = setInterval(() => {
      fetchWeather(loc).then((w) => { if (!cancelled) setWeather(w); });
    }, WEATHER_TTL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [activeProfile?.location]);

  const onResponseScroll = useCallback(() => {
    const el = responseScrollRef.current;
    if (!el) return;
    responseAtBottomRef.current = el.scrollHeight - (el.scrollTop + el.clientHeight) < 24;
  }, []);
  useEffect(() => {
    const el = responseScrollRef.current;
    if (!el) return;
    if (responseAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [response]);

  // When a new conversation turn starts (lastQuestion changes), reset to follow
  // the latest by default — so the new answer is visible.
  useEffect(() => { responseAtBottomRef.current = true; }, [lastQuestion]);

  const trigger = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setResponse({ bullets: [], script: "", raw: "" });
    setStreaming(true);

    const profile = activeProfile ?? (await refreshProfile());
    if (!profile) {
      setError("No active profile. Open Brandon and set a mode as Active.");
      setStreaming(false);
      return;
    }

    const noteText = noteRef.current.trim();
    const markedText = markPosRef.current !== null
      ? transcriptRef.current.slice(markPosRef.current).trim()
      : "";
    if (!noteText && !markedText) {
      setError("Mark caption text or type a question before sending.");
      setStreaming(false);
      return;
    }

    let userIntent: string;
    let bubble: string;
    if (markedText && noteText) {
      userIntent = `Interviewer (from live captions): "${markedText}"\n\nMy note: ${noteText}`;
      bubble = `${noteText}\n— on: "${truncate(markedText, 120)}"`;
    } else if (markedText) {
      userIntent = markedText;
      bubble = markedText;
    } else {
      userIntent = noteText;
      bubble = noteText;
    }
    setLastQuestion(bubble);

    const priorTurns: ChatTurn[] = turnsRef.current.map((t) => ({ user: t.user, assistant: t.assistant }));

    // Snapshot the inputs before clearing — so an error path can restore them
    // and the user just hits Enter again instead of retyping the whole question.
    const sentNote = noteText;
    const sentMarkPos = markPosRef.current;
    const sentImages = pendingImagesRef.current.slice();

    // Clear the form immediately so the user can already mark the next question
    // and start typing the next note while Claude is still streaming the answer.
    setMarkPos(null);
    setNote("");
    setPendingImages([]);
    setToolCalls([]);

    const restoreInputs = () => {
      // Only restore if the user hasn't already started typing the next one.
      if (!noteRef.current && markPosRef.current === null && pendingImagesRef.current.length === 0) {
        setNote(sentNote);
        if (sentMarkPos !== null) setMarkPos(sentMarkPos);
        if (sentImages.length > 0) setPendingImages(sentImages);
      }
    };

    let raw = "";
    try {
      await api.streamChat(
        {
          profileId: profile.id,
          transcriptWindow: transcriptRef.current,
          userIntent,
          priorTurns,
          images: pendingImagesRef.current.map(({ mediaType, data }) => ({ mediaType, data })),
        },
        {
          onText: (text) => { raw += text; setResponse(parseResponse(raw)); },
          onTool: (evt) => setToolCalls((prev) => [...prev, { summary: evt.summary, ok: evt.ok }]),
          onDone: () => {
            setStreaming(false);
            // Persist this turn in the conversation history so Claude sees it next time.
            if (raw.trim()) {
              setTurns((prev) => [...prev, { label: bubble, user: userIntent, assistant: raw }]);
            } else {
              // Empty response (e.g. provider returned 0 chars) — restore so the user can retry.
              restoreInputs();
            }
          },
          onError: (msg) => { setError(msg); setStreaming(false); restoreInputs(); },
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
        restoreInputs();
      }
      setStreaming(false);
    }
  }, [activeProfile, refreshProfile]);

  // Edit a prior turn's question and regenerate from there (ChatGPT-style):
  // drop that turn + everything after it, then re-ask with the edited text as
  // the userIntent. Prior turns before the edited one stay as context.
  const editTurn = useCallback(async (index: number, newText: string) => {
    const text = newText.trim();
    if (!text || streaming) return;
    const profile = activeProfile ?? (await refreshProfile());
    if (!profile) { setError("No active profile. Open Brandon and set a mode as Active."); return; }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setResponse({ bullets: [], script: "", raw: "" });
    setToolCalls([]);
    setStreaming(true);

    // History before the edited turn becomes the context; the edited turn and
    // everything after it are discarded.
    const priorTurns: ChatTurn[] = turnsRef.current.slice(0, index).map((t) => ({ user: t.user, assistant: t.assistant }));
    setTurns((prev) => prev.slice(0, index));
    setLastQuestion(text);

    let raw = "";
    try {
      await api.streamChat(
        {
          profileId: profile.id,
          transcriptWindow: transcriptRef.current,
          userIntent: text,
          priorTurns,
        },
        {
          onText: (t) => { raw += t; setResponse(parseResponse(raw)); },
          onTool: (evt) => setToolCalls((prev) => [...prev, { summary: evt.summary, ok: evt.ok }]),
          onDone: () => {
            setStreaming(false);
            if (raw.trim()) setTurns((prev) => [...prev, { label: text, user: text, assistant: raw }]);
          },
          onError: (msg) => { setError(msg); setStreaming(false); },
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
      setStreaming(false);
    }
  }, [activeProfile, refreshProfile, streaming]);

  // Inline edit state for a prior turn's question.
  const [editingTurn, setEditingTurn] = useState<number | null>(null);
  const [editTurnText, setEditTurnText] = useState("");

  // Subscribe to "resume conversation" payloads pushed from the main window
  // (MeetingDetail → Resume button). Hydrates the conversation history into
  // state so the next chat sends them as priorTurns and the historical
  // bubbles render immediately.
  useEffect(() => {
    const off = bridge.onResumeTurns((turns) => {
      if (!Array.isArray(turns) || turns.length === 0) return;
      const sanitized: DisplayTurn[] = turns
        .filter((t) => t && typeof t.user === "string" && typeof t.assistant === "string")
        .map((t) => ({
          label: typeof t.label === "string" && t.label ? t.label : t.user.slice(0, 80),
          user: t.user,
          assistant: t.assistant,
        }));
      setTurns(sanitized);
      // Set lastQuestion to the most recent so the streaming UI has something
      // to anchor to if the user immediately fires off a follow-up.
      const last = sanitized[sanitized.length - 1];
      if (last) setLastQuestion(last.label);
    });
    return off;
  }, []);

  useEffect(() => {
    const off = bridge.onHotkey((evt) => {
      if (evt.type === "trigger-chat") trigger();
      if (evt.type === "clear-transcript") {
        setTranscript("");
        setMarkPos(null);
        setNote("");
        setPendingImages([]);
        prevFullRef.current = "";
        setResponse(null);
        setLastQuestion("");
        setTurns([]);
        setError("");
      }
    });
    return off;
  }, [trigger]);

  const captionsStatusRef = useRef(captionsStatus);
  captionsStatusRef.current = captionsStatus;
  useEffect(() => {
    const off = bridge.onCaptions((evt) => {
      if (evt.type === "delta") {
        // The C# sidecar now maintains an authoritative cumulative history with
        // suffix-anchor merging (see sidecar/BrandonCaptions/Program.cs), so we
        // just adopt `full` verbatim. No client-side dedupe needed.
        const newFull = evt.full ?? evt.text;
        setTranscript(newFull);
        prevFullRef.current = newFull;
      } else if (evt.type === "status") {
        setCaptionsStatus(evt.captionsRunning ? "running" : "not-running");
        setCaptionsHint(evt.hint ?? "");
      } else if (evt.type === "sidecar-missing") {
        setCaptionsStatus("missing");
        setCaptionsHint(`Sidecar missing: ${evt.expectedPath}`);
      } else if (evt.type === "error") {
        if (captionsStatusRef.current !== "running") setCaptionsHint(evt.message);
      }
    });
    return off;
  }, []);

  useEffect(() => {
    if (transcript.length <= TRANSCRIPT_MAX_CHARS) return;
    setTranscript((cur) => cur.slice(-TRANSCRIPT_KEEP_CHARS));
  }, [transcript]);

  const firstCollapseEffect = useRef(true);
  useLayoutEffect(() => {
    if (firstCollapseEffect.current) { firstCollapseEffect.current = false; return; }
    bridge.setOverlayCollapsed(collapsed);
  }, [collapsed]);

  // End the current interview: combine captions + Q&A into the saved transcript,
  // mark the latest unended session as ended, then bring the main window back.
  const endInterview = useCallback(async () => {
    try {
      if (activeProfile) {
        const sessions = await api.listSessions(activeProfile.id);
        const open = sessions.find((s) => s.endedAt === null);
        if (open) {
          const captionsText = transcriptRef.current.trim();
          const conversationText = turnsRef.current
            .map((t) => `Q: ${t.label.trim()}\n\nA: ${t.assistant.trim()}`)
            .join("\n\n---\n\n");
          const combined = [
            captionsText ? `## Captions transcript\n\n${captionsText}` : "",
            conversationText ? `## Conversation with Brandon\n\n${conversationText}` : "",
          ].filter(Boolean).join("\n\n");
          await api.updateSession(open.id, {
            endedAt: Date.now(),
            transcript: combined || null,
            // Persist the structured DisplayTurn[] so the meeting can be
            // resumed later — see MeetingDetail's "Resume conversation" button.
            priorTurnsJson: turnsRef.current.length ? JSON.stringify(turnsRef.current) : null,
          });
        }
      }
    } catch { /* ignore — still hide the overlay */ }
    // Clear the in-memory conversation history for the next interview
    setTurns([]);
    setLastQuestion("");
    setResponse(null);
    setTranscript("");
    prevFullRef.current = "";
    bridge.showMainWindow();
    bridge.hideOverlay();
  }, [activeProfile]);

  const responseScript = response?.script ?? "";
  const responseBullets = response?.bullets ?? [];
  const hasResponse = !!(response && (responseScript || responseBullets.length || error));
  const responseRaw = response?.raw ?? "";

  const canSend = !streaming && (markPos !== null || note.trim().length > 0 || pendingImages.length > 0);
  const markedLen = markPos !== null ? transcript.slice(markPos).trim().length : 0;

  return (
    <div className="overlay-shell">
      <div className="overlay-toppill">
        <BrandonMark size={22} className="brand-mark" />
        <button onClick={() => setCollapsed((v) => !v)} title={collapsed ? "Show panel" : "Hide panel"}>
          {collapsed ? chevronUp : chevronDown}
          <span>{collapsed ? "Show" : "Hide"}</span>
        </button>
        {/* Output text size — A− / A+ tweak the response font in 2px steps. */}
        <button
          className="font-bump"
          onClick={() => bumpFontSize(-2)}
          disabled={fontSize <= 12}
          title={`Smaller (currently ${fontSize}px)`}
        >A−</button>
        <button
          className="font-bump"
          onClick={() => bumpFontSize(+2)}
          disabled={fontSize >= 32}
          title={`Larger (currently ${fontSize}px)`}
        >A+</button>
        <div className="ov-settings-wrap" ref={settingsWrapRef}>
          <button
            className={`ov-gear${settingsOpen ? " active" : ""}`}
            onClick={() => setSettingsOpen((v) => !v)}
            title="Overlay appearance"
          >{gearIcon}</button>
          {settingsOpen && (
            <div className="ov-settings">
              <div className="ov-row">
                <span className="ov-label">Theme</span>
                <div className="ov-seg">
                  {THEMES.map((t) => (
                    <button key={t.id} className={prefs.theme === t.id ? "active" : ""}
                      onClick={() => updatePrefs({ theme: t.id })}>{t.label}</button>
                  ))}
                </div>
              </div>
              <div className="ov-row">
                <span className="ov-label">Opacity</span>
                <input type="range" min={30} max={100} value={Math.round(prefs.opacity * 100)}
                  onChange={(e) => updatePrefs({ opacity: Number(e.target.value) / 100 })} />
                <span className="ov-val">{Math.round(prefs.opacity * 100)}%</span>
              </div>
            </div>
          )}
        </div>
        <button className="end-btn" onClick={endInterview} title="End this interview and close the overlay">
          <span>End</span>
        </button>
      </div>

      {!collapsed && (
        <div className={`overlay-card${prefs.theme === "light" ? " light" : ""}`} style={prefsToCssVars(prefs) as Record<string, string>}>
          {/* Top bar: live captions on the left, input note-card on the right,
              equal halves, compact height. The answer stream rolls underneath. */}
          <div className="top-bar">
            <div className="captions-view" ref={captionsViewRef}>
              {transcript.trim().length === 0 ? (
                <span className="placeholder">
                  {captionsStatus === "running"
                    ? "Listening… waiting for spoken text."
                    : "Press Win+Ctrl+L to start Windows Live Captions."}
                </span>
              ) : (
                (() => {
                  const VISIBLE = 600;
                  const sliceStart = Math.max(0, transcript.length - VISIBLE);
                  const visible = transcript.slice(sliceStart);
                  const tokens = tokenizeCaptions(visible);
                  return tokens.map((tok, i) => {
                    const globalStart = sliceStart + tok.start;
                    const isMarked = markPos !== null && globalStart >= markPos;
                    if (tok.isSpace) {
                      return <span key={i} className={isMarked ? "marked" : undefined}>{tok.text}</span>;
                    }
                    return (
                      <span
                        key={i}
                        className={`tok${isMarked ? " marked" : ""}`}
                        onClick={() => setMarkPos(globalStart)}
                        title="Mark question start here"
                      >{tok.text}</span>
                    );
                  });
                })()
              )}
            </div>

            <div className="note-card">
              {pendingImages.length > 0 && (
                <div className="attachment-row">
                  {pendingImages.map((img, i) => (
                    <div className="attachment" key={i} title={`Image ${i + 1} (${img.mediaType})`}>
                      <img src={img.previewUrl} alt={`attached ${i + 1}`} />
                      <button className="attachment-remove" onClick={() => removeImage(i)} title="Remove">×</button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                className="note-input"
                ref={noteInputRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Ask Brandon — paste a question or attach a screenshot. Enter to send."
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    trigger();
                  }
                }}
              />
              <div className="note-actions">
                <button
                  className="clear-mark"
                  onClick={() => { setMarkPos(null); setNote(""); setPendingImages([]); }}
                  disabled={markPos === null && !note && pendingImages.length === 0}
                  title="Clear mark, note, and attachments"
                >Clear</button>
                <label className="attach-btn" title="Attach image (or paste with Ctrl+V)">
                  {paperclipIcon}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => { attachFromFileDialog(e.target.files); e.target.value = ""; }}
                  />
                </label>
                <div className="actions-spacer" />
                <button
                  className="send-btn"
                  onClick={trigger}
                  disabled={!canSend}
                  title="Send (Enter)"
                >{sendIcon}</button>
              </div>
            </div>
          </div>

          <div className="response-area" ref={responseScrollRef} onScroll={onResponseScroll}>
            {turns.length === 0 && !streaming && !lastQuestion && (
              <div className="placeholder">
                Type your question or instruction below and press Enter to send.
              </div>
            )}

            {turns.map((t, i) => (
              <div key={i} className="turn">
                {editingTurn === i ? (
                  <div className="bubble-edit">
                    <textarea
                      autoFocus value={editTurnText}
                      onChange={(e) => setEditTurnText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setEditingTurn(null); editTurn(i, editTurnText); }
                        if (e.key === "Escape") setEditingTurn(null);
                      }}
                      rows={Math.min(6, Math.max(1, editTurnText.split("\n").length))}
                    />
                    <div className="bubble-edit-actions">
                      <button onClick={() => setEditingTurn(null)}>Cancel</button>
                      <button className="primary" onClick={() => { setEditingTurn(null); editTurn(i, editTurnText); }} disabled={!editTurnText.trim() || streaming}>Send</button>
                    </div>
                  </div>
                ) : (
                  <div className="bubble user">
                    {truncate(t.label, 320)}
                    {!streaming && (
                      <button className="bubble-edit-btn" title="Edit & regenerate"
                        onClick={() => { setEditingTurn(i); setEditTurnText(t.user); }}>{pencilIconOv}</button>
                    )}
                  </div>
                )}
                <div className="bubble assistant">
                  <Markdown>{t.assistant}</Markdown>
                </div>
              </div>
            ))}

            {streaming && (
              <div className="turn current">
                {lastQuestion && <div className="bubble user">{truncate(lastQuestion, 320)}</div>}
                {error && <div className="error">{error}</div>}
                {toolCalls.length > 0 && (
                  <div className="tool-calls">
                    {toolCalls.map((t, i) => (
                      <div key={i} className={`tool-call${t.ok ? "" : " err"}`}>
                        🔍 {t.summary}
                      </div>
                    ))}
                  </div>
                )}
                {responseRaw && (
                  <div className="bubble assistant">
                    <Markdown>{responseRaw}</Markdown>
                  </div>
                )}
                <button className="stop-btn" onClick={() => abortRef.current?.abort()} title="Stop generating">
                  {stopIcon}
                  <span>Stop generating</span>
                </button>
              </div>
            )}

            {!streaming && error && <div className="error">{error}</div>}
          </div>

          <div className="overlay-footer">
            <span title={captionsHint || undefined}>
              {captionsStatus === "running" && <><span className="live-dot" />live</>}
              {captionsStatus === "not-running" && "captions: off"}
              {captionsStatus === "missing" && "sidecar missing"}
            </span>
            <div className="spacer" />
            {activeProfile?.fullName && (
              <>
                <span className="identity"><strong>{activeProfile.fullName}</strong></span>
                <span>·</span>
              </>
            )}
            {(activeProfile?.jobTitle || activeProfile?.company) && (
              <>
                <span className="identity">
                  {activeProfile?.jobTitle}
                  {activeProfile?.jobTitle && activeProfile?.company && " @ "}
                  {activeProfile?.company}
                </span>
                <span>·</span>
              </>
            )}
            {activeProfile?.location && (
              <>
                <span>{activeProfile.location}</span>
                <span>·</span>
              </>
            )}
            {weather && (
              <>
                <span>{weather.tempF}°F {weather.description}</span>
                <span>·</span>
              </>
            )}
            <span>{weather?.localTime || now}</span>
          </div>

          <div
            className="resize-grip"
            title="Drag to resize"
            onPointerDown={(e) => {
              e.preventDefault();
              const startW = window.innerWidth;
              const startH = window.innerHeight;
              const startX = e.screenX;
              const startY = e.screenY;
              const onMove = (mv: PointerEvent) => {
                bridge.setOverlaySize(
                  Math.max(540, startW + (mv.screenX - startX)),
                  Math.max(220, startH + (mv.screenY - startY)),
                );
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            }}
          />
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

const chevronDown = (<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const chevronUp = (<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M3 7l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const sendIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8l10-5-3 5 3 5-10-5z" fill="currentColor"/></svg>);
const paperclipIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 7l-4.7 4.7a2 2 0 01-2.8-2.8L8.7 4.2a3 3 0 014.2 4.2L8 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const stopIcon = (<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>);
const pencilIconOv = (<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const gearIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>);
