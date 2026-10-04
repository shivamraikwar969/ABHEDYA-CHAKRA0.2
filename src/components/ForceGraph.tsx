import { useEffect, useRef, useState } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type Simulation, type SimulationNodeDatum, type SimulationLinkDatum } from "d3-force";
import { riskColor } from "@/engine/analytics";
import { abbr, fmtTs } from "@/store";
import type { LeafTag } from "@/engine/exits";

export interface GNode extends SimulationNodeDatum { id: number; label: string; risk: number; degree: number; layer: number; }
export interface GEdge extends SimulationLinkDatum<GNode> { row: number; txnId: string; amount: number; ts: number; flagged: boolean; hop?: number; }

interface Props {
  nodes: GNode[];
  edges: GEdge[];
  showTxnIds: boolean;
  showAmounts: boolean;
  highlight?: number | null;
  onNodeClick?: (id: number) => void;
  onEdgeClick?: (row: number) => void;
  className?: string;
  timeCursor?: number | null; // temporal playback: edges later than this are hidden
  layout?: "tree" | "force";
  leafInfo?: Map<number, LeafTag[]>; // "where the money went" tags drawn under leaf nodes (crypto / ATM / wallet ...)
}

const HOP_COLORS = ["#06b6d4", "#22d3ee", "#f59e0b", "#f97316", "#ef4444"];

