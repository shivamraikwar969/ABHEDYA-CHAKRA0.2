import { useEffect, useMemo, useState } from "react";
import { Play, Pause, Download, Crosshair, Route as RouteIcon, AlertOctagon } from "lucide-react";
import { useStore, fmtINR, fmtNum, fmtTs } from "@/store";
import { Panel, Stat, Button, Input, Empty, Badge, RiskBadge, LayerBadge, Th, Td } from "@/components/ui";
import { ForceGraph } from "@/components/ForceGraph";
import { traceTrail, DEFAULT_TRAIL_OPTIONS } from "@/engine/trail";
import { exportRowsCSV, isolateRing, rowsToGraph } from "@/engine/forensics";
import type { TrailResult } from "@/engine/types";
import { ExitPanel, HowToRead } from "@/components/ExitFlow";
import { computeExits, leafTags } from "@/engine/exits";

export function FlowView() {
  const { dataset, analytics, version, selectAccount, openEvidence, demoHints } = useStore();
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tr, setTr] = useState<TrailResult | null>(null);
  const [ring, setRing] = useState<{ seed: number; rows: number[] } | null>(null);
  const [cur, setCur] = useState<number | null>(null); // null = show everything
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5); // minutes of simulated time per 250ms tick

  const g = useMemo(() => {
    if (!dataset || !analytics) return null;
    if (ring) return rowsToGraph(dataset, analytics, ring.rows);
    if (tr) { const hops = new Map<number, number>(); tr.edges.forEach((e) => hops.set(e.row, e.hop)); return rowsToGraph(dataset, analytics, tr.edges.slice(0, 1500).map((e) => e.row), hops); }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, analytics, tr, ring, version]);

  const [lo, hi] = useMemo(() => {
    let a = Infinity, b = -Infinity;
    g?.edges.forEach((e) => { if (!isNaN(e.ts)) { if (e.ts < a) a = e.ts; if (e.ts > b) b = e.ts; } });
    return isFinite(a) ? [Math.floor(a / 60000) * 60000, Math.ceil(b / 60000) * 60000] : [0, 0];
  }, [g]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setCur((c) => Math.min(hi, (c ?? lo) + speed * 60000)), 250);
    return () => clearInterval(id);
  }, [playing, speed, lo, hi]);
  useEffect(() => { if (playing && cur !== null && cur >= hi) setPlaying(false); }, [playing, cur, hi]);

  const shown = useMemo(() => {
    if (!g) return { n: 0, amt: 0 };
    let n = 0, amt = 0;
    for (const e of g.edges) if (cur === null || isNaN(e.ts) || e.ts <= cur) { n++; if (e.amount >= 0) amt += e.amount; }
    return { n, amt };
  }, [g, cur]);

  // "Where did the money go?" - recomputed as the playback cursor moves, so leaf nodes show crypto / ATM / wallet exits as they happen
  const exits = useMemo(() => (dataset && analytics && g ? computeExits(dataset, analytics, g.edges.map((e) => e.row), cur) : null), [dataset, analytics, g, cur]);
  const tags = useMemo(() => (exits ? leafTags(exits) : undefined), [exits]);

  if (!dataset || !analytics) return <Empty title="No dataset loaded">Ingest a CSV to trace and replay money flows.</Empty>;

  const resolve = (): number | null => {
    const v = q.trim();
    const idx = dataset.accountIndex.get(v);
    if (idx === undefined) { setErr(`Account "${v}" does not exist in the loaded dataset.`); return null; }
    setErr(null); return idx;
  };
  const trace = (id?: string) => {
    if (id) setQ(id);
    const idx = id ? dataset.accountIndex.get(id) : resolve();
    if (idx === undefined || idx === null) return;
    if (analytics.outCount[idx] === 0) { setErr(`Account has no outbound transactions — nothing to trace.`); return; }
    setErr(null); setRing(null); setCur(null); setPlaying(false);
    setTr(traceTrail(dataset, analytics, idx, DEFAULT_TRAIL_OPTIONS));
  };
  const isolate = (idx: number) => { setRing({ seed: idx, rows: isolateRing(dataset, analytics, idx).rows }); setCur(null); setPlaying(false); };
  const download = () => {
    const rows = ring ? ring.rows : tr ? tr.edges.map((e) => e.row) : [];
    const blob = new Blob([exportRowsCSV(dataset, rows)], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `setu_${ring ? "ring_" + dataset.accounts[ring.seed] : "trail_" + (tr ? dataset.accounts[tr.victim] : "")}.csv`; a.click();
  };
  const play = () => { if (cur === null || cur >= hi) setCur(lo); setPlaying((p) => !p); };
  const fmtCur = cur === null ? "ALL (live end-state)" : fmtTs(cur);

  return (
    <div className="space-y-4">
      <Panel title="Victim / suspect account" icon={<RouteIcon size={13} />} strong>
        <div className="flex flex-wrap gap-2 items-end">
          <Input value={q} onChange={setQ} placeholder="Victim account ID → trace · any suspect → isolate ring" className="flex-1 min-w-[280px]" onKeyDown={(e) => { if (e.key === "Enter") trace(); }} />
          <Button onClick={() => trace()}><Play size={12} className="inline mr-1" />Trace flow</Button>
          <Button variant="ghost" onClick={() => { const i = resolve(); if (i !== null) isolate(i); }}><Crosshair size={12} className="inline mr-1" />Isolate ring</Button>
          {ring && <Button variant="danger" onClick={() => { setRing(null); setCur(null); }}>Exit isolation</Button>}
        </div>
        {demoHints && <div className="mt-3 text-[11px] font-mono text-slate-500 flex flex-wrap gap-1 items-center"><span className="mr-1">Synthetic victims:</span>{demoHints.victims.slice(0, 8).map((v) => <button key={v} onClick={() => trace(v)} className="px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10">{v}</button>)}</div>}
        {err && <div className="mt-3 text-xs text-red-200 font-mono border border-red-500/50 bg-red-500/10 rounded px-3 py-2 flex items-center gap-2"><AlertOctagon size={14} /> {err}</div>}
      </Panel>

      <HowToRead context="flow" />

      {!g ? <Empty title="Awaiting account">Trace a victim to see the hierarchical flow, replay it minute-by-minute, then click any node to isolate its whole syndicate ring.</Empty> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label={ring ? "Isolated ring" : "Trail"} value={<span className="text-sm break-all">{ring ? dataset.accounts[ring.seed] : tr ? dataset.accounts[tr.victim] : ""}</span>} accent="cyan" />
            <Stat label="Nodes · edges" value={`${fmtNum(g.nodes.length)} · ${fmtNum(g.edges.length)}`} />
            <Stat label="Visible at cursor" value={`${fmtNum(shown.n)} txns`} sub={fmtINR(shown.amt) + " in motion"} accent="amber" />
            <Stat label="Cursor" value={<span className="text-sm">{fmtCur}</span>} accent="emerald" />
          </div>
          <div className="glass rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
            <Button onClick={play} disabled={hi <= lo}>{playing ? <><Pause size={12} className="inline mr-1" />Pause</> : <><Play size={12} className="inline mr-1" />Play</>}</Button>
            <input type="range" className="flex-1 min-w-[240px]" min={lo} max={hi} step={60000} disabled={hi <= lo} value={cur ?? hi} onChange={(e) => { setPlaying(false); setCur(Number(e.target.value)); }} />
            <label className="text-[11px] font-mono text-slate-400 flex items-center gap-2">speed
              {[1, 5, 30, 180].map((s) => <Button key={s} variant={speed === s ? "toggle-on" : "toggle-off"} className="px-2 py-1" onClick={() => setSpeed(s)}>{s}m/s</Button>)}
            </label>
            <Button variant="ghost" onClick={() => { setCur(null); setPlaying(false); }}>Show all</Button>
            <Button variant="ghost" onClick={download}><Download size={12} className="inline mr-1" />Export sub-dataset</Button>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-2 glass rounded-xl p-1 min-h-[520px]">
              <ForceGraph nodes={g.nodes} edges={g.edges} showTxnIds={false} showAmounts={g.edges.length <= 150} timeCursor={cur} highlight={ring ? ring.seed : tr?.victim} leafInfo={tags}
                onNodeClick={isolate} onEdgeClick={openEvidence} />
            </div>
            <Panel title={ring ? "Ring members" : "Accounts in trail"} className="[&>div:last-child]:p-0">
              <div className="max-h-[520px] overflow-auto"><table className="w-full">
                <thead className="sticky top-0 bg-[#060b18]"><tr><Th>Account</Th><Th>Risk</Th><Th>Layer</Th></tr></thead>
                <tbody>{[...g.nodes].sort((x, y) => y.risk - x.risk).slice(0, 120).map((n) => (
                  <tr key={n.id} onClick={() => isolate(n.id)} className="cursor-pointer hover:bg-cyan-500/5"><Td>{n.label}</Td><Td><RiskBadge risk={n.risk} /></Td><Td><LayerBadge layer={n.layer} /></Td></tr>
                ))}</tbody></table></div>
            </Panel>
          </div>
          {exits && <ExitPanel ex={exits} ds={dataset} cur={cur} onPick={(a) => selectAccount(a, true)} />}
          <div className="text-[11px] text-slate-500 font-mono px-1">Hierarchy: victim/sources at the top, one level per hop. Click a node (or a row) to isolate its syndicate ring — suspicious neighbours (MED+ risk, L1–L3 or cash-out signals) reachable up to 400 accounts. <Badge tone="slate" className="shadow-none">Export</Badge> writes the exact original CSV records. <button className="underline" onClick={() => selectAccount(ring ? ring.seed : (tr?.victim ?? null), true)}>Open risk profile</button></div>
        </>
      )}
    </div>
  );
}
