import type { AgendaItem, CompanyStatus, PipelineEntry, Profile, ProfileWithFiles, Session } from "@brandon/shared";
import { DEFAULT_REALTIME_PROMPT } from "@brandon/shared";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { bridge, getConfig, resetConfigCache } from "../lib/bridge";
import { Markdown } from "../lib/Markdown";
import { fileToImage, imagesFromClipboard } from "../lib/image";
import { BrandonMark } from "../lib/BrandonMark";

const DETECTABLE_KEY = "brandon.detectable";
const THEME_KEY = "brandon.theme";

const SUPPORTED_EXTENSIONS = ".pdf,.docx,.txt,.md";

// Panes in the unified shell: chat (home), interviews, calendar, modes editor.
type View = "chat" | "home" | "calendar" | "modes";

type Theme = "light" | "dark";
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem(THEME_KEY) as Theme) || "light"; } catch { return "light"; }
  });
  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "light" ? "dark" : "light"))];
}

function MainApp({ currentUser, onLogout }: { currentUser: api.AuthUser; onLogout: () => void }) {
  // Chat is the default home (ChatGPT-style). "home" is now the Interviews pane.
  const [view, setView] = useState<View>("chat");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProfileWithFiles | null>(null);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [openMeetingId, setOpenMeetingId] = useState<string | null>(null);
  const [pendingStartProfile, setPendingStartProfile] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [error, setError] = useState<string>("");
  const [theme, toggleTheme] = useTheme();

  // Detectable = visible in screen capture. On this Win11 GPU combo,
  // setContentProtection(true) makes the overlay invisible to the user too —
  // so default to detectable=TRUE (no content protection). User flips the
  // toggle when they actually need stealth (e.g. mid-interview screen share).
  const [detectable, setDetectable] = useState<boolean>(() => {
    const saved = (() => { try { return localStorage.getItem(DETECTABLE_KEY); } catch { return null; } })();
    if (saved === null) return true;
    return saved === "true";
  });

  useEffect(() => {
    try { localStorage.setItem(DETECTABLE_KEY, String(detectable)); } catch { /* ignore */ }
    bridge.setDetectable(detectable);
  }, [detectable]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listProfiles();
      setProfiles(list);
      if (!selectedId && list.length > 0) setSelectedId(list[0].id);
      setError("");
    } catch (err) {
      // Silent on background refresh — only user-initiated actions surface errors.
      console.warn("listProfiles failed:", (err as Error).message);
    }
  }, [selectedId]);

  useEffect(() => { refresh(); }, [refresh]);

  const [pipeline, setPipeline] = useState<PipelineEntry[]>([]);

  const activeProfileId = profiles.find((p) => p.isActive)?.id ?? null;

  const refreshSessions = useCallback(async () => {
    try {
      setAllSessions(await api.listSessions(activeProfileId ?? undefined));
      setError("");
    } catch (err) {
      // Background polling can fail transiently while the server restarts —
      // stay silent rather than poisoning the UI with a sticky "Failed to fetch".
      console.warn("listSessions failed:", (err as Error).message);
    }
  }, [activeProfileId]);
  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  const refreshPipeline = useCallback(async () => {
    try { setPipeline(await api.listPipeline(activeProfileId ?? undefined)); }
    catch (err) { console.warn("listPipeline failed:", (err as Error).message); }
  }, [activeProfileId]);
  useEffect(() => { refreshPipeline(); }, [refreshPipeline]);

  const [agenda, setAgenda] = useState<AgendaItem[]>([]);
  const refreshAgenda = useCallback(async () => {
    try { setAgenda(await api.listAgenda(activeProfileId ?? undefined)); }
    catch (err) { console.warn("listAgenda failed:", (err as Error).message); }
  }, [activeProfileId]);
  useEffect(() => { refreshAgenda(); }, [refreshAgenda]);

  // When the main window regains focus (e.g. user clicked End in the overlay and
  // returned here, or switched back from another app), pull the latest sessions
  // so any just-ended meeting shows up.
  useEffect(() => {
    const onFocus = () => { refreshSessions(); refreshPipeline(); refreshAgenda(); refresh(); };
    window.addEventListener("focus", onFocus);
    const offIpc = bridge.onMainRefresh(() => { refreshSessions(); refreshPipeline(); refreshAgenda(); refresh(); });
    return () => {
      window.removeEventListener("focus", onFocus);
      offIpc();
    };
  }, [refreshSessions, refreshPipeline, refreshAgenda, refresh]);

  // Lightweight polling: while the home view is open, refresh sessions every 5s
  // so an in-progress meeting reflects its actual state without manual reload.
  useEffect(() => {
    if (view !== "home") return;
    const t = setInterval(() => { refreshSessions(); refreshPipeline(); refreshAgenda(); }, 5000);
    return () => clearInterval(t);
  }, [view, refreshSessions, refreshPipeline, refreshAgenda]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    api.getProfile(selectedId).then((p) => { if (!cancelled) setDetail(p); }).catch((err) => setError((err as Error).message));
    return () => { cancelled = true; };
  }, [selectedId]);

  const createNew = useCallback(async () => {
    try {
      const p = await api.createProfile({ name: "Untitled" });
      await refresh();
      setSelectedId(p.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refresh]);

  const reloadDetail = useCallback(async () => {
    if (!selectedId) return;
    const fresh = await api.getProfile(selectedId);
    setDetail(fresh);
    await refresh();
  }, [selectedId, refresh]);

  // Open the pre-interview modal. The actual session creation + overlay happens
  // in confirmStartInterview after the user fills the company + JD.
  const startInterview = useCallback((profileId: string) => {
    setPendingStartProfile(profileId);
  }, []);

  const confirmStartInterview = useCallback(async (targetCompany: string, jobDescription: string) => {
    const profileId = pendingStartProfile;
    if (!profileId) return;
    try {
      await api.activateProfile(profileId);
      await api.createSession(profileId, {
        targetCompany: targetCompany.trim() || null,
        jobDescription: jobDescription.trim() || null,
      });
      await refresh();
      await refreshSessions();
      setPendingStartProfile(null);
      bridge.showOverlay();
      bridge.hideMainWindow();
    } catch (err) {
      console.error("startInterview failed:", err);
      setError((err as Error).message);
    }
  }, [pendingStartProfile, refresh, refreshSessions]);

  const activeProfile = profiles.find((p) => p.isActive) ?? null;

  const startModal = pendingStartProfile ? (
    <StartInterviewModal
      profile={profiles.find((p) => p.id === pendingStartProfile) ?? null}
      onCancel={() => setPendingStartProfile(null)}
      onConfirm={confirmStartInterview}
    />
  ) : null;

  const settingsModal = settingsOpen ? (
    <SettingsModal onClose={() => setSettingsOpen(false)} currentUser={currentUser} theme={theme} onToggleTheme={toggleTheme} />
  ) : null;

  const adminModal = adminOpen ? (
    <AdminPanel onClose={() => setAdminOpen(false)} currentUserId={currentUser.id} />
  ) : null;

  // One unified shell for the whole window: a single persistent sidebar + a
  // content pane that swaps (chat / interviews / calendar / modes). No more
  // separate full-screen views (that caused the "different window" jump).
  return (
    <>{startModal}{settingsModal}{adminModal}
      <ChatShell
        pane={view}
        setPane={setView}
        profiles={profiles}
        activeProfile={activeProfile}
        currentUser={currentUser}
        theme={theme}
        detectable={detectable}
        onToggleDetectable={() => setDetectable((v) => !v)}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAdmin={() => setAdminOpen(true)}
        onLogout={onLogout}
        onShrinkToOverlay={() => { bridge.showOverlay(); bridge.hideMainWindow(); }}
        // interviews data
        sessions={allSessions}
        pipeline={pipeline}
        agenda={agenda}
        openMeetingId={openMeetingId}
        onOpenMeeting={(id) => setOpenMeetingId(id)}
        onCloseMeeting={() => setOpenMeetingId(null)}
        onUpdateCompanyStatus={async (id, status) => { await api.updateCompany(id, { status }); await refreshPipeline(); }}
        onDeleteCompany={async (id) => { await api.deleteCompany(id); await refreshPipeline(); }}
        // modes data
        selectedModeId={selectedId}
        modeDetail={detail}
        onSelectMode={(id) => setSelectedId(id)}
        onCreateMode={createNew}
        reloadModeDetail={reloadDetail}
        refreshProfiles={refresh}
        onStartInterview={startInterview}
        onPickActive={async (id) => { await api.activateProfile(id); await refresh(); }}
        error={error}
        setError={setError}
      />
    </>
  );

}


function CalendarStrip({
  items,
  onOpenMeeting,
}: {
  items: AgendaItem[];
  onOpenMeeting: (sessionId: string) => void;
}) {
  const today = startOfDay(new Date());
  const [cursor, setCursor] = useState<Date>(() => startOfDay(new Date()));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Group items by ISO date string for O(1) cell lookup.
  const byDate = (() => {
    const m = new Map<string, AgendaItem[]>();
    for (const it of items) {
      if (!it.dueDate) continue;
      const list = m.get(it.dueDate) ?? [];
      list.push(it);
      m.set(it.dueDate, list);
    }
    return m;
  })();

  // Stable color-per-company so dots map consistently.
  const companyColors = new Map<string, string>();
  const palette = ["#1e7ef0", "#3aa757", "#d9821f", "#8b4ad9", "#d04a83", "#5b6cdc", "#2ba5a5"];
  let colorIdx = 0;
  for (const it of items) {
    const key = it.companyName ?? "(unassigned)";
    if (!companyColors.has(key)) {
      companyColors.set(key, palette[colorIdx % palette.length]);
      colorIdx++;
    }
  }

  // Build the 6×7 month grid starting on Monday.
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = (firstOfMonth.getDay() + 6) % 7; // 0=Mon..6=Sun
  const gridStart = new Date(year, month, 1 - startWeekday);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  }
  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const todayKey = isoDate(today);
  const selectedItems = selectedDay ? (byDate.get(selectedDay) ?? []) : [];

  return (
    <div className="calendar-strip">
      <div className="calendar-strip-head">
        <button
          className="cal-nav"
          onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
          title="Previous month"
        >‹</button>
        <span className="cal-title">{monthLabel}</span>
        <button
          className="cal-nav"
          onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
          title="Next month"
        >›</button>
        <button
          className="cal-today"
          onClick={() => { setCursor(startOfDay(new Date())); setSelectedDay(null); }}
        >Today</button>
        <span className="cal-count">
          {items.length === 0
            ? "No scheduled items yet"
            : `${items.length} ${items.length === 1 ? "item" : "items"}`}
        </span>
      </div>
      <div className="calendar-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div className="cal-weekday" key={d}>{d}</div>
        ))}
        {cells.map((d) => {
          const key = isoDate(d);
          const isOtherMonth = d.getMonth() !== month;
          const isToday = key === todayKey;
          const isSelected = key === selectedDay;
          const dayItems = byDate.get(key) ?? [];
          return (
            <button
              key={key}
              className={[
                "cal-cell",
                isOtherMonth && "other-month",
                isToday && "today",
                isSelected && "selected",
                dayItems.length > 0 && "has-items",
              ].filter(Boolean).join(" ")}
              onClick={() => setSelectedDay(dayItems.length > 0 ? key : null)}
            >
              <div className="cal-cell-num">{d.getDate()}</div>
              <div className="cal-cell-dots">
                {dayItems.slice(0, 4).map((it, i) => (
                  <span
                    key={i}
                    className="cal-dot"
                    style={{ background: companyColors.get(it.companyName ?? "(unassigned)") ?? "#999" }}
                    title={`${it.companyName ?? "Unassigned"} — ${it.action}`}
                  />
                ))}
                {dayItems.length > 4 && <span className="cal-dot-more">+{dayItems.length - 4}</span>}
              </div>
            </button>
          );
        })}
      </div>
      {selectedDay && selectedItems.length > 0 && (
        <div className="calendar-day-popout">
          <div className="cal-day-head">
            <span>{new Date(selectedDay).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</span>
            <button className="icon" onClick={() => setSelectedDay(null)} title="Close">{closeIcon}</button>
          </div>
          <ul className="cal-day-list">
            {selectedItems.map((it) => (
              <li key={it.id}>
                <span
                  className="cal-dot"
                  style={{ background: companyColors.get(it.companyName ?? "(unassigned)") ?? "#999" }}
                />
                <button
                  className="cal-item"
                  onClick={() => { setSelectedDay(null); onOpenMeeting(it.sessionId); }}
                  title="Open source meeting"
                >
                  <span className="cal-item-action">{it.action}</span>
                  <span className="cal-item-meta">
                    {it.companyName ?? "Unassigned"}
                    {it.owner ? ` · ${it.owner}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function isoDate(d: Date): string {
  // Local-time ISO date — matches what the Claude prompt resolves against.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Mirrors the server's synthetic catch-all entry (db/companies.ts) for
// meetings with no company. Read-only in the UI.
const UNSORTED_COMPANY_ID = "__unsorted__";

function PipelineList({
  pipeline,
  openMeetingId,
  onOpenMeeting,
  onUpdateStatus,
  onDelete,
}: {
  pipeline: PipelineEntry[];
  openMeetingId: string | null;
  onOpenMeeting: (sessionId: string) => void;
  onUpdateStatus: (id: string, status: CompanyStatus) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<"all" | CompanyStatus>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const visible = filter === "all" ? pipeline : pipeline.filter((c) => c.status === filter);

  if (pipeline.length === 0) {
    return (
      <div className="pipeline-list">
        <div className="history-empty">
          No companies yet. Start an interview with a company name and they'll show up here.
        </div>
      </div>
    );
  }

  return (
    <div className="pipeline-list">
      <div className="pipeline-filters">
        {(["all", "active", "paused", "offer", "rejected"] as const).map((f) => (
          <button
            key={f}
            className={filter === f ? "active" : ""}
            onClick={() => setFilter(f)}
          >{f === "all" ? "All" : capitalize(f)}</button>
        ))}
      </div>
      {visible.map((c) => {
        const isOpen = expanded.has(c.id);
        // Synthetic catch-all bucket for company-less meetings — read-only.
        const isUnsorted = c.id === UNSORTED_COMPANY_ID;
        return (
          <div key={c.id} className={`pipeline-row status-${c.status}${isOpen ? " expanded" : ""}${isUnsorted ? " unsorted" : ""}`}>
            <div
              className="pipeline-row-head"
              onClick={() => setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                return next;
              })}
            >
              <div className="pipeline-row-main">
                <div className="pipeline-row-title">{c.name}</div>
                <div className="pipeline-row-meta">
                  {c.latestStage && <span>{c.latestStage}</span>}
                  {c.latestStage && <span>·</span>}
                  <span>{c.sessionCount} {c.sessionCount === 1 ? "meeting" : "meetings"}</span>
                  {c.lastContactAt && <><span>·</span><span>{formatRelativeDate(c.lastContactAt)}</span></>}
                </div>
              </div>
              {!isUnsorted && (
                <StatusPill
                  status={c.status}
                  onChange={(s) => onUpdateStatus(c.id, s)}
                />
              )}
            </div>
            {isOpen && (
              <div className="pipeline-row-body">
                {c.nextSteps.length > 0 && (
                  <div className="pipeline-next-steps">
                    <div className="pipeline-section-title">Next steps</div>
                    <ul>{c.nextSteps.map((step, i) => <li key={i}>{step}</li>)}</ul>
                  </div>
                )}
                <div className="pipeline-sessions">
                  <div className="pipeline-section-title">Meetings</div>
                  {c.sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`pipeline-session-row${s.id === openMeetingId ? " active" : ""}`}
                      onClick={() => onOpenMeeting(s.id)}
                    >
                      <span className="title">{s.title}</span>
                      <span className="when">{formatRelativeDate(s.startedAt)}</span>
                    </button>
                  ))}
                </div>
                {!isUnsorted && (
                  <button
                    className="pipeline-delete"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!confirm(`Remove ${c.name} from the pipeline? (Meetings stay; they just get unlinked.)`)) return;
                      await onDelete(c.id);
                    }}
                  >Remove from pipeline</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatusPill({ status, onChange }: { status: CompanyStatus; onChange: (s: CompanyStatus) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const options: CompanyStatus[] = ["active", "paused", "offer", "rejected"];
  return (
    <div className="status-pill-wrapper" onClick={(e) => e.stopPropagation()}>
      <button className={`status-pill status-${status}`} onClick={() => setOpen((v) => !v)}>
        {capitalize(status)}
      </button>
      {open && (
        <div className="status-menu" onMouseLeave={() => setOpen(false)}>
          {options.map((s) => (
            <button
              key={s}
              className={s === status ? "active" : ""}
              onClick={async () => { setOpen(false); if (s !== status) await onChange(s); }}
            >{capitalize(s)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function formatRelativeDate(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const diffMs = now - ms;
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diffMs < 2 * day) return "Yesterday";
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StartInterviewModal({
  profile,
  onCancel,
  onConfirm,
}: {
  profile: Profile | null;
  onCancel: () => void;
  onConfirm: (targetCompany: string, jobDescription: string) => void;
}) {
  const [company, setCompany] = useState("");
  const [jd, setJd] = useState("");
  const submit = () => onConfirm(company, jd);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Start interview {profile ? <span className="dim">· {profile.name}</span> : null}</h2>
          <button className="icon" onClick={onCancel} title="Cancel">{closeIcon}</button>
        </div>
        <div className="modal-body">
          <p className="modal-sub">
            Paste the company name and job description below. Brandon will tailor answers to this specific role.
            Both fields are optional but strongly recommended.
          </p>
          <div className="field">
            <label>Company</label>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Stripe"
              autoFocus
            />
          </div>
          <div className="field">
            <label>Job description</label>
            <textarea
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              placeholder="Paste the JD here — what the team does, required skills, responsibilities, anything from the careers page that helps Claude understand the role."
              style={{ minHeight: 180 }}
            />
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit}>{playIcon}<span>Start</span></button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ onClose, currentUser, theme, onToggleTheme }: { onClose: () => void; currentUser: api.AuthUser; theme: Theme; onToggleTheme: () => void }) {
  const isAdmin = currentUser.role === "superadmin";
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="icon" onClick={onClose} title="Close">{closeIcon}</button>
        </div>
        <div className="modal-body">
          {/* Appearance: app theme (the overlay has its own theme in its gear menu). */}
          <div className="field">
            <label>Appearance</label>
            <div className="theme-choice">
              <button className={theme === "light" ? "active" : ""} onClick={() => { if (theme !== "light") onToggleTheme(); }}>
                {sunIcon}<span>Light</span>
              </button>
              <button className={theme === "dark" ? "active" : ""} onClick={() => { if (theme !== "dark") onToggleTheme(); }}>
                {moonIcon}<span>Dark</span>
              </button>
            </div>
          </div>
          {/* API keys: admins edit them; everyone else sees model availability. */}
          {isAdmin ? <AdminKeysSection /> : <ModelStatusSection />}
          <MyUsageSection />
          <GlobalDefaultsSection />
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Read-only model availability — shown to regular users. */
function ModelStatusSection() {
  const [keys, setKeys] = useState<api.KeyStatus | null>(null);
  useEffect(() => { api.getServerKeyStatus().then(setKeys).catch(() => {}); }, []);
  const line = (label: string, ok: boolean | undefined) => (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center", marginRight: 14 }}>
      <span style={{ color: ok ? "#4caf50" : "var(--text-soft)" }}>{ok ? "●" : "○"}</span>{label}
    </span>
  );
  return (
    <div className="field" style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
      <label>Models available</label>
      <div style={{ marginTop: 4 }}>
        {line("Claude", keys?.anthropicKeySet)}
        {line("GPT", keys?.openaiKeySet)}
        {line("Gemini", keys?.geminiKeySet)}
      </div>
      <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-soft)" }}>
        AI is provided by the server — no API key needed on your side.
      </div>
    </div>
  );
}

const PROVIDER_LABELS: { id: api.ProviderName; label: string; placeholder: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)", placeholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI (GPT)", placeholder: "sk-…" },
  { id: "gemini", label: "Google (Gemini)", placeholder: "AIza…" },
];

/** Editable shared provider keys — admin only. */
function AdminKeysSection() {
  const [keys, setKeys] = useState<api.ProviderKeys | null>(null);
  const reload = useCallback(() => { api.adminGetKeys().then(setKeys).catch(() => {}); }, []);
  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="field">
      <label>API keys (shared — used by everyone)</label>
      <div style={{ fontSize: 11.5, color: "var(--text-soft)", marginBottom: 8 }}>
        These keys power chat for all users. Stored on the server.
      </div>
      {PROVIDER_LABELS.map((p) => (
        <AdminKeyRow key={p.id} provider={p.id} label={p.label} placeholder={p.placeholder}
          info={keys?.[p.id]} onChanged={reload} />
      ))}
    </div>
  );
}

function AdminKeyRow({ provider, label, placeholder, info, onChanged }: {
  provider: api.ProviderName; label: string; placeholder: string;
  info: api.ProviderKeyInfo | undefined; onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true); setErr("");
    try { await api.adminSetKey(provider, key.trim() || null); setKey(""); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (!confirm(`Clear the ${label} key?`)) return;
    setBusy(true); setErr("");
    try { await api.adminSetKey(provider, null); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const status = !info || !info.set ? "not set"
    : info.source === "env" ? `from env · ${info.preview}` : `set · ${info.preview}`;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ color: info?.set ? "#4caf50" : "var(--text-soft)" }}>{status}</span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input type="password" value={key} placeholder={placeholder} spellCheck={false} autoComplete="off"
          onChange={(e) => setKey(e.target.value)} style={{ flex: 1 }} />
        <button className="primary" onClick={save} disabled={busy || !key.trim()}>{busy ? "…" : "Save"}</button>
        {info?.source === "db" && <button onClick={clear} disabled={busy} style={{ color: "var(--danger)" }}>Clear</button>}
      </div>
      {err && <div className="error" style={{ marginTop: 3 }}>{err}</div>}
    </div>
  );
}

/** Every user can see their own usage totals. */
function MyUsageSection() {
  const [u, setU] = useState<api.OwnUsage | null>(null);
  useEffect(() => { api.getMyUsage().then(setU).catch(() => {}); }, []);
  if (!u) return null;
  return (
    <div className="field" style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
      <label>Your usage</label>
      <div style={{ marginTop: 4 }}>
        {u.requests} requests · {fmtTokens(u.inputTokens)} in / {fmtTokens(u.outputTokens)} out
      </div>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Global defaults editor — set voice sample + interview brief once. The
 * prompt builder merges these into every profile (per-profile values still
 * override / append).
 */
function GlobalDefaultsSection() {
  const [voice, setVoice] = useState("");
  const [brief, setBrief] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const d = await api.getDefaults();
        setVoice(d.defaultVoiceSample ?? "");
        setBrief(d.defaultInterviewBrief ?? "");
        setLoaded(true);
      } catch (e) { setErr((e as Error).message); }
    })();
  }, []);

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api.saveDefaults({ defaultVoiceSample: voice, defaultInterviewBrief: brief });
      setDirty(false);
      setSavedAt(Date.now());
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const justSaved = savedAt !== null && Date.now() - savedAt < 1500;

  return (
    <div className="field" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 16 }}>
      <label style={{ fontWeight: 600 }}>Global defaults</label>
      <div style={{ fontSize: 11.5, color: "var(--text-soft)", marginTop: 2, marginBottom: 8 }}>
        Applied to every profile. The per-profile <em>voice sample</em> overrides this; per-profile
        <em> interview brief</em> appends to it. Enter your background + persona once here.
      </div>

      <label style={{ display: "block", fontSize: 12, color: "var(--text-soft)", marginTop: 8 }}>Default voice sample</label>
      <textarea
        value={voice}
        onChange={(e) => { setVoice(e.target.value); setDirty(true); }}
        placeholder="Paste 100-300 words in your own voice — Slack messages, cover-letter intro, anything natural. Claude mirrors this tone in every profile."
        style={{ width: "100%", minHeight: 90, marginTop: 4 }}
        disabled={!loaded}
      />

      <label style={{ display: "block", fontSize: 12, color: "var(--text-soft)", marginTop: 10 }}>Default interview brief</label>
      <textarea
        value={brief}
        onChange={(e) => { setBrief(e.target.value); setDirty(true); }}
        placeholder={"Background, persona, hard constraints — things true across every interview.\n\nExamples:\n• Born in US, Chinese parents, grew up between US and China.\n• Currently a senior eng at <Company>; want fully remote next.\n• Hobbies: violin, football, Assassin's Creed, Hans Zimmer."}
        style={{ width: "100%", minHeight: 140, marginTop: 4 }}
        disabled={!loaded}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <button className="primary" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save defaults"}
        </button>
        {justSaved && <span style={{ fontSize: 12, color: "var(--accent-text)" }}>Saved</span>}
      </div>
      {err && <div className="error" style={{ marginTop: 4 }}>{err}</div>}
    </div>
  );
}

function WelcomePane({ activeProfile, onStart, disabled }: { activeProfile: Profile | null; onStart: () => void; disabled?: boolean }) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>Brandon</h1>
        <p className="welcome-sub">
          {activeProfile
            ? <>Ready to interview as <strong>{activeProfile.name}</strong>. Pick a past meeting from the left, or start a new one.</>
            : <>No active mode. Open <em>Manage modes</em> to set one up.</>}
        </p>
        <button className="start-cta large" onClick={onStart} disabled={!activeProfile || !!disabled}>
          {playIcon}
          <span>Start interview</span>
        </button>
      </div>
    </div>
  );
}

function MeetingDetail({
  sessionId,
  profiles,
  onBack,
}: {
  sessionId: string;
  profiles: Profile[];
  onBack: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setSession(await api.getSession(sessionId)); }
    catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const regenerateRecap = useCallback(async () => {
    setGenerating(true); setError("");
    try { setSession(await api.generateRecap(sessionId)); }
    catch (err) { setError((err as Error).message); }
    finally { setGenerating(false); }
  }, [sessionId]);

  // Auto-generate a recap the first time you open a meeting that has a
  // transcript but no recap yet, so you don't have to manually click.
  useEffect(() => {
    if (!session) return;
    if (session.recap) return;
    if (!session.transcript || session.transcript.trim().length < 10) return;
    if (generating) return;
    let cancelled = false;
    setGenerating(true);
    api.generateRecap(sessionId)
      .then((s) => { if (!cancelled) setSession(s); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setGenerating(false); });
    return () => { cancelled = true; };
  }, [session?.id, session?.transcript, session?.recap]);

  if (loading) {
    return (
      <div className="meeting-detail">
        <div className="meeting-detail-header">
          <button className="icon" onClick={onBack} title="Back">{backIcon}</button>
        </div>
        <div className="status" style={{ padding: 24 }}>Loading…</div>
      </div>
    );
  }
  if (!session) return <div className="meeting-detail"><div className="error">Meeting not found.</div></div>;

  const owner = profiles.find((p) => p.id === session.profileId);
  const ended = session.endedAt !== null;
  const duration = ended ? formatDuration(session.endedAt! - session.startedAt) : "in progress";
  const canRecap = !!session.transcript && session.transcript.trim().length > 10;

  return (
    <div className="meeting-detail">
      <div className="meeting-detail-header">
        <button className="icon" onClick={onBack} title="Back to Home">{backIcon}</button>
        <div className="meeting-detail-title">
          <h2>{session.title}</h2>
          <div className="meeting-detail-meta">
            {owner && <span>{owner.name}</span>}
            {owner && <span>·</span>}
            <span>{formatFullDateTime(session.startedAt)}</span>
            <span>·</span>
            <span>{duration}</span>
          </div>
        </div>
        {session.priorTurnsJson && (
          <button
            className="primary"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              try {
                const turns = JSON.parse(session.priorTurnsJson ?? "[]");
                if (!Array.isArray(turns) || turns.length === 0) {
                  setError("No saved conversation to resume in this meeting.");
                  return;
                }
                bridge.resumeOverlay(turns);
                bridge.hideMainWindow();
              } catch (e) {
                setError("Couldn't parse the saved conversation: " + (e as Error).message);
              }
            }}
            title="Re-open the overlay with this meeting's Q&A loaded as priorTurns — Brandon will remember what was discussed"
          >
            ▶ Resume conversation
          </button>
        )}
      </div>

      {error && <div className="error" style={{ padding: "8px 24px" }}>{error}</div>}

      <div className="meeting-detail-body">
        <section className="meeting-section recap">
          <div className="section-header">
            <h3>Recap</h3>
            <button
              className="outlined"
              onClick={regenerateRecap}
              disabled={generating || !canRecap}
              title={canRecap ? "Generate (or refresh) a Claude recap" : "Need a transcript to summarise"}
            >{generating ? "Generating…" : (session.recap ? "Regenerate" : "Generate recap")}</button>
          </div>
          {session.recap
            ? <div className="recap-body"><Markdown>{session.recap}</Markdown></div>
            : <div className="empty-inline">{canRecap
                ? "No recap yet — click Generate to summarise this conversation."
                : "No transcript captured for this meeting, so a recap isn't possible."}</div>
          }
        </section>

        <section className="meeting-section transcript">
          <div className="section-header"><h3>Transcript</h3></div>
          {session.transcript
            ? <div className="transcript-body">{session.transcript}</div>
            : <div className="empty-inline">No transcript captured.</div>
          }
        </section>
      </div>
    </div>
  );
}

function formatFullDateTime(t: number): string {
  return new Date(t).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

interface SessionGroup { label: string; items: Session[]; }
function groupSessionsByDay(sessions: Session[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const now = new Date();
  const today = new Date(now); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  for (const s of sessions) {
    const d = new Date(s.startedAt);
    const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
    let label: string;
    if (dayStart.getTime() === today.getTime()) label = "Today";
    else if (dayStart.getTime() === yesterday.getTime()) label = "Yesterday";
    else label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(s);
    else groups.push({ label, items: [s] });
  }
  return groups;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ProfileEditor({
  profile,
  onChanged,
  onActivate,
  onDelete,
  onStart,
}: {
  profile: ProfileWithFiles;
  onChanged: () => Promise<void>;
  onActivate: () => Promise<void>;
  onDelete: () => Promise<void>;
  onStart: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [prompt, setPrompt] = useState(profile.realtimePrompt);
  const [notes, setNotes] = useState(profile.notesTemplate ?? "");
  const [model, setModel] = useState(profile.model);
  const [fullName, setFullName] = useState(profile.fullName ?? "");
  const [jobTitle, setJobTitle] = useState(profile.jobTitle ?? "");
  const [company, setCompany] = useState(profile.company ?? "");
  const [location, setLocation] = useState(profile.location ?? "");
  const [voiceSample, setVoiceSample] = useState(profile.voiceSample ?? "");
  const [interviewBrief, setInterviewBrief] = useState(profile.interviewBrief ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [localError, setLocalError] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.listSessions(profile.id).then((s) => { if (!cancelled) setSessions(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [profile.id, savedAt]);

  useEffect(() => {
    setName(profile.name);
    setPrompt(profile.realtimePrompt);
    setNotes(profile.notesTemplate ?? "");
    setModel(profile.model);
    setFullName(profile.fullName ?? "");
    setJobTitle(profile.jobTitle ?? "");
    setCompany(profile.company ?? "");
    setLocation(profile.location ?? "");
    setVoiceSample(profile.voiceSample ?? "");
    setInterviewBrief(profile.interviewBrief ?? "");
    setDirty(false);
  }, [profile.id]);

  useEffect(() => {
    const changed =
      name !== profile.name ||
      prompt !== profile.realtimePrompt ||
      notes !== (profile.notesTemplate ?? "") ||
      model !== profile.model ||
      fullName !== (profile.fullName ?? "") ||
      jobTitle !== (profile.jobTitle ?? "") ||
      company !== (profile.company ?? "") ||
      location !== (profile.location ?? "") ||
      voiceSample !== (profile.voiceSample ?? "") ||
      interviewBrief !== (profile.interviewBrief ?? "");
    setDirty(changed);
  }, [name, prompt, notes, model, fullName, jobTitle, company, location, voiceSample, interviewBrief, profile]);

  const save = useCallback(async () => {
    setBusy(true);
    setLocalError("");
    try {
      await api.updateProfile(profile.id, {
        name,
        realtimePrompt: prompt,
        notesTemplate: notes || null,
        model: model as Profile["model"],
        fullName: fullName || null,
        jobTitle: jobTitle || null,
        company: company || null,
        location: location || null,
        voiceSample: voiceSample || null,
        interviewBrief: interviewBrief || null,
      });
      setSavedAt(Date.now());
      await onChanged();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [profile.id, name, prompt, notes, model, fullName, jobTitle, company, location, voiceSample, interviewBrief, onChanged]);

  const onUpload = useCallback(async (file: File) => {
    setBusy(true); setLocalError("");
    try { await api.uploadFile(profile.id, file); await onChanged(); }
    catch (err) { setLocalError((err as Error).message); }
    finally { setBusy(false); }
  }, [profile.id, onChanged]);

  const onDeleteFile = useCallback(async (fileId: string) => {
    if (!confirm("Remove this reference file?")) return;
    setBusy(true);
    try { await api.deleteFile(fileId); await onChanged(); }
    catch (err) { setLocalError((err as Error).message); }
    finally { setBusy(false); }
  }, [onChanged]);

  const justSaved = savedAt !== null && Date.now() - savedAt < 1500;

  return (
    <div className="editor-body">
      <div className="editor-header">
        <input
          className="title-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (dirty && !busy) save(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
          }}
        />
        <button
          className="outlined"
          onClick={save}
          disabled={!dirty || busy}
          style={{ minWidth: 70 }}
          title="Save changes (Enter)"
        >{busy ? "Saving…" : justSaved ? "Saved" : "Save"}</button>
        <button className="primary start-interview" onClick={onStart}>
          {playIcon}
          <span>Start interview</span>
        </button>
        {profile.isActive ? (
          <span className="pill-active">{checkIcon} Active</span>
        ) : (
          <button className="pill-inactive" onClick={onActivate}>Set Active</button>
        )}
        <div style={{ position: "relative" }}>
          <button className="icon" onClick={() => setMenuOpen((v) => !v)} title="Menu">{moreIcon}</button>
          {menuOpen && (
            <div
              style={{
                position: "absolute", top: "100%", right: 0,
                background: "var(--bg-card)", border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)", boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                padding: "6px", minWidth: 160, zIndex: 10,
              }}
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button
                onClick={async () => { setMenuOpen(false); await save(); }}
                disabled={!dirty || busy}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px" }}
              >Save changes</button>
              <button
                onClick={async () => { setMenuOpen(false); await onDelete(); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", color: "var(--danger)" }}
              >Delete mode</button>
            </div>
          )}
        </div>
      </div>

      <div className="meetings-section">
        <div className="label">Recent meetings</div>
        {sessions.length === 0 ? (
          <div className="empty-meetings">No meetings yet. Click <strong>Start interview</strong> to begin.</div>
        ) : (
          <div className="meeting-list">
            {sessions.slice(0, 8).map((s) => (
              <div className="meeting-row" key={s.id}>
                <span className="meeting-title">{s.title || "Untitled meeting"}</span>
                <span className="meeting-time">{formatMeetingTime(s.startedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Real-time prompt</span>
          <button
            className="outlined"
            type="button"
            onClick={() => setPrompt(DEFAULT_REALTIME_PROMPT)}
            title="Replace the prompt with Brandon's default — keeps voice/persona consistent across modes"
            style={{ fontSize: 11.5, padding: "3px 10px" }}
          >Reset to default</button>
        </div>
        <div className="prompt-card">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={"You are me in a job interview.\n\nContext\n\nI'll give you:\n- The job description\n- My resume is attached"}
          />
          <div className="save-row">
            {justSaved && <span>Saved</span>}
            <button className="outlined" onClick={save} disabled={!dirty || busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="label">Reference files</div>
        <div className="section-files">
          {profile.files.map((f) => (
            <div className="file-card" key={f.id}>
              <span className="file-icon">{fileIcon}</span>
              <div className="file-meta">
                <div className="file-name">{f.filename}</div>
                <div className="file-size">{(f.size / 1024).toFixed(0)} KB</div>
              </div>
              <button className="icon" onClick={() => onDeleteFile(f.id)} title="Remove">{trashIcon}</button>
            </div>
          ))}
          <input
            ref={fileInputRef}
            type="file"
            accept={SUPPORTED_EXTENSIONS}
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = "";
            }}
          />
          <button className="upload-link" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            {paperclipIcon}
            <span>{busy ? "Working…" : "Upload additional file"}</span>
          </button>
        </div>
      </div>

      <div>
        <div className="label">Notes template</div>
        <div className="prompt-card">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ minHeight: 100 }}
            placeholder="Optional notes the model can reference."
          />
        </div>
      </div>

      <div>
        <div className="label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Identity (shown in the overlay footer)</span>
          <button
            className="outlined"
            disabled={busy || profile.files.length === 0}
            onClick={async () => {
              setBusy(true);
              setLocalError("");
              try {
                const updated = await api.extractIdentity(profile.id);
                setFullName(updated.fullName ?? "");
                setJobTitle(updated.jobTitle ?? "");
                setCompany(updated.company ?? "");
                setLocation(updated.location ?? "");
                await onChanged();
              } catch (err) {
                setLocalError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            title="Use Claude to extract title/company/location from the uploaded résumé"
          >{busy ? "Extracting…" : "Auto-fill from résumé"}</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Full name (e.g. Dalton Do)"
          />
          <input
            type="text"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder="Job title (e.g. Senior SWE)"
          />
          <input
            type="text"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Company (e.g. DoorDash)"
          />
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location (e.g. Sunnyvale, CA)"
          />
        </div>
      </div>

      <div>
        <div className="label">
          Voice sample
          <span style={{ marginLeft: 8, fontWeight: 400, color: "var(--text-soft)", fontSize: 12 }}>
            (a paragraph in your own words — Slack message, cover-letter intro, anything you wrote naturally. Claude mirrors this to sound like you.)
          </span>
        </div>
        <div className="prompt-card">
          <textarea
            value={voiceSample}
            onChange={(e) => setVoiceSample(e.target.value)}
            style={{ minHeight: 100 }}
            placeholder="Yeah so when I was at DoorDash, we ran into this thing where… (paste 100-300 words of something you actually wrote — texts, emails, notes are all fine)"
          />
        </div>
      </div>

      <div>
        <div className="label">
          Interview brief
          <span style={{ marginLeft: 8, fontWeight: 400, color: "var(--text-soft)", fontSize: 12 }}>
            (your specific narrative — what you want, why you're leaving, key wins, hard constraints. Used verbatim when the interviewer asks meta-questions.)
          </span>
        </div>
        <div className="prompt-card">
          <textarea
            value={interviewBrief}
            onChange={(e) => setInterviewBrief(e.target.value)}
            style={{ minHeight: 140 }}
            placeholder={`Examples of what to put here:

• What I want next: Fully remote, smaller team, more end-to-end product ownership.
• Why I'm leaving DoorDash: Been here ~3 years, learned a lot, shipped <thing>. Next chapter I want is <X>, which isn't really on the roadmap at my current scope.
• Top accomplishment to lead with: <The one project you're proudest of — names + numbers>.
• Hard constraints: Fully remote only. Available to start in 6 weeks.
• Avoid mentioning: <anything you don't want Claude to bring up>`}
          />
        </div>
      </div>

      <div>
        <div className="label">Model</div>
        <select value={model} onChange={(e) => setModel(e.target.value as Profile["model"])} style={{ width: 320 }}>
          <optgroup label="Anthropic">
            <option value="claude-opus-4-8">Claude Opus 4.8</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-opus-4-7">Claude Opus 4.7</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
          </optgroup>
          <optgroup label="OpenAI">
            <option value="gpt-5.5">GPT-5.5</option>
          </optgroup>
          <optgroup label="Google">
            <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (preview)</option>
            <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
          </optgroup>
        </select>
        <div style={{ fontSize: 11.5, color: "var(--text-soft)", marginTop: 4 }}>
          The provider key must be set in Settings for the chosen model to work.
        </div>
      </div>

      {localError && <div className="error">{localError}</div>}
    </div>
  );
}

function formatMeetingTime(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const checkIcon = (<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.2 3.2L13 4.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const plusIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>);
const closeIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>);
const moreIcon = (<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="13" cy="8" r="1.4" fill="currentColor"/></svg>);
const docIcon = (<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 2.5h5.5L13 6v7.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-10a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M9.5 2.5V6H13" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>);
const templateIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="4" r="1.4" fill="currentColor"/><circle cx="12" cy="4" r="1.4" fill="currentColor"/><circle cx="4" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>);
const fileIcon = (<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M4 2.5h5.5L13 6v7.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-10a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M9.5 2.5V6H13" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>);
const trashIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5M4.5 4.5l.6 8.6a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-8.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const pencilIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const copyIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3 11V3a1 1 0 011-1h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>);
const paperclipIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 7l-4.7 4.7a2 2 0 01-2.8-2.8L8.7 4.2a3 3 0 014.2 4.2L8 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const playIcon = (<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 3l9 5-9 5V3z" fill="currentColor"/></svg>);
const refreshIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13 8a5 5 0 11-1.5-3.5L13 3v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>);
const backIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const chevronDownIcon = (<svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const gearIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>);
const chatIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 3.5h11v7h-7l-4 3v-3h0v-7z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>);
const moonIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 102 10.5 5.52 5.52 0 004.5-4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>);
const sunIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M13 3l-1 1M4 12l-1 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>);
const sendIconUp = (<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>);

/* ───────────────────────── Auth gate ──────────────────────────────────── */

type AuthState =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "offline" }   // have a token, but the server is unreachable — DON'T log out
  | { kind: "authed"; user: api.AuthUser };

/** Top-level wrapper: decides between login / pending / the real app based on
 *  the stored JWT and the server's view of the user (status is live from DB). */
export function App() {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  const check = useCallback(async () => {
    const token = await bridge.getToken();
    if (!token) { setState({ kind: "anon" }); return; }
    try {
      const user = await api.me();
      setState({ kind: "authed", user });
    } catch (e) {
      // Distinguish "not authorized" (token bad → login) from "can't reach the
      // server" (network/timeout → keep the token, show offline + retry). The
      // server is in the US and users connect from anywhere, so a slow/dropped
      // request must NOT silently log them out.
      if ((e as Error).message === "Unauthorized") setState({ kind: "anon" });
      else setState({ kind: "offline" });
    }
  }, []);

  useEffect(() => {
    api.setUnauthorizedHandler(() => { api.logout(); setState({ kind: "anon" }); });
    check();
  }, [check]);

  // While pending OR offline, poll so we recover automatically (admin approval,
  // or the server/network coming back).
  useEffect(() => {
    const polling = state.kind === "offline" || (state.kind === "authed" && state.user.status === "pending");
    if (!polling) return;
    const t = setInterval(check, 4000);
    return () => clearInterval(t);
  }, [state, check]);

  if (state.kind === "loading") {
    return <div className="auth-screen"><div className="auth-card">Connecting…</div></div>;
  }
  if (state.kind === "offline") {
    return (
      <div className="auth-screen"><div className="auth-card">
        <h1>Can't reach the server</h1>
        <p>Brandon couldn't connect. Retrying automatically… check your connection or the server URL.</p>
        <button className="primary" onClick={check}>Retry now</button>
        <button onClick={() => { api.logout(); setState({ kind: "anon" }); }}>Log out</button>
      </div></div>
    );
  }
  if (state.kind === "anon") {
    return <LoginScreen onAuthed={(user) => setState({ kind: "authed", user })} />;
  }
  // authed
  const logout = () => { api.logout(); setState({ kind: "anon" }); };
  if (state.user.status === "disabled") {
    return (
      <div className="auth-screen"><div className="auth-card">
        <h1>Account disabled</h1>
        <p>This account has been disabled. Contact the administrator.</p>
        <button className="primary" onClick={logout}>Log out</button>
      </div></div>
    );
  }
  if (state.user.status === "pending") {
    return (
      <div className="auth-screen"><div className="auth-card">
        <h1>Awaiting approval</h1>
        <p>Your account (<strong>{state.user.email}</strong>) is pending approval by the administrator.
           This page will update automatically once you're approved.</p>
        <button onClick={logout}>Log out</button>
      </div></div>
    );
  }
  return <MainApp currentUser={state.user} onLogout={logout} />;
}

function LoginScreen({ onAuthed }: { onAuthed: (user: api.AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    getConfig().then((c) => setServerUrl(c.serverBase)).catch(() => {});
  }, []);

  const saveServer = () => {
    bridge.setServerBase(serverUrl.trim());
    resetConfigCache();
    setShowServer(false);
  };

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const fn = mode === "login" ? api.login : api.signup;
      const { user } = await fn(email.trim(), password);
      onAuthed(user);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandonMark size={52} />
          <h1>Brandon</h1>
        </div>
        <p className="auth-sub">{mode === "login" ? "Sign in to your account" : "Create an account"}</p>
        <input type="email" placeholder="Email" value={email} autoFocus
          onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <input type="password" placeholder="Password (min 8 chars)" value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <div className="error">{err}</div>}
        <button className="primary" onClick={submit} disabled={busy || !email || !password}>
          {busy ? "…" : mode === "login" ? "Log in" : "Sign up"}
        </button>
        <div className="auth-switch">
          {mode === "login" ? (
            <>No account? <button className="linklike" onClick={() => { setMode("signup"); setErr(""); }}>Sign up</button></>
          ) : (
            <>Have an account? <button className="linklike" onClick={() => { setMode("login"); setErr(""); }}>Log in</button></>
          )}
        </div>
        {mode === "signup" && (
          <p className="auth-note">New accounts need administrator approval before you can use the AI.</p>
        )}
        <div className="auth-server">
          {showServer ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://localhost:8787" style={{ flex: 1 }} />
              <button onClick={saveServer}>Save</button>
            </div>
          ) : (
            <button className="linklike" onClick={() => setShowServer(true)}>Server: {serverUrl || "…"}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminPanel({ onClose, currentUserId }: { onClose: () => void; currentUserId: string }) {
  const [tab, setTab] = useState<"users" | "usage">("users");
  const [users, setUsers] = useState<api.AuthUser[]>([]);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api.adminListUsers().then(setUsers).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<void>) => {
    setErr("");
    try { await fn(); load(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 660 }}>
        <div className="modal-header">
          <h2>Admin</h2>
          <button className="icon" onClick={onClose} title="Close">{closeIcon}</button>
        </div>
        <div className="admin-tabs">
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>Users</button>
          <button className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>Usage</button>
        </div>
        <div className="modal-body">
          {err && <div className="error">{err}</div>}
          {tab === "users" ? (
            <table className="admin-users">
              <thead><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>{u.role}</td>
                    <td>{u.status}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {u.status === "pending" && (
                        <button className="primary" onClick={() => act(() => api.adminApprove(u.id))}>Approve</button>
                      )}
                      {u.status === "active" && u.id !== currentUserId && (
                        <button onClick={() => act(() => api.adminDisable(u.id))} style={{ color: "var(--danger)" }}>Disable</button>
                      )}
                      {u.status === "disabled" && (
                        <button onClick={() => act(() => api.adminApprove(u.id))}>Re-enable</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <AdminUsageTab />
          )}
        </div>
        <div className="modal-actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function AdminUsageTab() {
  const [rows, setRows] = useState<api.UsageTotals[] | null>(null);
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [calls, setCalls] = useState<api.UsageCall[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => { api.adminGetUsage().then(setRows).catch((e) => setErr((e as Error).message)); }, []);
  const drill = async (userId: string) => {
    if (openUser === userId) { setOpenUser(null); return; }
    setOpenUser(userId);
    try { setCalls(await api.adminGetUserCalls(userId)); } catch (e) { setErr((e as Error).message); }
  };

  if (err) return <div className="error">{err}</div>;
  if (!rows) return <div style={{ color: "var(--text-dim)" }}>Loading…</div>;
  if (rows.length === 0) return <div style={{ color: "var(--text-dim)" }}>No usage yet.</div>;

  return (
    <table className="admin-users">
      <thead><tr><th>User</th><th>Requests</th><th>In</th><th>Out</th><th>Last used</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <Fragment key={r.userId}>
            <tr style={{ cursor: "pointer" }} onClick={() => drill(r.userId)}>
              <td>{r.email}</td>
              <td>{r.requests}</td>
              <td>{fmtTokens(r.inputTokens)}</td>
              <td>{fmtTokens(r.outputTokens)}</td>
              <td>{r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleDateString() : "—"}</td>
            </tr>
            {openUser === r.userId && (
              <tr>
                <td colSpan={5} style={{ background: "var(--bg-panel)", fontSize: 11.5 }}>
                  {calls.length === 0 ? "No calls." : calls.map((c) => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                      <span>{c.model}</span>
                      <span>{fmtTokens(c.inputTokens)} / {fmtTokens(c.outputTokens)}</span>
                      <span style={{ color: "var(--text-soft)" }}>{new Date(c.createdAt).toLocaleString()}</span>
                    </div>
                  ))}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/* ───────────────── Interviews pane content (company pipeline) ──────────── */
function InterviewsContent({
  pipeline, openMeetingId, onOpenMeeting, onUpdateCompanyStatus, onDeleteCompany,
}: {
  pipeline: PipelineEntry[];
  openMeetingId: string | null;
  onOpenMeeting: (id: string) => void;
  onUpdateCompanyStatus: (id: string, status: CompanyStatus) => Promise<void>;
  onDeleteCompany: (id: string) => Promise<void>;
}) {
  return (
    <div className="interviews-content">
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <PipelineList pipeline={pipeline} openMeetingId={openMeetingId} onOpenMeeting={onOpenMeeting}
          onUpdateStatus={onUpdateCompanyStatus} onDelete={onDeleteCompany} />
      </div>
    </div>
  );
}

/* ───────────────── ChatGPT-style unified shell (chat + panes) ──────────── */

interface ChatMsg { id: string; role: "user" | "assistant"; content: string; }

function ChatShell({
  pane, setPane, profiles, activeProfile, currentUser, theme, detectable,
  onToggleDetectable, onToggleTheme, onOpenSettings, onOpenAdmin, onLogout, onShrinkToOverlay,
  sessions, pipeline, agenda, openMeetingId, onOpenMeeting, onCloseMeeting,
  onUpdateCompanyStatus, onDeleteCompany,
  selectedModeId, modeDetail, onSelectMode, onCreateMode, reloadModeDetail,
  refreshProfiles, onStartInterview, onPickActive, error, setError,
}: {
  pane: View;
  setPane: (v: View) => void;
  profiles: Profile[];
  activeProfile: Profile | null;
  currentUser: api.AuthUser;
  theme: Theme;
  detectable: boolean;
  onToggleDetectable: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
  onShrinkToOverlay: () => void;
  sessions: Session[];
  pipeline: PipelineEntry[];
  agenda: AgendaItem[];
  openMeetingId: string | null;
  onOpenMeeting: (id: string) => void;
  onCloseMeeting: () => void;
  onUpdateCompanyStatus: (id: string, status: CompanyStatus) => Promise<void>;
  onDeleteCompany: (id: string) => Promise<void>;
  selectedModeId: string | null;
  modeDetail: ProfileWithFiles | null;
  onSelectMode: (id: string) => void;
  onCreateMode: () => void;
  reloadModeDetail: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  onStartInterview: (id: string) => void;
  onPickActive: (id: string) => Promise<void>;
  error: string;
  setError: (s: string) => void;
}) {
  const [convos, setConvos] = useState<import("@brandon/shared").Conversation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<import("../lib/image").PendingImage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  // Which mode row's "⋯" menu is open (id), and inline-rename state for modes.
  const [modeMenu, setModeMenu] = useState<string | null>(null);
  const [modeRenaming, setModeRenaming] = useState<string | null>(null);
  const [modeRenameText, setModeRenameText] = useState("");
  // The mode the NEXT new chat will use: a profile id, PLAIN, or "" = active mode.
  const [pickMode, setPickMode] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConvos = useCallback(async () => {
    try { setConvos(await api.listConversations()); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { loadConvos(); }, [loadConvos]);

  const openConvo = useCallback(async (id: string) => {
    setOpenId(id); setErr(""); setPane("chat");
    try {
      const { messages: msgs } = await api.getConversation(id);
      setMessages(msgs.map((m) => ({ id: m.id, role: m.role, content: m.content })));
    } catch (e) { setErr((e as Error).message); }
  }, [setPane]);

  const newChat = useCallback(() => { setOpenId(null); setMessages([]); setInput(""); setImages([]); setErr(""); setPane("chat"); }, [setPane]);

  const removeConvo = useCallback(async (id: string) => {
    if (!confirm("Delete this chat?")) return;
    try {
      await api.deleteConversation(id);
      if (openId === id) newChat();
      await loadConvos();
    } catch (e) { setErr((e as Error).message); }
  }, [openId, loadConvos, newChat]);

  const commitRename = useCallback(async (id: string) => {
    const title = renameText.trim();
    setRenaming(null);
    if (!title) return;
    try { await api.renameConversation(id, title); await loadConvos(); }
    catch (e) { setErr((e as Error).message); }
  }, [renameText, loadConvos]);

  // ── Mode (GPT-style) management: activate, rename, delete ─────────────────
  const activateMode = useCallback(async (id: string) => {
    setModeMenu(null);
    try { await api.activateProfile(id); await refreshProfiles(); }
    catch (e) { setError((e as Error).message); }
  }, [refreshProfiles, setError]);

  const commitModeRename = useCallback(async (id: string) => {
    const name = modeRenameText.trim();
    setModeRenaming(null);
    if (!name) return;
    try { await api.updateProfile(id, { name }); await refreshProfiles(); if (selectedModeId === id) await reloadModeDetail(); }
    catch (e) { setError((e as Error).message); }
  }, [modeRenameText, refreshProfiles, reloadModeDetail, selectedModeId, setError]);

  const deleteMode = useCallback(async (id: string, name: string) => {
    setModeMenu(null);
    if (!confirm(`Delete mode "${name || "Untitled"}" and its files?`)) return;
    try {
      await api.deleteProfile(id);
      if (selectedModeId === id) { onSelectMode(""); setPane("chat"); }
      await refreshProfiles();
    } catch (e) { setError((e as Error).message); }
  }, [selectedModeId, onSelectMode, setPane, refreshProfiles, setError]);

  // Paste images into the composer.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const imgs = imagesFromClipboard(e);
      if (!imgs.length) return;
      e.preventDefault();
      const conv = await Promise.all(imgs.map(fileToImage));
      setImages((prev) => [...prev, ...conv]);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Reload messages from the server (to pick up real ids after a turn so edit
  // can target a persisted message).
  const reloadMessages = useCallback(async (convId: string) => {
    try {
      const { messages: msgs } = await api.getConversation(convId);
      setMessages(msgs.map((m) => ({ id: m.id, role: m.role, content: m.content })));
    } catch { /* keep optimistic state on failure */ }
  }, []);

  // Core send: stream a reply for `text` (+ images) in conversation `convId`.
  const runSend = useCallback(async (convId: string, text: string, imgs: { mediaType: string; data: string }[]) => {
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: text || "📷 image" }, { id: `a-${Date.now()}`, role: "assistant", content: "" }]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";
    try {
      await api.streamConversationMessage(convId, text || "(see image)", { images: imgs }, {
        onText: (t) => {
          acc += t;
          setMessages((m) => { const copy = [...m]; copy[copy.length - 1] = { ...copy[copy.length - 1], content: acc }; return copy; });
        },
        onDone: () => { setStreaming(false); loadConvos(); reloadMessages(convId); },
        onError: (msg) => { setErr(msg); setStreaming(false); },
      }, controller.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      setStreaming(false);
    }
  }, [loadConvos, reloadMessages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && images.length === 0) || streaming) return;
    setErr("");
    let convId = openId;
    if (!convId) {
      try {
        const c = await api.createConversation(pickMode === "" ? undefined : pickMode);
        convId = c.id; setOpenId(c.id);
      } catch (e) { setErr((e as Error).message); return; }
    }
    const imgs = images.map((im) => ({ mediaType: im.mediaType, data: im.data }));
    setInput(""); setImages([]);
    await runSend(convId!, text, imgs);
  }, [input, images, streaming, openId, pickMode, runSend]);

  // Copy a message to the clipboard, with a brief "copied" tick on that row.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyMsg = useCallback((id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId(null), 1400);
    }).catch(() => { /* clipboard unavailable */ });
  }, []);

  // Edit a previously-sent user message: truncate it + everything after on the
  // server, then re-send the edited text (ChatGPT-style replace + regenerate).
  const [editingMsg, setEditingMsg] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const commitEditMsg = useCallback(async (messageId: string) => {
    const text = editText.trim();
    setEditingMsg(null);
    if (!text || !openId || streaming) return;
    setErr("");
    // Drop the edited message + everything after, locally and on the server.
    setMessages((m) => { const i = m.findIndex((x) => x.id === messageId); return i === -1 ? m : m.slice(0, i); });
    try {
      // Only persisted (server-id) messages can be truncated; optimistic ids
      // (u-/a- prefixes) only exist pre-reload, in which case slicing locally is enough.
      if (!/^[ua]-\d/.test(messageId)) await api.truncateConversationFrom(openId, messageId);
    } catch (e) { setErr((e as Error).message); return; }
    await runSend(openId, text, []);
  }, [editText, openId, streaming, runSend]);

  const filtered = convos.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));
  const modeLabel = pickMode === api.PLAIN_MODE ? "Plain assistant"
    : pickMode ? (profiles.find((p) => p.id === pickMode)?.name ?? "Mode")
    : (activeProfile ? `${activeProfile.name} (active)` : "Plain assistant");

  return (
    <div className="chat-layout">
      <aside className="history-sidebar">
        <div className="history-sidebar-top">
          <div className="brand-row">
            <span className="brand-lockup">
              <BrandonMark size={26} className="brand-mark" />
              <span className="brand-label">Brandon</span>
            </span>
            <button className="theme-toggle" onClick={onToggleTheme} title={theme === "light" ? "Switch to dark" : "Switch to light"}>
              {theme === "light" ? moonIcon : sunIcon}
            </button>
          </div>
          <button className="new-chat-btn" onClick={newChat}>{plusIcon}<span>New chat</span></button>
          <button
            className="new-chat-btn secondary"
            onClick={() => { if (activeProfile) onStartInterview(activeProfile.id); }}
            disabled={!activeProfile}
            title={activeProfile ? "Start a live interview with the active mode" : "Set an active mode first"}
          >▶<span>New interview</span></button>
          <input className="sidebar-search" placeholder="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {/* Modes — sit directly under New chat. Clicking swaps the RIGHT PANE. */}
        <div className="sidebar-section">
          <div className="sidebar-section-title">Modes</div>
          {profiles.map((p) => (
            <div
              key={p.id}
              className={`mode-row${pane === "modes" && selectedModeId === p.id ? " active" : ""}`}
              onClick={() => { onSelectMode(p.id); setPane("modes"); }}
            >
              <span className="mode-row-icon" aria-hidden>{(p.name || "U").trim().charAt(0).toUpperCase()}</span>
              {modeRenaming === p.id ? (
                <input
                  className="rename-input" autoFocus value={modeRenameText}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setModeRenameText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") commitModeRename(p.id); if (e.key === "Escape") setModeRenaming(null); }}
                  onBlur={() => commitModeRename(p.id)}
                />
              ) : (
                <span className="mode-row-name">{p.name || "Untitled"}</span>
              )}
              {p.isActive && <span className="mode-row-badge" title="Active mode">Active</span>}
              <div className="mode-row-menu-wrap" onClick={(e) => e.stopPropagation()}>
                <button
                  className="mode-row-more"
                  title="Mode options"
                  onClick={() => setModeMenu((m) => (m === p.id ? null : p.id))}
                >{moreIcon}</button>
                {modeMenu === p.id && (
                  <div className="mode-menu" onMouseLeave={() => setModeMenu(null)}>
                    {!p.isActive && <button onClick={() => activateMode(p.id)}>Set active</button>}
                    <button onClick={() => { setModeMenu(null); onSelectMode(p.id); setPane("modes"); }}>Edit</button>
                    <button onClick={() => { setModeMenu(null); setModeRenaming(p.id); setModeRenameText(p.name || ""); }}>Rename</button>
                    <button className="danger" onClick={() => deleteMode(p.id, p.name)}>Delete</button>
                  </div>
                )}
              </div>
            </div>
          ))}
          <button className="mode-row new" onClick={onCreateMode}>
            <span className="mode-row-icon plus" aria-hidden>+</span>
            <span className="mode-row-name">New mode</span>
          </button>
        </div>

        <div className="history-list">
          {filtered.length === 0 && <div className="history-empty">{search ? "No matches." : "No chats yet."}</div>}
          {filtered.map((c) => (
            <div key={c.id} className={`history-row chat-row${c.id === openId ? " active" : ""}`} onClick={() => openConvo(c.id)}>
              {renaming === c.id ? (
                <input className="rename-input" autoFocus value={renameText}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") commitRename(c.id); if (e.key === "Escape") setRenaming(null); }}
                  onBlur={() => commitRename(c.id)} />
              ) : (
                <span className="history-row-title"
                  onDoubleClick={(e) => { e.stopPropagation(); setRenaming(c.id); setRenameText(c.title); }}>
                  {c.title || "New chat"}
                </span>
              )}
              <button className="chat-del" title="Delete" onClick={(e) => { e.stopPropagation(); removeConvo(c.id); }}>{trashIcon}</button>
            </div>
          ))}
        </div>

        {/* Brandon section — interviews, calendar, settings. Clicking an item
            swaps the RIGHT PANE; the sidebar stays put (one window). */}
        <div className="sidebar-section">
          <button className={`sidebar-nav${pane === "home" ? " active" : ""}`} onClick={() => setPane("home")}>My interviews</button>
          <button className={`sidebar-nav${pane === "calendar" ? " active" : ""}`} onClick={() => setPane("calendar")}>My calendar</button>
          <button className="sidebar-nav" onClick={onOpenSettings}>Settings</button>
          {currentUser.role === "superadmin" && <button className="sidebar-nav" onClick={onOpenAdmin}>Admin</button>}
        </div>

        <div className="history-sidebar-footer">
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span title={currentUser.email}>{currentUser.email}</span>
            <button className="link-settings small" onClick={onLogout}>Log out</button>
          </div>
        </div>
      </aside>

      <main className="chat-main chat-thread">
        {/* Top bar: pane title + "Go to overlay" (always available). */}
        <div className="pane-topbar">
          <span className="pane-title">
            {pane === "chat" ? "Chat" : pane === "home" ? "My interviews" : pane === "calendar" ? "My calendar" : pane === "modes" ? "Modes & files" : ""}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              className={`toggle danger ${detectable ? "on" : ""}`}
              onClick={onToggleDetectable}
              title={detectable ? "Overlay is visible in screen-share" : "Overlay is hidden from screen-share (recommended)"}
            >
              <span className="track"><span className="thumb" /></span>
              <span className="label">{detectable ? "Detectable" : "Undetectable"}</span>
            </button>
            <button className="overlay-btn" onClick={onShrinkToOverlay} title="Shrink to the live interview overlay">
              Go to overlay →
            </button>
          </div>
        </div>

        {pane === "chat" && (<>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <BrandonMark size={64} className="chat-empty-mark" />
              <h1>How can I help?</h1>
              <p>Ask anything, or start a live interview from the sidebar.</p>
            </div>
          ) : (
            <div className="chat-scroll" ref={scrollRef}>
              <div className="chat-inner">
                {messages.map((m) => (
                  <div key={m.id} className={`chat-msg ${m.role}`}>
                    {m.role === "assistant" && <BrandonMark size={26} className="chat-msg-avatar" />}
                    {m.role === "user" && editingMsg === m.id ? (
                      <div className="chat-edit">
                        <textarea
                          autoFocus value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEditMsg(m.id); }
                            if (e.key === "Escape") setEditingMsg(null);
                          }}
                          rows={Math.min(8, Math.max(1, editText.split("\n").length))}
                        />
                        <div className="chat-edit-actions">
                          <button onClick={() => setEditingMsg(null)}>Cancel</button>
                          <button className="primary" onClick={() => commitEditMsg(m.id)} disabled={!editText.trim() || streaming}>Send</button>
                        </div>
                      </div>
                    ) : (
                      <div className="chat-msg-body">
                        <div className="chat-bubble">
                          {m.role === "assistant" ? <Markdown>{m.content || "…"}</Markdown> : m.content}
                        </div>
                        {m.content && (
                          <div className="chat-msg-actions">
                            <button className="msg-action" title={copiedId === m.id ? "Copied" : "Copy"}
                              onClick={() => copyMsg(m.id, m.content)}>
                              {copiedId === m.id ? checkIcon : copyIcon}
                            </button>
                            {m.role === "user" && !streaming && (
                              <button className="msg-action" title="Edit message"
                                onClick={() => { setEditingMsg(m.id); setEditText(m.content); }}>
                                {pencilIcon}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {err && <div className="error" style={{ textAlign: "center", padding: "0 0 8px" }}>{err}</div>}
          <div className="chat-composer">
            {images.length > 0 && (
              <div className="chat-composer-images">
                {images.map((im, i) => (
                  <div key={i} className="composer-thumb">
                    <img src={im.previewUrl} alt="" />
                    <button onClick={() => setImages((p) => p.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-composer-inner">
              {!openId && (
                <select className="mode-picker" value={pickMode} onChange={(e) => setPickMode(e.target.value)} title="Which mode answers">
                  <option value="">{activeProfile ? `Active: ${activeProfile.name}` : "Plain assistant"}</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  <option value={api.PLAIN_MODE}>Plain assistant</option>
                </select>
              )}
              <textarea
                value={input}
                placeholder="Ask anything"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                rows={1}
              />
              <label className="chat-attach" title="Attach image">
                {paperclipIcon}
                <input type="file" accept="image/*" multiple style={{ display: "none" }}
                  onChange={async (e) => {
                    const fs = e.target.files; if (!fs) return;
                    const conv = await Promise.all(Array.from(fs).filter((f) => f.type.startsWith("image/")).map(fileToImage));
                    setImages((p) => [...p, ...conv]); e.target.value = "";
                  }} />
              </label>
              <button className="chat-send" onClick={send} disabled={(!input.trim() && images.length === 0) || streaming} title="Send (Enter)">
                {sendIconUp}
              </button>
            </div>
            {!openId && <div className="composer-mode-hint">Answering as: {modeLabel}</div>}
          </div>
        </>)}

        {pane === "calendar" && (
          <div className="pane-scroll">
            <CalendarStrip items={agenda} onOpenMeeting={(id) => { onOpenMeeting(id); setPane("home"); }} />
          </div>
        )}

        {pane === "home" && (
          <div className="pane-scroll">
            {openMeetingId ? (
              <MeetingDetail sessionId={openMeetingId} profiles={profiles} onBack={onCloseMeeting} />
            ) : (
              <InterviewsContent
                pipeline={pipeline}
                openMeetingId={openMeetingId} onOpenMeeting={onOpenMeeting}
                onUpdateCompanyStatus={onUpdateCompanyStatus} onDeleteCompany={onDeleteCompany}
              />
            )}
          </div>
        )}

        {pane === "modes" && (
          <div className="pane-scroll">
            {!modeDetail ? (
              <div className="empty">Select a mode on the left, or click <strong>+ New mode</strong>.</div>
            ) : (
              <ProfileEditor
                profile={modeDetail}
                onChanged={reloadModeDetail}
                onActivate={async () => { try { await api.activateProfile(modeDetail.id); await reloadModeDetail(); } catch (e) { setError((e as Error).message); } }}
                onDelete={async () => { if (!confirm(`Delete mode "${modeDetail.name}" and its files?`)) return; try { await api.deleteProfile(modeDetail.id); onSelectMode(""); await refreshProfiles(); } catch (e) { setError((e as Error).message); } }}
                onStart={() => onStartInterview(modeDetail.id)}
              />
            )}
            {error && <div className="error" style={{ padding: "8px 24px" }}>{error}</div>}
          </div>
        )}
      </main>
    </div>
  );
}
