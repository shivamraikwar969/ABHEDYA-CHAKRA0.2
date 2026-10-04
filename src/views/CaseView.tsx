import { useEffect, useMemo, useState } from "react";
import { FileText, Printer, ShieldCheck, ShieldAlert, Copy, AlertOctagon, Cpu } from "lucide-react";
import { useStore } from "@/store";
import { Panel, Button, Input, Empty, Badge } from "@/components/ui";
import { traceTrail, DEFAULT_TRAIL_OPTIONS } from "@/engine/trail";
import { buildCase, buildNotices, caseDiaryLines, inr, noticeLines, sanitizeRemarks, tsText, verifyText, type CaseFacts, type Notice } from "@/engine/forensics";
import type { TrailResult } from "@/engine/types";
import { cleanText } from "@/utils/sanitize";
import { buildEvidenceTimeline, buildFactPack, llmHealth, narrateLocal, timelineLines, type LlmHealth, type NarrateOk, type NarrateFail } from "@/engine/llm";

type AiState = { busy: boolean; res: (NarrateOk & { clientChecked: number }) | NarrateFail | null };

interface Gen { tr: TrailResult; facts: CaseFacts; diary: string[]; timeline: string[]; notices: Notice[]; remarks: string; }

export function CaseView() {
  const { dataset, analytics, demoHints } = useStore();
  const [victim, setVictim] = useState("");
  const [fir, setFir] = useState("");
  const [ps, setPs] = useState("");
  const [io, setIo] = useState("");
  const [remarks, setRemarks] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [gen, setGen] = useState<Gen | null>(null);
  const [tab, setTab] = useState<"diary" | "notice">("diary");

  const guard = useMemo(() => {
    if (!gen) return null;
    const text = [...gen.diary, ...gen.timeline, ...noticeLines(gen.notices), gen.remarks].join("\n");
    return verifyText(text, gen.facts.allowed);
  }, [gen]);

  // ---- Local AI narrator (Ollama / llama.cpp via server/llm-server.mjs) - optional, always guardrailed ----
  const [health, setHealth] = useState<LlmHealth | null>(null);
  const [ai, setAi] = useState<AiState>({ busy: false, res: null });
  const refreshHealth = () => { llmHealth().then(setHealth); };
  useEffect(() => { refreshHealth(); }, []);
  useEffect(() => { setAi({ busy: false, res: null }); }, [gen]); // a new case invalidates any earlier AI text
  const runAi = async () => {
    if (!gen || !dataset) return;
    setAi({ busy: true, res: null });
    const fp = buildFactPack(gen.facts, dataset, gen.tr, gen.facts.exits ?? null, analytics ? buildEvidenceTimeline(dataset, analytics, gen.tr) : null);
    setAi({ busy: false, res: await narrateLocal(fp, remarks) });
  };
  const aiOk = ai.res && ai.res.ok ? ai.res : null;

  if (!dataset || !analytics) return <Empty title="No dataset loaded">Ingest a CSV to generate case documents.</Empty>;

  const run = (id?: string) => {
    const v = (id ?? victim).trim();
    if (id) setVictim(id);
    const idx = dataset.accountIndex.get(v);
    if (idx === undefined) { setErr(`Account "${v}" does not exist in the loaded dataset.`); setGen(null); return; }
    if (analytics.outCount[idx] === 0) { setErr("Account has no outbound transactions — nothing to trace."); setGen(null); return; }
    setErr(null);
    const tr = traceTrail(dataset, analytics, idx, DEFAULT_TRAIL_OPTIONS);
    const facts = buildCase(dataset, tr, analytics);
    setGen({ tr, facts, diary: caseDiaryLines(facts, dataset, tr).map((l: string) => cleanText(l, 2000)), timeline: timelineLines(buildEvidenceTimeline(dataset, analytics, tr)).map((l: string) => cleanText(l, 2000)), notices: buildNotices(facts, dataset), remarks: sanitizeRemarks(remarks, facts.allowed) });
  };
  const today = new Date().toLocaleDateString("en-IN");
  const firS = cleanText(fir, 120), psS = cleanText(ps, 120), ioS = cleanText(io, 120); // XSS: free-text inputs are purified before they reach the printable document
  const hdr = `FIR No.: ${firS || "________"} | Police Station: ${psS || "________"} | Investigating Officer: ${ioS || "________"}`;
  const copy = () => { if (gen) navigator.clipboard?.writeText([hdr, ...gen.diary.map((l) => l.replace(/^## /, "")), ...gen.timeline.map((l) => l.replace(/^## /, "")), gen.remarks ? "OFFICER REMARKS (sanitized): " + gen.remarks : "", aiOk ? "AI-ASSISTED SUMMARY (verified against graph): " + aiOk.text : ""].join("\n")); };

  return (
    <div className="space-y-4">
      <Panel title="Case inputs" icon={<FileText size={13} />} strong>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <Input value={victim} onChange={setVictim} placeholder="Victim account ID" className="md:col-span-2" onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
          <Input value={fir} onChange={setFir} placeholder="FIR No. (optional)" />
          <Input value={ps} onChange={setPs} placeholder="Police Station (optional)" />
          <Input value={io} onChange={setIo} placeholder="Investigating Officer (optional)" className="md:col-span-2" />
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Officer remarks (untrusted text — sanitized; unverified accounts/amounts are stripped)" rows={2}
            className="md:col-span-2 bg-slate-900/60 border border-cyan-500/20 rounded-md px-3 py-1.5 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-cyan-400/70" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => run()}>Generate case diary &amp; freeze notices</Button>
          {demoHints && demoHints.victims.slice(0, 6).map((v) => <button key={v} onClick={() => run(v)} className="px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 text-[11px] font-mono">{v}</button>)}
        </div>
        {err && <div className="mt-3 text-xs text-red-200 font-mono border border-red-500/50 bg-red-500/10 rounded px-3 py-2 flex items-center gap-2"><AlertOctagon size={14} /> {err}</div>}
      </Panel>

      {!gen || !guard ? <Empty title="Awaiting victim account">The diary and notices are composed only from facts read out of the transaction graph, then re-verified entity-by-entity.</Empty> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={tab === "diary" ? "toggle-on" : "toggle-off"} onClick={() => setTab("diary")}>Police case diary</Button>
            <Button variant={tab === "notice" ? "toggle-on" : "toggle-off"} onClick={() => setTab("notice")}>Freeze requisitions ({gen.notices.length})</Button>
            <div className="flex-1" />
            <Badge tone={guard.ok ? "emerald" : "red"}>{guard.ok ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />} Guardrail {guard.ok ? "PASS" : "FAIL"} · {guard.checked} entities verified vs graph{guard.ok ? "" : ` · ${guard.violations.length} unverified`}</Badge>
            <Button variant="ghost" onClick={copy}><Copy size={12} className="inline mr-1" />Copy</Button>
            <Button onClick={() => window.print()}><Printer size={12} className="inline mr-1" />Print</Button>
          </div>
          {!guard.ok && <div className="text-xs text-red-200 font-mono border border-red-500/50 bg-red-500/10 rounded px-3 py-2">Unverified tokens blocked from release: {guard.violations.slice(0, 6).join(", ")}</div>}

          <Panel title="Local AI narrator · offline LLM with anti-hallucination guardrails" icon={<Cpu size={13} />}
            actions={<>
              <Badge tone={health?.online && health.reachable ? "emerald" : "amber"}>{health === null ? "checking…" : health.online ? (health.reachable ? `${health.backend} · ${health.model}` : "service up · model server down") : "LLM service offline"}</Badge>
              <Button variant="ghost" onClick={refreshHealth}>Re-check</Button>
            </>}>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={runAi} disabled={ai.busy || !(health?.online && health.reachable)}>{ai.busy ? "Generating & verifying…" : "Generate AI narrative (local)"}</Button>
              <div className="text-[11px] text-slate-500 font-mono max-w-3xl">The model runs on this machine only. Its text is released only if every account, IFSC, transaction ID and ₹ amount is found in the graph - checked by the server and again in the browser. Otherwise the deterministic diary below is used.</div>
            </div>
            {health && !health.online && <div className="mt-3 text-[11px] font-mono text-amber-200">{health.reason}. Start it in a second terminal: <code className="text-cyan-300">npm run llm</code> (needs Ollama running, e.g. <code className="text-cyan-300">ollama pull llama3.2:3b</code>).</div>}
            {ai.res && !ai.res.ok && <div className="mt-3 text-xs text-amber-200 font-mono border border-amber-500/40 bg-amber-500/10 rounded px-3 py-2"><ShieldAlert size={13} className="inline mr-1" />AI text withheld (fail-closed): {ai.res.reason}</div>}
            {aiOk && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Badge tone="emerald"><ShieldCheck size={12} /> Server guardrail PASS · {aiOk.checked} entities</Badge>
                  <Badge tone="emerald"><ShieldCheck size={12} /> Browser re-check PASS · {aiOk.clientChecked} entities</Badge>
                  <Badge tone="slate">{aiOk.backend} · {aiOk.model} · attempt {aiOk.attempts}{aiOk.removedSentences ? ` · ${aiOk.removedSentences} unverified sentence(s) removed` : ""}</Badge>
                </div>
                <div className="text-sm text-slate-200 whitespace-pre-line leading-relaxed bg-slate-900/50 border border-cyan-500/15 rounded-lg p-4">{aiOk.text}</div>
              </div>
            )}
          </Panel>

          <div id="print-area" className="bg-white text-black rounded-lg p-8 font-serif text-[13px] leading-relaxed max-w-4xl mx-auto w-full">
            {tab === "diary" ? (
              <div>
                <div className="text-center font-bold text-base">POLICE CASE DIARY — CYBER FINANCIAL FRAUD</div>
                <div className="text-center text-xs mb-3">{hdr} | Generated: {today}</div>
                {gen.diary.map((l, i) => l.startsWith("## ")
                  ? <div key={i} className="font-bold mt-4 border-b border-black/40">{l.slice(3)}</div>
                  : <div key={i} className="font-mono text-[11px] py-0.5 break-all">{l}</div>)}
                {gen.timeline.map((l, i) => l.startsWith("## ")
                  ? <div key={"t" + i} className="font-bold mt-4 border-b border-black/40">{l.slice(3)}</div>
                  : <div key={"t" + i} className="font-mono text-[11px] py-0.5 break-all">{l}</div>)}
                {gen.remarks && <><div className="font-bold mt-4 border-b border-black/40">4. OFFICER REMARKS (sanitized text)</div><div className="py-1">{gen.remarks}</div></>}
                {aiOk && <><div className="font-bold mt-4 border-b border-black/40">5. AI-ASSISTED SUMMARY (every entity verified against the transaction graph)</div><div className="py-1 whitespace-pre-line">{aiOk.text}</div></>}
              </div>
            ) : gen.notices.length === 0 ? <div>No holding accounts identified for freezing.</div> : gen.notices.map((n) => (
              <div key={n.bank} className="print-break mb-10">
                <div className="text-center font-bold">NOTICE / REQUISITION — SECTION 94 BNSS, 2023 (formerly Section 91 CrPC)</div>
                <div className="text-center text-xs mb-3">with request for debit-freeze under Section 106 BNSS, 2023 (formerly Section 102 CrPC)</div>
                <div>To,<br />The Nodal Officer,<br /><b>{n.bank}</b></div>
                <div className="mt-2 text-xs">{hdr} | Date: {today}</div>
                <p className="mt-3">Sub: Immediate freezing of beneficiary accounts and production of records — proceeds of cyber financial fraud traced from victim account <b>{gen.facts.victimAccount}</b> ({gen.facts.victimBank}{gen.facts.victimIfsc ? ", IFSC " + gen.facts.victimIfsc : ""}).</p>
                <p className="mt-2">In the above-referred investigation, funds of {inr(gen.facts.totalSiphoned)} were fraudulently diverted from the victim account between {tsText(gen.facts.firstTs)} and {tsText(gen.facts.lastTs)} and layered through mule accounts. The following accounts maintained with your bank received the disputed transactions and presently hold traced proceeds of <b>{inr(n.total)}</b>. You are requested to (1) place an immediate debit-freeze / lien on the accounts up to the amounts shown, (2) preserve and furnish within 7 days the KYC / account-opening documents, account statements, linked mobile / e-mail, login IP and device logs, and ATM / CCTV records for the disputed transactions, and (3) acknowledge compliance.</p>
                <table className="w-full mt-3 border border-black text-[11px] font-mono">
                  <thead><tr className="bg-gray-200">{["S.No", "Beneficiary A/c", "IFSC", "Disputed Txn ID", "Remitter A/c", "Date & time", "Amount"].map((h) => <th key={h} className="border border-black px-1 py-0.5 text-left">{h}</th>)}</tr></thead>
                  <tbody>{n.accounts.flatMap((a, ai) => a.txns.map((t, ti) => (
                    <tr key={a.c.acc + t.txnId + ti}><td className="border border-black px-1">{ai + 1}.{ti + 1}</td><td className="border border-black px-1">{a.c.account}</td><td className="border border-black px-1">{a.c.ifsc || "—"}</td><td className="border border-black px-1">{t.txnId}</td><td className="border border-black px-1">{t.from}</td><td className="border border-black px-1">{tsText(t.ts)}</td><td className="border border-black px-1 text-right">{inr(t.amount)}</td></tr>
                  )))}</tbody>
                </table>
                <div className="mt-8 text-xs">Investigating Officer: {ioS || "________"}<br />Signature &amp; Seal: ____________________</div>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-slate-500 font-mono px-1">Generation is deterministic and graph-grounded (no free-form model output). Every account, IFSC, transaction ID and ₹ amount in the documents is re-verified against the trace; officer remarks are treated as untrusted, stripped of markup / instruction phrases and rendered as inert text. Statutory section mapping (BNSS ↔ CrPC) should be confirmed by the legal cell before service.</div>
        </>
      )}
    </div>
  );
}
