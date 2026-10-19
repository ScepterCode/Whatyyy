"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { calculateChatStats, parseWhatsAppExport, type ChatMessage } from "@/lib/chat";
import {
  extractWhatsAppTextFromZip,
  MAX_TEXT_EXPORT_BYTES,
  MAX_ZIP_EXPORT_BYTES,
} from "@/lib/import";
import type { ChatReport, ReportSettings } from "@/lib/report";
import { LocalReportStorage, type ReportStorage, type StoredReport } from "@/lib/storage/report-storage";
import { getOrCreateDeviceKey } from "@/lib/storage/device-key";
import { RemoteReportStorage } from "@/lib/storage/remote-report-storage";

type Stage = "upload" | "confirm" | "report";

function Icon({
  name,
  size = 20,
}: {
  name: "arrow" | "upload" | "lock" | "close" | "spark" | "back";
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (name) {
    case "arrow":
      return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
    case "upload":
      return <svg {...common}><path d="M12 16V4m-4 4 4-4 4 4" /><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></svg>;
    case "lock":
      return <svg {...common}><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3" /></svg>;
    case "close":
      return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case "spark":
      return <svg {...common}><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></svg>;
    case "back":
      return <svg {...common}><path d="M19 12H5m6 6-6-6 6-6" /></svg>;
  }
}

function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="Between the Lines home">
      <span className="wordmark-mark">bt.</span>
      <span>between the lines</span>
    </a>
  );
}

