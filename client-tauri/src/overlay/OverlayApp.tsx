import type { ChatTurn, ProfileWithFiles } from "@brandon/shared";
import type { ClipboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { bridge } from "../lib/bridge";
import { BrandMark } from "../lib/BrandMark";
import { Markdown } from "../lib/Markdown";

interface ParsedResponse {
  bullets: string[];
  script: string;
  raw: string;
}

interface PastedImage {
  /** object URL for the thumbnail preview */
  preview: string;
  mediaType: string;
  /** base64 (no data: prefix) for the API */
  data: string;
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

// Output text size (assistant response). Adjustable A−/A+ in the footer.
const FONT_SIZE_KEY = "brandon.outputFontSize";
const FONT_DEFAULT = 18;
const FONT_MIN = 13;
const FONT_MAX = 30;
const FONT_STEP = 1;

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

const WEATHER_CODE_DESC: Record<number, string> = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
  61: "Rain", 63: "Rain", 65: "Rain", 71: "Snow", 73: "Snow", 75: "Snow",
  80: "Showers", 81: "Showers", 82: "Showers", 95: "Storm", 96: "Storm", 99: "Storm",
};

const weatherCache = new Map<string, { fetchedAt: number; weather: Weather }>();
const WEATHER_TTL_MS = 10 * 60 * 1000;

async function fetchWeather(location: string): Promise<Weather | null> {
  const cached = weatherCache.get(location);
  if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS) return cached.weather;
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl);
    const geo = await geoRes.json();
    const top = geo.results?.[0];
    if (!top) return null;
    const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${top.latitude}&longitude=${top.longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
    const wRes = await fetch(wUrl);
    const w = await wRes.json();
    const tempF = Math.round(w.current?.temperature_2m ?? 0);
    const code = w.current?.weather_code ?? -1;
    const description = WEATHER_CODE_DESC[code] ?? "—";
    const localTime = w.current?.time ? new Date(w.current.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    const weather: Weather = { tempF, description, localTime };
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
  // Pasted screenshots to send with the next question (coding/system-design panel).
  const [images, setImages] = useState<PastedImage[]>([]);
  const imagesRef = useRef<PastedImage[]>([]);
  imagesRef.current = images;
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
  // Output text size (px) for the assistant response — adjustable from the
  // footer with A−/A+ and persisted so it survives restarts.
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = Number(localStorage.getItem(FONT_SIZE_KEY));
    return saved >= FONT_MIN && saved <= FONT_MAX ? saved : FONT_DEFAULT;
  });
  useEffect(() => { localStorage.setItem(FONT_SIZE_KEY, String(fontSize)); }, [fontSize]);
  const bumpFont = useCallback((delta: number) => {
    setFontSize((s) => Math.min(FONT_MAX, Math.max(FONT_MIN, s + delta)));
  }, []);
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
    const pastedImages = imagesRef.current;
    if (!noteText && !markedText && pastedImages.length === 0) {
      setError("Mark caption text, type a question, or paste a screenshot before sending.");
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
    } else if (noteText) {
      userIntent = noteText;
      bubble = noteText;
    } else {
      // Image(s) only — tell the model to read the screenshot (a coding problem
      // or system-design diagram) and answer it as the candidate would aloud.
      userIntent = "Read the attached screenshot — it's what's on the interviewer's shared screen (likely a coding problem or a system-design diagram). Answer it as me, speaking aloud.";
      bubble = `📷 ${pastedImages.length} screenshot${pastedImages.length > 1 ? "s" : ""}`;
    }
    setLastQuestion(bubble);

    const priorTurns: ChatTurn[] = turnsRef.current.map((t) => ({ user: t.user, assistant: t.assistant }));
    const imagesToSend = pastedImages.map((im) => ({ mediaType: im.mediaType, data: im.data }));

    // Clear the form immediately so the user can already mark the next question
    // and start typing the next note while Claude is still streaming the answer.
    setMarkPos(null);
    setNote("");
    setImages([]);

    let raw = "";
    try {
      await api.streamChat(
        { profileId: profile.id, transcriptWindow: transcriptRef.current, userIntent, priorTurns, images: imagesToSend },
        {
          onText: (text) => { raw += text; setResponse(parseResponse(raw)); },
          onDone: () => {
            setStreaming(false);
            // Persist this turn in the conversation history so Claude sees it next time.
            if (raw.trim()) {
              setTurns((prev) => [...prev, { label: bubble, user: userIntent, assistant: raw }]);
            }
          },
          onError: (msg) => { setError(msg); setStreaming(false); },
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
      setStreaming(false);
    }
  }, [activeProfile, refreshProfile]);

  // Paste a screenshot (Cmd/Ctrl+V) anywhere in the overlay → attach it to the
  // next question. Reads image clipboard items, converts to base64.
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((it) => it.type.startsWith("image/"));
    if (imageItems.length === 0) return; // let normal text paste happen
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result); // data:<mime>;base64,<data>
        const comma = result.indexOf(",");
        if (comma === -1) return;
        const data = result.slice(comma + 1);
        setImages((prev) => [...prev, { preview: result, mediaType: file.type, data }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  useEffect(() => {
    const off = bridge.onHotkey((evt) => {
      if (evt.type === "trigger-chat") trigger();
      if (evt.type === "clear-transcript") {
        setTranscript("");
        setMarkPos(null);
        setNote("");
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

  const canSend = !streaming && (markPos !== null || note.trim().length > 0 || images.length > 0);
  const markedLen = markPos !== null ? transcript.slice(markPos).trim().length : 0;

  return (
    <div className="overlay-shell">
      <div className="overlay-toppill">
        <BrandMark className="brand-mark" size={22} />
        <button onClick={() => setCollapsed((v) => !v)} title={collapsed ? "Show panel" : "Hide panel"}>
          {collapsed ? chevronUp : chevronDown}
          <span>{collapsed ? "Show" : "Hide"}</span>
        </button>
        <button className="end-btn" onClick={endInterview} title="End this interview and close the overlay">
          <span>End</span>
        </button>
        <button
          className={captionsStatus === "running" ? "mic recording" : "mic"}
          title={captionsStatus === "running" ? "Live Captions: active" : captionsHint || "Press Win+Ctrl+L to start Live Captions"}
        >{micIcon}</button>
      </div>

      {!collapsed && (
        <div className="overlay-card">
          <div
            className="response-area"
            ref={responseScrollRef}
            onScroll={onResponseScroll}
            style={{ ["--output-font-size" as string]: `${fontSize}px` }}
          >
            {turns.length === 0 && !streaming && !lastQuestion && (
              <div className="placeholder">
                Type your question or instruction below and press Enter to send.
              </div>
            )}

            {turns.map((t, i) => (
              <div key={i} className="turn">
                <div className="bubble user">{truncate(t.label, 320)}</div>
                <div className="bubble assistant">
                  <Markdown>{t.assistant}</Markdown>
                </div>
              </div>
            ))}

            {streaming && (
              <div className="turn current">
                {lastQuestion && <div className="bubble user">{truncate(lastQuestion, 320)}</div>}
                {error && <div className="error">{error}</div>}
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

          {/* Live captions viewer. Click any word to mark where the question
              starts; mark + note can be sent together. The sidecar guarantees a
              byte-stable prefix so the mark offset survives every update. */}
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

          {/* Single input card — type your question/instruction and press Enter. */}
          <div className="note-card" onPaste={handlePaste}>
            {images.length > 0 && (
              <div className="image-strip">
                {images.map((im, i) => (
                  <div className="image-thumb" key={i}>
                    <img src={im.preview} alt={`pasted ${i + 1}`} />
                    <button onClick={() => removeImage(i)} title="Remove image">✕</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              className="note-input"
              ref={noteInputRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ask Brandon anything — paste the question, paste a screenshot (Cmd/Ctrl+V), or write an instruction. Enter to send, Shift+Enter for newline."
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
                onClick={() => { setMarkPos(null); setNote(""); setImages([]); }}
                disabled={markPos === null && !note && images.length === 0}
                title="Clear mark, note, and images"
              >Clear</button>
              <span className="hint-label">
                {images.length > 0 && `📷 ${images.length} · `}
                {markedLen > 0 && `Marked · ${markedLen} chars`}
                {markedLen > 0 && note.trim() && " + note"}
                {markedLen === 0 && note.trim() && `${note.trim().length} chars`}
                {markedLen === 0 && !note.trim() && images.length === 0 && "Click a caption word to mark, type, or paste a screenshot"}
              </span>
              <span className="kbd">↵</span>
              <button
                className="send-btn"
                onClick={trigger}
                disabled={!canSend}
                title="Send (Enter)"
              >{sendIcon}</button>
            </div>
          </div>

          <div className="overlay-footer">
            <span>
              {captionsStatus === "running" && <><span className="live-dot" />live</>}
              {captionsStatus === "not-running" && "captions: off"}
              {captionsStatus === "missing" && "sidecar missing"}
            </span>
            <div className="text-size-ctl" title="Output text size">
              <button
                onClick={() => bumpFont(-FONT_STEP)}
                disabled={fontSize <= FONT_MIN}
                title="Smaller output text"
                aria-label="Decrease text size"
              >A−</button>
              <button
                onClick={() => bumpFont(FONT_STEP)}
                disabled={fontSize >= FONT_MAX}
                title="Larger output text"
                aria-label="Increase text size"
              >A+</button>
            </div>
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
const micIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="6" y="2" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.4"/><path d="M3.5 8a4.5 4.5 0 009 0M8 12.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>);
const sendIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8l10-5-3 5 3 5-10-5z" fill="currentColor"/></svg>);
const stopIcon = (<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>);