export function ForceGraph({ nodes, edges, showTxnIds, showAmounts, highlight, onNodeClick, onEdgeClick, className, timeCursor, layout: initialLayout, leafInfo }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<GNode, GEdge> | null>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const hover = useRef<{ node?: GNode; edge?: GEdge; mx: number; my: number } | null>(null);
  const drag = useRef<{ node?: GNode; panStart?: { x: number; y: number; vx: number; vy: number }; moved: boolean } | null>(null);
  const propsRef = useRef({ nodes, edges, showTxnIds, showAmounts, highlight, timeCursor, leafInfo });
  propsRef.current = { nodes, edges, showTxnIds, showAmounts, highlight, timeCursor, leafInfo };
  const [layout, setLayout] = useState<"tree" | "force">(initialLayout ?? "tree");
  const layoutRef = useRef(layout); // read inside draw() without re-creating it
  layoutRef.current = layout;
  const levelRef = useRef<{ l: number; y: number }[]>([]); // hierarchy rows (for the plain-language level guide)
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const frame = useRef(0);

  const draw = () => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const { nodes, edges, showTxnIds, showAmounts, highlight, timeCursor: cur, leafInfo: leafTags } = propsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { x, y, k } = view.current;
    ctx.translate(x, y); ctx.scale(k, k);
    let reached: Set<number> | null = null;
    if (cur != null) {
      reached = new Set<number>();
      if (highlight != null) reached.add(highlight);
      for (const e of edges) if (isNaN(e.ts) || e.ts <= cur) { reached.add((e.source as GNode).id); reached.add((e.target as GNode).id); }
    }
    const hov = hover.current;
    const neighbors = new Set<number>();
    if (hov?.node) { for (const e of edges) { const s = e.source as GNode, t = e.target as GNode; if (s.id === hov.node.id) neighbors.add(t.id); if (t.id === hov.node.id) neighbors.add(s.id); } }
    const labelEdges = edges.length <= 400;
    const lay = layoutRef.current;
    const hasOut = new Set<number>(); // accounts that pass money on (everything else is a LEAF = final stop)
    for (const e of edges) hasOut.add((e.source as GNode).id);
    const isTrail = edges.some((e) => e.hop);
    // ----- plain-language level guide (hierarchy layout only): one labelled band per level -----
    const lv = levelRef.current;
    if (lay === "tree" && lv.length > 1) {
      const left = -x / k + 10 / k;
      const rightEdge = (W - x) / k;
      lv.forEach((L, i) => {
        if (i % 2 === 0) { ctx.fillStyle = "rgba(6,182,212,0.035)"; ctx.fillRect(-x / k, L.y - 100, rightEdge + x / k, 200); }
        ctx.strokeStyle = "rgba(6,182,212,0.18)"; ctx.lineWidth = 1 / k; ctx.setLineDash([6 / k, 6 / k]);
        ctx.beginPath(); ctx.moveTo(-x / k, L.y - 100); ctx.lineTo(rightEdge, L.y - 100); ctx.stroke(); ctx.setLineDash([]);
        const [title, sub] = levelText(i, lv.length - 1, isTrail);
        ctx.font = `bold ${11 / k}px JetBrains Mono, monospace`; ctx.textAlign = "left"; ctx.textBaseline = "top";
        const w = Math.max(ctx.measureText(title).width, (ctx.font = `${9 / k}px Inter, sans-serif`, ctx.measureText(sub).width)) + 14 / k;
        ctx.fillStyle = "rgba(3,7,18,0.82)"; ctx.fillRect(left - 4 / k, L.y - 94, w, 34 / k);
        ctx.font = `bold ${11 / k}px JetBrains Mono, monospace`; ctx.fillStyle = i === lv.length - 1 ? "#fbbf24" : "#67e8f9"; ctx.fillText(title, left, L.y - 91);
        ctx.font = `${9 / k}px Inter, sans-serif`; ctx.fillStyle = "#94a3b8"; ctx.fillText(sub, left, L.y - 91 + 15 / k);
      });
    }
    // edges
    for (const e of edges) {
      const s = e.source as GNode, t = e.target as GNode;
      if (s.x === undefined || t.x === undefined) continue;
      if (cur != null && !(isNaN(e.ts) || e.ts <= cur)) continue;
      const dim = hov?.node && !(s.id === hov.node.id || t.id === hov.node.id);
      const color = e.hop ? HOP_COLORS[e.hop] : e.flagged ? "#ef4444" : "rgba(103,232,249,0.55)";
      ctx.globalAlpha = dim ? 0.08 : e.flagged ? 0.95 : 0.6;
      ctx.strokeStyle = color; ctx.lineWidth = (e.flagged ? 1.6 : 1) / Math.sqrt(k);
      const dx = t.x! - s.x!, dy = t.y! - s.y!, len = Math.hypot(dx, dy) || 1;
      const rT = radius(t);
      const ex = t.x! - (dx / len) * (rT + 2), ey = t.y! - (dy / len) * (rT + 2);
      ctx.beginPath(); ctx.moveTo(s.x!, s.y!); ctx.lineTo(ex, ey); ctx.stroke();
      // arrow head
      const ah = 6 / Math.sqrt(k);
      const ang = Math.atan2(dy, dx);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - ah * Math.cos(ang - 0.4), ey - ah * Math.sin(ang - 0.4)); ctx.lineTo(ex - ah * Math.cos(ang + 0.4), ey - ah * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill();
      if (!dim && (labelEdges || hov?.edge === e) && (showAmounts || (showTxnIds && e.flagged))) {
        const mx = (s.x! + t.x!) / 2, my = (s.y! + t.y!) / 2;
        ctx.font = `${10 / k}px JetBrains Mono, monospace`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        let label = "";
        if (showAmounts) label += "₹" + abbr(e.amount);
        if (showTxnIds && (e.flagged || e.hop)) label += (label ? " · " : "") + e.txnId;
        if (label) {
          const w = ctx.measureText(label).width + 6 / k;
          ctx.fillStyle = "rgba(3,7,18,0.85)";
          ctx.fillRect(mx - w / 2, my - 7 / k, w, 14 / k);
          ctx.fillStyle = e.flagged ? "#fca5a5" : "#a5f3fc";
          ctx.fillText(label, mx, my);
        }
      }
    }
    ctx.globalAlpha = 1;
    // nodes
    for (const n of nodes) {
      if (n.x === undefined) continue;
      const r = radius(n);
      const color = riskColor(n.risk);
      const isH = highlight === n.id, isHov = hov?.node === n;
      const dim = (hov?.node && !isHov && !neighbors.has(n.id)) || (reached && !reached.has(n.id));
      ctx.globalAlpha = dim ? 0.15 : 1;
      if (n.risk >= 70 || isH) { ctx.shadowColor = isH ? "#22d3ee" : color; ctx.shadowBlur = isH ? 22 : 14; } else ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
      ctx.fillStyle = color + (n.risk >= 70 ? "ee" : "aa"); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = (isH ? 2.5 : 1) / k; ctx.strokeStyle = isH ? "#fff" : color; ctx.stroke();
      if (k > 0.8 || isH || isHov || n.risk >= 70 || nodes.length <= 60 || (lay === "tree" && nodes.length <= 150)) {
        ctx.font = `${(isH ? 11 : 9.5) / k}px JetBrains Mono, monospace`;
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillStyle = isH ? "#e0f2fe" : n.risk >= 70 ? "#fecaca" : "#94a3b8";
        ctx.fillText(n.label, n.x!, n.y! + r + 3 / k);
      }
      // plain-language role above the node (hierarchy layout)
      if (lay === "tree" && (k > 0.5 || nodes.length <= 60) && !dim) {
        const leaf = !hasOut.has(n.id);
        const role = isH ? (isTrail ? "VICTIM" : "START") : leaf ? "LEAF · FINAL STOP" : n.layer === 1 ? "COLLECTOR" : n.layer === 2 ? "DISTRIBUTOR" : n.layer === 3 ? "INDICATOR" : "RELAY";
        ctx.font = `bold ${8.5 / k}px JetBrains Mono, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillStyle = isH ? "#22d3ee" : leaf ? "#fbbf24" : "#64748b";
        ctx.fillText(role, n.x!, n.y! - r - 4 / k);
      }
      // "where did the money go" tags under leaf nodes (crypto / ATM / wallet ...)
      const tags = leafTags?.get(n.id);
      if (tags && !dim) {
        ctx.font = `bold ${9 / k}px JetBrains Mono, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "top";
        tags.forEach((t, ti) => {
          const ty = n.y! + r + 3 / k + (13 + ti * 13) / k;
          const tw = ctx.measureText(t.text).width + 8 / k;
          ctx.fillStyle = "rgba(3,7,18,0.88)"; ctx.fillRect(n.x! - tw / 2, ty - 1 / k, tw, 12 / k);
          ctx.strokeStyle = t.color; ctx.lineWidth = 1 / k; ctx.strokeRect(n.x! - tw / 2, ty - 1 / k, tw, 12 / k);
          ctx.fillStyle = t.color; ctx.fillText(t.text, n.x!, ty);
        });
      }
    }
    ctx.restore();
  };

  // Simulation lifecycle
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current; if (!canvas || !wrap) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    simRef.current?.stop();
    simRef.current = null;
    view.current = { x: 0, y: 0, k: 1 };
    levelRef.current = [];
    if (layout === "tree") {
      const t = treeLayout(nodes, edges, propsRef.current.highlight, W, H);
      view.current = { k: t.k, x: t.x, y: t.y };
      levelRef.current = t.levels;
      frame.current = requestAnimationFrame(draw);
      return () => cancelAnimationFrame(frame.current);
    }
    const sim = forceSimulation<GNode, GEdge>(nodes)
      .force("link", forceLink<GNode, GEdge>(edges).id((d) => d.id).distance(nodes.length > 150 ? 40 : 80).strength(0.5))
      .force("charge", forceManyBody().strength(nodes.length > 300 ? -40 : -160).distanceMax(400))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide<GNode>().radius((d) => radius(d) + 4));
    sim.alphaDecay(nodes.length > 300 ? 0.05 : 0.03);
    sim.on("tick", () => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(draw); });
    simRef.current = sim;
    return () => { sim.stop(); cancelAnimationFrame(frame.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, layout]);

  useEffect(() => { frame.current = requestAnimationFrame(draw); }); // redraw on any prop change

  // resize
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current; if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.clientWidth * dpr; canvas.height = wrap.clientHeight * dpr;
      canvas.style.width = wrap.clientWidth + "px"; canvas.style.height = wrap.clientHeight + "px";
      draw();
    });
    ro.observe(wrap);
    const stopWheel = (e: WheelEvent) => e.preventDefault();
    canvas.addEventListener("wheel", stopWheel, { passive: false });
    return () => { ro.disconnect(); canvas.removeEventListener("wheel", stopWheel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toWorld = (cx: number, cy: number) => ({ x: (cx - view.current.x) / view.current.k, y: (cy - view.current.y) / view.current.k });
  const pick = (cx: number, cy: number) => {
    const p = toWorld(cx, cy);
    const { nodes, edges } = propsRef.current;
    let best: GNode | undefined, bd = Infinity;
    for (const n of nodes) { if (n.x === undefined) continue; const d = Math.hypot(n.x! - p.x, n.y! - p.y); if (d < radius(n) + 4 / view.current.k && d < bd) { bd = d; best = n; } }
    if (best) return { node: best };
    let be: GEdge | undefined; bd = 6 / view.current.k;
    for (const e of edges) {
      const s = e.source as GNode, t = e.target as GNode; if (s.x === undefined || t.x === undefined) continue;
      const d = distToSeg(p.x, p.y, s.x!, s.y!, t.x!, t.y!); if (d < bd) { bd = d; be = e; }
    }
    return be ? { edge: be } : {};
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const hit = pick(cx, cy);
    if (hit.node) { drag.current = { node: hit.node, moved: false }; hit.node.fx = hit.node.x; hit.node.fy = hit.node.y; simRef.current?.alphaTarget(0.2).restart(); }
    else drag.current = { panStart: { x: cx, y: cy, vx: view.current.x, vy: view.current.y }, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const d = drag.current;
    if (d) {
      d.moved = true;
      if (d.node) { const p = toWorld(cx, cy); d.node.fx = p.x; d.node.fy = p.y; if (!simRef.current) { d.node.x = p.x; d.node.y = p.y; draw(); } }
      else if (d.panStart) { view.current.x = d.panStart.vx + (cx - d.panStart.x); view.current.y = d.panStart.vy + (cy - d.panStart.y); draw(); }
      return;
    }
    const hit = pick(cx, cy);
    hover.current = { ...hit, mx: cx, my: cy };
    if (hit.node) setTip({ x: cx, y: cy, lines: [hit.node.label, `risk ${hit.node.risk} · degree ${hit.node.degree}`] });
    else if (hit.edge) setTip({ x: cx, y: cy, lines: [hit.edge.txnId, `₹${hit.edge.amount.toLocaleString("en-IN")}`, fmtTs(hit.edge.ts)].filter((l) => l && l !== "—") });
    else setTip(null);
    canvasRef.current!.style.cursor = hit.node || hit.edge ? "pointer" : "grab";
    draw();
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    if (d.node) { d.node.fx = null; d.node.fy = null; simRef.current?.alphaTarget(0); if (!d.moved) onNodeClick?.(d.node.id); }
    else if (!d.moved) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (hit.edge) onEdgeClick?.(hit.edge.row);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const v = view.current; const nk = Math.min(8, Math.max(0.1, v.k * f));
    v.x = cx - (cx - v.x) * (nk / v.k); v.y = cy - (cy - v.y) * (nk / v.k); v.k = nk;
    draw();
  };

  return (
    <div ref={wrapRef} className={"relative w-full h-full grid-bg rounded-lg overflow-hidden " + (className ?? "")}>
      <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={() => { drag.current = null; hover.current = null; setTip(null); draw(); }} onWheel={onWheel} className="block" />
      <div className="absolute top-2 right-3 flex gap-1 z-10">
        {(["tree", "force"] as const).map((l) => (
          <button key={l} onClick={() => setLayout(l)} className={"px-2 py-0.5 rounded border text-[9px] font-mono uppercase tracking-wider " + (layout === l ? "bg-cyan-500/25 border-cyan-400 text-cyan-100" : "bg-slate-900/60 border-slate-600/50 text-slate-400 hover:border-cyan-400/40")}>{l === "tree" ? "Hierarchy" : "Force"}</button>
        ))}
      </div>
      {tip && (
        <div className="absolute pointer-events-none glass rounded px-2 py-1 text-[10px] font-mono text-cyan-100 z-10" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          {tip.lines.map((l, i) => <div key={i} className={i === 0 ? "text-cyan-300" : "text-slate-300"}>{l}</div>)}
        </div>
      )}
      <div className="absolute bottom-2 left-3 text-[10px] font-mono text-slate-500 pointer-events-none">{nodes.length} nodes · {edges.length} edges · scroll to zoom · drag to pan</div>
    </div>
  );
}

function radius(n: GNode) { return 4 + Math.min(14, Math.log2(n.degree + 1) * 2); }
function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / l2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Layered top-down hierarchy: victim/sources on top, each hop one level lower, children ordered by parent barycentre. Returns a fitted viewport. */
function treeLayout(nodes: GNode[], edges: GEdge[], root: number | null | undefined, W: number, H: number) {
  const idOf = (v: GNode | string | number) => (typeof v === "object" ? v.id : Number(v));
  const byId = new Map<number, GNode>();
  nodes.forEach((n) => byId.set(n.id, n));
  const nb = new Map<number, { id: number; d: number }[]>();
  const indeg = new Map<number, number>();
  nodes.forEach((n) => { nb.set(n.id, []); indeg.set(n.id, 0); });
  for (const e of edges) {
    const s = idOf(e.source), t = idOf(e.target);
    if (s === t || !byId.has(s) || !byId.has(t)) continue;
    nb.get(s)!.push({ id: t, d: 1 }); nb.get(t)!.push({ id: s, d: -1 });
    indeg.set(t, indeg.get(t)! + 1);
    e.source = byId.get(s)!; e.target = byId.get(t)!;
  }
  const level = new Map<number, number>();
  const bfs = (starts: number[], signed: boolean) => {
    const q = [...starts];
    starts.forEach((s) => level.set(s, 0));
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      for (const { id, d } of nb.get(c)!) {
        if (level.has(id) || (!signed && d < 0)) continue;
        level.set(id, level.get(c)! + d); q.push(id);
      }
    }
  };
  if (root != null && byId.has(root)) bfs([root], true);
  else bfs(nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id), false);
  for (const n of [...nodes].sort((a, b) => b.degree - a.degree)) if (!level.has(n.id)) bfs([n.id], true);
  let mn = Infinity;
  level.forEach((v) => { if (v < mn) mn = v; });
  const rows = new Map<number, GNode[]>();
  nodes.forEach((n) => { const l = level.get(n.id)! - mn; if (!rows.has(l)) rows.set(l, []); rows.get(l)!.push(n); });
  const gx = nodes.length <= 60 ? 170 : nodes.length <= 200 ? 130 : 100, gy = 200; // spread out so a beginner can follow each level
  const xpos = new Map<number, number>();
  const levels: { l: number; y: number }[] = [];
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  for (const l of [...rows.keys()].sort((a, b) => a - b)) {
    const arr = rows.get(l)!;
    levels.push({ l, y: l * gy });
    const key = new Map<GNode, number>();
    for (const n of arr) {
      const xs = nb.get(n.id)!.filter((o) => level.get(o.id)! - mn === l - 1 && xpos.has(o.id)).map((o) => xpos.get(o.id)!);
      key.set(n, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity);
    }
    arr.sort((a, b) => key.get(a)! - key.get(b)! || b.risk - a.risk);
    arr.forEach((n, i) => {
      n.x = (i - (arr.length - 1) / 2) * gx;
      n.y = l * gy + (arr.length > 8 ? (i % 3) * 44 : 0);
      xpos.set(n.id, n.x);
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y;
    });
  }
  const k = Math.max(0.04, Math.min(1.2, W / (maxX - minX + 160), H / (maxY + 160)));
  return { k, x: W / 2 - ((minX + maxX) / 2) * k, y: Math.max(36, (H - maxY * k) / 2), levels };
}

/** Plain-language caption for each hierarchy level, written for people with no security background. */
function levelText(i: number, last: number, trail: boolean): [string, string] {
  if (i === last && last > 0) return [`LEVEL ${i} · FINAL STOP (LEAF)`, "Where the money finally left the chain - cash, crypto, wallet or still parked"];
  if (i === 0) return trail ? ["LEVEL 0 · VICTIM", "The person who was cheated - the stolen money starts here"] : ["LEVEL 0 · START OF THE CHAIN", "The account you clicked - money is followed downwards from here"];
  if (i === 1) return ["LEVEL 1 · COLLECTORS (L1 mule accounts)", "First accounts that received the money directly - often rented bank accounts"];
  if (i === 2) return ["LEVEL 2 · DISTRIBUTORS (L2 mule accounts)", "Split the money into smaller pieces and pass it on quickly to hide the trail"];
  if (i === 3) return ["LEVEL 3 · INDICATORS (L3 mule accounts)", "Move the pieces again, usually just before cashing out"];
  return [`LEVEL ${i} · FURTHER HOPS`, "The money keeps moving to more accounts"];
}