export default function Home() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [storage, setStorage] = useState<ReportStorage>(() => new LocalReportStorage());
  const [stage, setStage] = useState<Stage>("upload");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [participants, setParticipants] = useState<string[]>([]);
  const [self, setSelf] = useState("");
  const [fileName, setFileName] = useState("");
  const [settings, setSettings] = useState<ReportSettings>({
    relationship_type: "unknown",
    tone: "direct",
    depth: "standard",
    language: "en",
  });
  const [hasUploadPermission, setHasUploadPermission] = useState(false);
  const [modelConsent, setModelConsent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ChatReport | null>(null);
  const [history, setHistory] = useState<StoredReport[]>([]);
  const [progress, setProgress] = useState("");
  const [reportMessageCount, setReportMessageCount] = useState(0);

  const stats = useMemo(() => calculateChatStats(messages), [messages]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/reports?mode=config");
        if (!response.ok) throw new Error("Report storage settings could not be loaded.");
        const config = (await response.json()) as { storage?: string };
        const selectedStorage: ReportStorage =
          config.storage === "blob" ? new RemoteReportStorage() : new LocalReportStorage();
        const savedReports = await selectedStorage.list();
        if (!cancelled) {
          setStorage(selectedStorage);
          setHistory(savedReports);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Saved reports could not be loaded.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    if (!hasUploadPermission) {
      setError("Confirm that you have permission to share this conversation before choosing a file.");
      event.target.value = "";
      return;
    }

    const fileNameLower = file.name.toLowerCase();
    const isZip = fileNameLower.endsWith(".zip");
    const isText = fileNameLower.endsWith(".txt");
    if (!isZip && !isText) {
      setError("Choose a WhatsApp .zip archive or .txt export.");
      event.target.value = "";
      return;
    }
    const maxBytes = isZip ? MAX_ZIP_EXPORT_BYTES : MAX_TEXT_EXPORT_BYTES;
    if (file.size > maxBytes) {
      setError(
        isZip
          ? "This ZIP is over 50 MB. Export the chat without media and try again."
          : "This file is over 1.5 MB. Choose a smaller WhatsApp text export.",
      );
      event.target.value = "";
      return;
    }

    try {
      const text = isZip
        ? await extractWhatsAppTextFromZip(new Uint8Array(await file.arrayBuffer()))
        : await file.text();
      const parsed = parseWhatsAppExport(text);
      if (parsed.messages.length < 2) {
        setError("We couldn’t find enough messages. Choose the .txt file from WhatsApp’s Export chat option.");
        event.target.value = "";
        return;
      }
      if (parsed.messages.length > 5000) {
        setError("This export has more than 5,000 messages. Choose a smaller conversation.");
        event.target.value = "";
        return;
      }
      if (parsed.participants.length < 2) {
        setError("We need a chat with at least two people to make a useful read.");
        event.target.value = "";
        return;
      }
      setMessages(parsed.messages);
      setParticipants(parsed.participants);
      setSelf(parsed.participants[0]);
      setSettings((current) => ({
        ...current,
        relationship_type: parsed.participants.length > 2 ? "group" : "unknown",
        depth: parsed.participants.length > 2 ? "group_chat" : "standard",
      }));
      setFileName(file.name);
      setStage("confirm");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "We couldn’t read that file. Save a fresh WhatsApp export and try again.",
      );
      event.target.value = "";
    }
  }

  async function analyze() {
    if (!modelConsent) {
      setError("Confirm that you have permission to analyze this chat with the configured AI model.");
      return;
    }
    setLoading(true);
    setError("");
    setProgress("Starting the evidence review");
    try {
      const deviceKey = getOrCreateDeviceKey();
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deviceKey}`,
        },
        body: JSON.stringify({ messages, self, settings, consented: modelConsent }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "We couldn’t make your report.");
      }
      const started = (await response.json()) as { jobId?: string };
      if (!started.jobId) throw new Error("The report job could not be started. Try again.");
      type JobStatus = {
        report?: ChatReport;
        storedReport?: StoredReport;
        status?: string;
        error?: string;
      };
      let completed: JobStatus | null = null;
      for (let attempt = 0; attempt < 450; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
        const statusResponse = await fetch(`/api/analyze?jobId=${encodeURIComponent(started.jobId)}`, {
          headers: { Authorization: `Bearer ${deviceKey}` },
          cache: "no-store",
        });
        const status = (await statusResponse.json()) as JobStatus;
        if (!statusResponse.ok) {
          throw new Error(status?.error || "The report status could not be loaded.");
        }
        if (status?.status === "failed" || status?.status === "cancelled") {
          throw new Error(status.error || "The report could not be completed. Try again.");
        }
        if (status?.status === "completed") {
          completed = status;
          break;
        }
        setProgress("Working through the evidence-led report");
      }
      if (!completed?.report || !completed.storedReport) {
        throw new Error("The report is taking longer than expected. Check saved reports before starting another analysis.");
      }
      const completedReport = completed.report;
      const saved = completed.storedReport;
      setReport(completedReport);
      setReportMessageCount(messages.length);
      setStage("report");
      try {
        await storage.save(saved);
        setHistory(await storage.list());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The report is ready but could not be saved on this device.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We couldn’t make your report. Try again.");
    } finally {
      setLoading(false);
      setProgress("");
    }
  }

  function openSavedReport(item: StoredReport) {
    setReport(item.report);
    setParticipants(item.participants);
    setReportMessageCount(item.message_count);
    setSettings(item.settings);
    setStage("report");
    setError("");
  }

  async function deleteSavedReport(id: string) {
    try {
      await storage.delete(id);
      setHistory(await storage.list());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This report could not be deleted.");
    }
  }

  async function clearSavedReports() {
    try {
      await storage.clear();
      setHistory([]);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Saved reports could not be cleared.");
    }
  }

  function startOver() {
    setStage("upload");
    setMessages([]);
    setParticipants([]);
    setSelf("");
    setFileName("");
    setReport(null);
    setReportMessageCount(0);
    setProgress("");
    setError("");
    setHasUploadPermission(false);
    setModelConsent(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <Wordmark />
        <a className="top-link" href="#how-it-works">how it works <Icon name="arrow" size={15} /></a>
      </header>

      {stage === "upload" && (
        <>
          <section className="hero">
            <div className="hero-copy">
              <div className="eyebrow"><span className="eyebrow-dot" /> AN OUTSIDE READ ON YOUR INSIDE JOKES</div>
              <h1>So, what’s <span>really</span> going on here?</h1>
              <p className="hero-lede">
                Your chat has a plot. Get a thoughtful, funny second opinion on the patterns, the pauses, and the things you both keep not saying.
              </p>
              <div className="hero-proof"><Icon name="lock" size={16} /> Your original chat isn’t saved.</div>
            </div>

            <div className="hero-art" aria-label="A sample conversation with a read between the lines">
              <div className="art-topline"><span>THE GROUP CHAT</span><span>10:42 PM</span></div>
              <div className="chat-snippet">
                <div className="snippet-label">MAYA</div>
                <div className="bubble bubble-left">“no it’s fine, do whatever”</div>
                <div className="snippet-label snippet-right">YOU</div>
                <div className="bubble bubble-right">“Okay, I’ll book it then?”</div>
                <div className="bubble bubble-left bubble-last">“👍”</div>
              </div>
              <div className="read-card">
                <span className="read-card-star"><Icon name="spark" size={18} /></span>
                <span className="read-card-overline">BETWEEN THE LINES</span>
                <p>That thumbs-up has a whole paragraph behind it.</p>
                <span className="read-card-tail">a tiny preview of your report ↗</span>
              </div>
              <span className="art-stamp">NO<br />JUDGMENT</span>
            </div>
          </section>

          <section className="start-section" aria-labelledby="start-title">
            <div className="section-heading">
              <span className="section-kicker">YOUR CONVERSATION, WITH CONTEXT</span>
              <h2 id="start-title">Start with the chat.</h2>
            </div>
            <div className="upload-card">
              <input
                ref={fileInput}
                className="visually-hidden"
                type="file"
                accept=".txt,.zip,text/plain,application/zip,application/x-zip-compressed"
                onChange={selectFile}
                aria-hidden="true"
                tabIndex={-1}
              />
              <button className="upload-target" onClick={() => fileInput.current?.click()}>
                <span className="upload-icon"><Icon name="upload" size={23} /></span>
                <span className="upload-words">
                  <strong>Choose your WhatsApp export</strong>
                  <span>Upload the .zip archive or .txt file from Export chat</span>
                </span>
                <span className="upload-action">Choose file <Icon name="arrow" size={16} /></span>
              </button>
              <label className="consent-check">
                <input
                  type="checkbox"
                  checked={hasUploadPermission}
                  onChange={(event) => setHasUploadPermission(event.target.checked)}
                />
                <span>I have permission to share this conversation for analysis.</span>
              </label>
              <div className="upload-foot">
                <span><Icon name="lock" size={14} /> We don’t keep your upload</span>
                <span>.zip up to 50 MB · .txt up to 1.5 MB</span>
              </div>
            </div>
            {error && <p className="error-message" role="alert">{error}</p>}
            <p className="consent-line">Your file is read in this browser; it isn’t uploaded until you ask for a report.</p>
          </section>

          <section className="how-section" id="how-it-works">
            <div className="how-head">
              <span className="section-kicker">A LITTLE CLARITY, NOT A COURTROOM</span>
              <h2>Three steps. No dramatic verdicts.</h2>
            </div>
            <div className="how-grid">
              <article><span className="how-symbol">↗</span><h3>Bring the receipts</h3><p>Upload a WhatsApp text export. We’ll find the messages and people in it.</p></article>
              <article><span className="how-symbol">⌘</span><h3>Tell us which one is you</h3><p>Choose your name and the kind of friend you want in your corner.</p></article>
              <article><span className="how-symbol">✳</span><h3>Get the outside read</h3><p>See conversation patterns, exact receipts, and a few kind next steps.</p></article>
            </div>
          </section>
        </>
      )}

      {stage === "confirm" && (
        <section className="flow-wrap">
          <button className="back-button" onClick={startOver}><Icon name="back" size={17} /> Start over</button>
          <div className="flow-heading">
            <span className="section-kicker">FIRST, A QUICK INTRO</span>
            <h1>Who are you in this chat?</h1>
            <p>We found {stats.messageCount.toLocaleString()} messages and {participants.length} people in <strong>{fileName}</strong>.</p>
          </div>
          <div className="confirm-card">
            <label className="field-label" htmlFor="self-select">I’m in this chat as…</label>
            <select id="self-select" value={self} onChange={(event) => setSelf(event.target.value)}>
              {participants.map((participant) => <option key={participant} value={participant}>{participant}</option>)}
            </select>
            <div className="report-settings">
              <label className="setting-field">
                <span className="field-label">This is a…</span>
                <select
                  value={settings.relationship_type}
                  onChange={(event) => setSettings((current) => ({
                    ...current,
                    relationship_type: event.target.value as ReportSettings["relationship_type"],
                    ...(event.target.value === "group" ? { depth: "group_chat" } : {}),
                  }))}
                >
                  <option value="unknown">Not sure / other</option>
                  <option value="romantic">Romantic relationship</option>
                  <option value="friendship">Friendship</option>
                  <option value="family">Family</option>
                  <option value="group">Group chat</option>
                  <option value="workplace">Workplace</option>
                </select>
              </label>
              <label className="setting-field">
                <span className="field-label">Read it in a…</span>
                <select
                  value={settings.tone}
                  onChange={(event) => setSettings((current) => ({
                    ...current,
                    tone: event.target.value as ReportSettings["tone"],
                  }))}
                >
                  <option value="gentle">Gentle voice</option>
                  <option value="direct">Direct voice</option>
                  <option value="brutal_but_fair">Blunt but fair</option>
                </select>
              </label>
              <label className="setting-field">
                <span className="field-label">How much detail?</span>
                <select
                  value={settings.depth}
                  onChange={(event) => setSettings((current) => ({
                    ...current,
                    depth: event.target.value as ReportSettings["depth"],
                  }))}
                >
                  <option value="standard">Standard</option>
                  <option value="deep_dive">Deep dive</option>
                  <option value="group_chat">Group chat</option>
                </select>
              </label>
            </div>
            <div className="stats-strip"><span><strong>{stats.messageCount.toLocaleString()}</strong> messages</span><span><strong>{participants.length}</strong> people</span><span><strong>{stats.firstMessageAt ? new Date(stats.firstMessageAt).toLocaleDateString() : "—"}</strong> first message</span></div>
            <label className="consent-check model-consent">
              <input
                type="checkbox"
                checked={modelConsent}
                onChange={(event) => setModelConsent(event.target.checked)}
              />
              <span>I have permission to analyze this chat. A redacted sample is sent to the configured AI model and temporarily held by the workflow service (up to one day).</span>
            </label>
            <button className="primary-button full-button" onClick={analyze} disabled={loading}>
              {loading ? <><span className="spinner" /> <span aria-live="polite">{progress || "Reading the conversation…"}</span></> : <>Get the outside read <Icon name="arrow" size={17} /></>}
            </button>
            {error && <p className="error-message" role="alert">{error}</p>}
            <p className="privacy-note"><Icon name="lock" size={14} /> Your original chat stays in this browser. A redacted sample is sent to the model and held by Vercel Workflows for up to one day. The report stays here or in private Blob until you delete it.</p>
          </div>
          {history.length > 0 && (
            <section className="saved-reports" aria-labelledby="saved-reports-title">
              <div className="saved-reports-heading">
                <div><span className="section-kicker">PRIVATE SAVED READS</span><h2 id="saved-reports-title">Saved reads</h2></div>
                <button className="text-button" onClick={clearSavedReports}>Delete all</button>
              </div>
              <ul>
                {history.map((item) => (
                  <li key={item.id}>
                    <button className="saved-report-open" onClick={() => openSavedReport(item)}>
                      <strong>{item.title}</strong>
                      <span>{new Date(item.created_at).toLocaleDateString()} · {item.participants.join(", ")}</span>
                    </button>
                    <button className="text-button saved-report-delete" onClick={() => void deleteSavedReport(item.id)} aria-label={`Delete ${item.title}`}>Delete</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>
      )}

      {stage === "report" && report && (
        <section className="report-wrap">
          <button className="back-button" onClick={startOver}><Icon name="back" size={17} /> Read another chat</button>
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="report-head">
            <span className="section-kicker">YOUR OUTSIDE READ · {participants.length} PEOPLE · {reportMessageCount.toLocaleString()} MESSAGES</span>
            <h1>{report.title}</h1>
            <p>{report.persona_description}</p>
          </div>
          <div className="report-paper">
            <div className="report-verdict">
              <span className="report-label">{report.persona_name}’S CENTRAL READ</span>
              <h2>{report.central_thesis}</h2>
            </div>
            {report.safety_note && <aside className="safety-note" role="note">{report.safety_note}</aside>}
            {report.sections.map((section) => (
              <article className="report-block report-section" key={section.id}>
                <span className="report-label">{section.title}</span>
                {section.body.split(/\n{2,}/).map((paragraph, index) => (
                  <p key={`${section.id}-${index}`}>{paragraph}</p>
                ))}
                {section.quotes.length > 0 && (
                  <div className="receipts">
                    {section.quotes.map((quote) => (
                      <blockquote key={`${quote.message_id}-${quote.sender}-${quote.text}`}>
                        <p>“{quote.text}”</p>
                        <cite>{quote.sender} · message {quote.message_id}</cite>
                      </blockquote>
                    ))}
                  </div>
                )}
              </article>
            ))}
            <footer className="report-disclaimer">A conversation can show patterns, not tell the whole story. Take what’s useful; leave what isn’t.</footer>
          </div>
          <button className="text-button" onClick={startOver}><Icon name="close" size={16} /> Close this read</button>
        </section>
      )}

      <footer className="site-footer">
        <Wordmark />
        <span>Made for understanding each other a little better.</span>
        <span className="footer-privacy"><Icon name="lock" size={13} /> Reports stay in this browser</span>
      </footer>
    </main>
  );
}
