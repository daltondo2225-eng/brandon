import type { AgendaItem, CompanyStatus, PipelineEntry, Profile, ProfileWithFiles, Session } from "@brandon/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { bridge } from "../lib/bridge";
import { Markdown } from "../lib/Markdown";

const DETECTABLE_KEY = "brandon.detectable";

const SUPPORTED_EXTENSIONS = ".pdf,.docx,.txt,.md";

type View = "home" | "settings" | "meeting";

export function App() {
  const [view, setView] = useState<View>("home");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProfileWithFiles | null>(null);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [openMeetingId, setOpenMeetingId] = useState<string | null>(null);
  const [pendingStartProfile, setPendingStartProfile] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyStatus, setKeyStatus] = useState<api.AnthropicKeyStatus>({ set: false, preview: null });
  const [error, setError] = useState<string>("");

  const refreshKeyStatus = useCallback(async () => {
    try { setKeyStatus(await api.getAnthropicKeyStatus()); } catch { /* silent */ }
  }, []);
  useEffect(() => { refreshKeyStatus(); }, [refreshKeyStatus]);
  // Detectable = visible in screen capture. Default OFF (= invisible, stealth on).
  const [detectable, setDetectable] = useState<boolean>(() => {
    try { return localStorage.getItem(DETECTABLE_KEY) === "true"; } catch { return false; }
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
    <SettingsModal
      initialStatus={keyStatus}
      onClose={() => setSettingsOpen(false)}
      onSaved={(s) => { setKeyStatus(s); }}
    />
  ) : null;

  if (view === "home") {
    return (
      <>{startModal}{settingsModal}<HomeView
        profiles={profiles}
        activeProfile={activeProfile}
        sessions={allSessions}
        pipeline={pipeline}
        agenda={agenda}
        openMeetingId={openMeetingId}
        detectable={detectable}
        keyStatus={keyStatus}
        onToggleDetectable={() => setDetectable((v) => !v)}
        onStart={() => activeProfile && startInterview(activeProfile.id)}
        onOpenSettings={() => setView("settings")}
        onOpenApiSettings={() => setSettingsOpen(true)}
        onPickActive={async (id) => {
          await api.activateProfile(id);
          await refresh();
        }}
        onOpenMeeting={(id) => setOpenMeetingId(id)}
        onCloseMeeting={() => setOpenMeetingId(null)}
        onUpdateCompanyStatus={async (id, status) => {
          await api.updateCompany(id, { status });
          await refreshPipeline();
        }}
        onDeleteCompany={async (id) => {
          await api.deleteCompany(id);
          await refreshPipeline();
        }}
        error={error}
      /></>
    );
  }

  return (
    <>
    {startModal}
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top">
          <button className="icon" title="Back to Home" onClick={() => setView("home")}>{closeIcon}</button>
          <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Modes</span>
        </div>
        <button className="new-mode" onClick={createNew}>
          {plusIcon}
          <span>New Mode</span>
        </button>
        <div className="profile-list">
          {profiles.map((p) => (
            <div
              key={p.id}
              className={`profile-item${p.id === selectedId ? " selected" : ""}`}
              onClick={() => setSelectedId(p.id)}
            >
              <span className="icon">{docIcon}</span>
              <span className="name">{p.name || "Untitled"}</span>
              {p.isActive && <span className="check" title="Active">{checkIcon}</span>}
              <button
                className="row-start"
                title="Start interview with this mode"
                onClick={(e) => { e.stopPropagation(); startInterview(p.id); }}
              >{playIcon}</button>
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          {templateIcon}
          <span>Brandon Templates</span>
        </div>
      </aside>

      <main className="editor">
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -16 }}>
          <button
            className={`toggle danger ${detectable ? "on" : ""}`}
            onClick={() => setDetectable((v) => !v)}
            title={detectable
              ? "Overlay is visible in screen-share (Zoom/Meet/Teams will see it)"
              : "Overlay is hidden from screen-share (recommended)"}
          >
            <span className="track"><span className="thumb" /></span>
            <span className="label">{detectable ? "Detectable" : "Undetectable"}</span>
          </button>
        </div>
        {!detail ? (
          <div className="empty">Select a mode on the left or click <strong>+ New Mode</strong>.</div>
        ) : (
          <ProfileEditor
            profile={detail}
            onChanged={reloadDetail}
            onActivate={async () => {
              try { await api.activateProfile(detail.id); await reloadDetail(); }
              catch (err) { setError((err as Error).message); }
            }}
            onDelete={async () => {
              if (!confirm(`Delete mode "${detail.name}" and its reference files?`)) return;
              try { await api.deleteProfile(detail.id); setSelectedId(null); await refresh(); }
              catch (err) { setError((err as Error).message); }
            }}
            onStart={() => startInterview(detail.id)}
          />
        )}
        {error && <div className="error">{error}</div>}
      </main>
    </div>
    </>
  );
}

function HomeView({
  profiles,
  activeProfile,
  sessions,
  pipeline,
  agenda,
  openMeetingId,
  detectable,
  keyStatus,
  onToggleDetectable,
  onStart,
  onOpenSettings,
  onOpenApiSettings,
  onPickActive,
  onOpenMeeting,
  onCloseMeeting,
  onUpdateCompanyStatus,
  onDeleteCompany,
  error,
}: {
  profiles: Profile[];
  activeProfile: Profile | null;
  sessions: Session[];
  pipeline: PipelineEntry[];
  agenda: AgendaItem[];
  openMeetingId: string | null;
  detectable: boolean;
  keyStatus: api.AnthropicKeyStatus;
  onToggleDetectable: () => void;
  onStart: () => void;
  onOpenSettings: () => void;
  onOpenApiSettings: () => void;
  onPickActive: (id: string) => Promise<void>;
  onOpenMeeting: (id: string) => void;
  onCloseMeeting: () => void;
  onUpdateCompanyStatus: (id: string, status: CompanyStatus) => Promise<void>;
  onDeleteCompany: (id: string) => Promise<void>;
  error: string;
}) {
  const [picker, setPicker] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"pipeline" | "meetings">("pipeline");
  const grouped = groupSessionsByDay(sessions);
  const needsKey = !keyStatus.set;

  return (
    <div className="chat-layout">
      {/* ----------- LEFT: history sidebar ----------- */}
      <aside className="history-sidebar">
        <div className="history-sidebar-top">
          <div className="brand-row">
            <span className="brand-label">Brandon</span>
          </div>
          <button className="new-chat-btn" onClick={onStart} disabled={!activeProfile} title="Start a new interview">
            {plusIcon}
            <span>New interview</span>
          </button>
          <div className="sidebar-tabs">
            <button
              className={sidebarTab === "pipeline" ? "active" : ""}
              onClick={() => setSidebarTab("pipeline")}
            >Pipeline</button>
            <button
              className={sidebarTab === "meetings" ? "active" : ""}
              onClick={() => setSidebarTab("meetings")}
            >Meetings</button>
          </div>
        </div>

        {sidebarTab === "meetings" ? (
          <div className="history-list">
            {sessions.length === 0 ? (
              <div className="history-empty">No meetings yet.</div>
            ) : (
              grouped.map((group) => (
                <div className="history-group" key={group.label}>
                  <div className="history-group-title">{group.label}</div>
                  {group.items.map((s) => {
                    const owner = profiles.find((p) => p.id === s.profileId);
                    const ended = s.endedAt !== null;
                    const active = s.id === openMeetingId;
                    return (
                      <button
                        key={s.id}
                        className={`history-row${active ? " active" : ""}`}
                        onClick={() => onOpenMeeting(s.id)}
                        title={s.title}
                      >
                        <div className="history-row-title">{s.title}</div>
                        <div className="history-row-meta">
                          <span>{owner?.name ?? "—"}</span>
                          <span>·</span>
                          <span>{ended ? formatDuration(s.endedAt! - s.startedAt) : "live"}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        ) : (
          <PipelineList
            pipeline={pipeline}
            openMeetingId={openMeetingId}
            onOpenMeeting={onOpenMeeting}
            onUpdateStatus={onUpdateCompanyStatus}
            onDelete={onDeleteCompany}
          />
        )}

        <div className="history-sidebar-footer">
          <div className="active-mode-row">
            <div style={{ position: "relative", flex: 1 }}>
              <button className="mode-pill compact" onClick={() => setPicker((v) => !v)} disabled={profiles.length === 0}>
                {docIcon}
                <span>{activeProfile?.name ?? "No mode"}</span>
                {chevronDownIcon}
              </button>
              {picker && (
                <div className="mode-picker bottom" onMouseLeave={() => setPicker(false)}>
                  {profiles.map((p) => (
                    <button
                      key={p.id}
                      className={p.isActive ? "active" : ""}
                      onClick={async () => { setPicker(false); await onPickActive(p.id); }}
                    >
                      {docIcon}
                      <span>{p.name || "Untitled"}</span>
                      {p.isActive && <span className="check-small">{checkIcon}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <button
            className={`toggle danger ${detectable ? "on" : ""}`}
            onClick={onToggleDetectable}
            title={detectable
              ? "Overlay is visible in screen-share"
              : "Overlay is hidden from screen-share (recommended)"}
          >
            <span className="track"><span className="thumb" /></span>
            <span className="label">{detectable ? "Detectable" : "Undetectable"}</span>
          </button>
          <button className="link-settings small" onClick={onOpenSettings}>
            Manage modes & files →
          </button>
          <button
            className={`link-settings small${needsKey ? " warn" : ""}`}
            onClick={onOpenApiSettings}
            title={needsKey ? "Anthropic API key is not set" : `Key set (${keyStatus.preview ?? ""})`}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            {gearIcon}
            <span>{needsKey ? "Set Anthropic API key" : "Settings"}</span>
          </button>
        </div>
      </aside>

      {/* ----------- MAIN: meeting detail or welcome ----------- */}
      <main className="chat-main">
        {needsKey && (
          <div className="key-banner">
            <strong>Anthropic API key not set.</strong>
            <span>Brandon needs your <code>sk-ant-…</code> key to call Claude. Set it once and it's stored locally.</span>
            <button className="primary" onClick={onOpenApiSettings}>Open Settings</button>
          </div>
        )}
        <CalendarStrip
          items={agenda}
          onOpenMeeting={onOpenMeeting}
        />
        {openMeetingId ? (
          <MeetingDetail
            sessionId={openMeetingId}
            profiles={profiles}
            onBack={onCloseMeeting}
          />
        ) : (
          <WelcomePane activeProfile={activeProfile} onStart={onStart} disabled={needsKey} />
        )}
        {error && <div className="error" style={{ padding: "8px 24px" }}>{error}</div>}
      </main>
    </div>
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
        return (
          <div key={c.id} className={`pipeline-row status-${c.status}${isOpen ? " expanded" : ""}`}>
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
              <StatusPill
                status={c.status}
                onChange={(s) => onUpdateStatus(c.id, s)}
              />
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
                <button
                  className="pipeline-delete"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Remove ${c.name} from the pipeline? (Meetings stay; they just get unlinked.)`)) return;
                    await onDelete(c.id);
                  }}
                >Remove from pipeline</button>
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

function SettingsModal({
  initialStatus,
  onClose,
  onSaved,
}: {
  initialStatus: api.AnthropicKeyStatus;
  onClose: () => void;
  onSaved: (s: api.AnthropicKeyStatus) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showVal, setShowVal] = useState(false);

  const save = async () => {
    setBusy(true); setErr("");
    try {
      const s = await api.setAnthropicKey(key.trim() || null);
      onSaved(s);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!confirm("Remove the saved Anthropic API key?")) return;
    setBusy(true); setErr("");
    try {
      const s = await api.setAnthropicKey(null);
      onSaved(s);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="icon" onClick={onClose} title="Close">{closeIcon}</button>
        </div>
        <div className="modal-body">
          <p className="modal-sub">
            Your Anthropic API key is stored locally on this machine and is only used to call
            Claude on your behalf. Get one at console.anthropic.com → API Keys.
          </p>
          <div className="field">
            <label>Current key</label>
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>
              {initialStatus.set ? <>Set · ending in <code>{initialStatus.preview}</code></> : <em>Not set</em>}
            </div>
          </div>
          <div className="field">
            <label>New API key</label>
            <input
              type={showVal ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-..."
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, marginTop: 6, color: "var(--text-dim)" }}>
              <input type="checkbox" checked={showVal} onChange={(e) => setShowVal(e.target.checked)} />
              Show key
            </label>
          </div>
          {err && <div className="error" style={{ marginTop: 4 }}>{err}</div>}
        </div>
        <div className="modal-actions">
          {initialStatus.set && (
            <button onClick={clear} disabled={busy} style={{ color: "var(--danger)" }}>Clear saved key</button>
          )}
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy || !key.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
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
    <>
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
        <div className="label">Real-time prompt</div>
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
        <select value={model} onChange={(e) => setModel(e.target.value as Profile["model"])} style={{ width: 280 }}>
          <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
          <option value="claude-opus-4-7">Claude Opus 4.7</option>
          <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
        </select>
      </div>

      {localError && <div className="error">{localError}</div>}
    </>
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
const paperclipIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 7l-4.7 4.7a2 2 0 01-2.8-2.8L8.7 4.2a3 3 0 014.2 4.2L8 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const playIcon = (<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 3l9 5-9 5V3z" fill="currentColor"/></svg>);
const refreshIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13 8a5 5 0 11-1.5-3.5L13 3v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>);
const backIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const chevronDownIcon = (<svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>);
const gearIcon = (<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>);
