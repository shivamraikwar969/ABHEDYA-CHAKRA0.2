import type { ReactNode } from "react";
import { cn } from "@/utils/cn";
import { riskColor, HIGH_RISK, MED_RISK } from "@/engine/analytics";

export function Panel({ title, icon, actions, children, className, strong }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; strong?: boolean }) {
  return (
    <section className={cn("glass rounded-xl relative overflow-hidden", strong && "glass-strong", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-cyan-500/15">
          <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-cyan-300/90">
            {icon}
            {title}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: "cyan" | "red" | "amber" | "violet" | "emerald" }) {
  const colors = { cyan: "text-cyan-300", red: "text-red-400", amber: "text-amber-300", violet: "text-violet-300", emerald: "text-emerald-300" };
  return (
    <div className="glass rounded-lg px-4 py-3 flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className={cn("font-mono text-xl font-semibold", accent ? colors[accent] : "text-slate-100")}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 font-mono">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = "cyan", className, pulse }: { children: ReactNode; tone?: "cyan" | "red" | "amber" | "slate" | "violet" | "emerald"; className?: string; pulse?: boolean }) {
  const tones = {
    cyan: "bg-cyan-500/10 text-cyan-300 border-cyan-400/40",
    red: "bg-red-500/15 text-red-300 border-red-500/60 glow-red",
    amber: "bg-amber-500/10 text-amber-300 border-amber-400/40",
    slate: "bg-slate-500/10 text-slate-300 border-slate-500/40",
    violet: "bg-violet-500/10 text-violet-300 border-violet-400/40",
    emerald: "bg-emerald-500/10 text-emerald-300 border-emerald-400/40",
  };
  return <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono font-semibold tracking-wider uppercase whitespace-nowrap", tones[tone], pulse && "pulse-red", className)}>{children}</span>;
}

export function RiskBadge({ risk }: { risk: number }) {
  const tone = risk >= HIGH_RISK ? "red" : risk >= MED_RISK ? "amber" : "cyan";
  return <Badge tone={tone} pulse={risk >= 90}>{risk >= HIGH_RISK ? "HIGH" : risk >= MED_RISK ? "MED" : "LOW"} · {risk}</Badge>;
}

export function LayerBadge({ layer }: { layer: number }) {
  const map: Record<number, { t: "slate" | "red" | "amber" | "violet"; l: string }> = {
    0: { t: "slate", l: "ENDPOINT" }, 1: { t: "red", l: "L1 COLLECTOR" }, 2: { t: "amber", l: "L2 DISTRIBUTOR" }, 3: { t: "violet", l: "L3 INDICATOR" },
  };
  const m = map[layer] ?? map[0];
  return <Badge tone={m.t} className={m.t === "red" ? "shadow-none" : ""}>{m.l}</Badge>;
}

export function Button({ children, onClick, variant = "primary", className, disabled, type = "button", title }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "ghost" | "danger" | "toggle-on" | "toggle-off"; className?: string; disabled?: boolean; type?: "button" | "submit"; title?: string }) {
  const v = {
    primary: "bg-cyan-500/15 border-cyan-400/50 text-cyan-200 hover:bg-cyan-500/25 hover:glow-cyan",
    ghost: "bg-transparent border-slate-600/50 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-200",
    danger: "bg-red-500/15 border-red-500/50 text-red-200 hover:bg-red-500/25",
    "toggle-on": "bg-cyan-500/25 border-cyan-400 text-cyan-100 glow-cyan",
    "toggle-off": "bg-slate-800/40 border-slate-600/50 text-slate-400 hover:border-cyan-400/40",
  };
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={cn("px-3 py-1.5 rounded-md border text-[11px] font-mono font-semibold tracking-wider uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed", v[variant], className)}>
      {children}
    </button>
  );
}

export function Input({ value, onChange, placeholder, className, list, mono = true, onKeyDown }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; list?: string; mono?: boolean; onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void }) {
  return (
    <input value={value} list={list} onKeyDown={onKeyDown} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false}
      className={cn("bg-slate-900/60 border border-cyan-500/20 focus:border-cyan-400/70 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 rounded-md px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-600", mono && "font-mono", className)} />
  );
}

export function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cn("bg-slate-900/60 border border-cyan-500/20 focus:border-cyan-400/70 focus:outline-none rounded-md px-2 py-1.5 text-sm text-slate-100 font-mono", className)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Gauge({ value, size = 180 }: { value: number; size?: number }) {
  const r = size / 2 - 14;
  const c = Math.PI * r; // half circle
  const pct = Math.max(0, Math.min(100, value)) / 100;
  const color = riskColor(value);
  return (
    <svg width={size} height={size / 2 + 24} viewBox={`0 0 ${size} ${size / 2 + 24}`}>
      <defs>
        <linearGradient id="gaugeGrad" x1="0" x2="1">
          <stop offset="0%" stopColor="#06b6d4" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#ef4444" />
        </linearGradient>
      </defs>
      <path d={`M 14 ${size / 2 + 4} A ${r} ${r} 0 0 1 ${size - 14} ${size / 2 + 4}`} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth={12} strokeLinecap="round" />
      <path d={`M 14 ${size / 2 + 4} A ${r} ${r} 0 0 1 ${size - 14} ${size / 2 + 4}`} fill="none" stroke="url(#gaugeGrad)" strokeWidth={12} strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`} style={{ filter: `drop-shadow(0 0 8px ${color})`, transition: "stroke-dasharray .6s ease" }} />
      <text x={size / 2} y={size / 2 - 4} textAnchor="middle" fill={color} fontSize={38} fontWeight={700} fontFamily="JetBrains Mono, monospace" style={{ filter: `drop-shadow(0 0 10px ${color})` }}>{Math.round(value)}</text>
      <text x={size / 2} y={size / 2 + 18} textAnchor="middle" fill="#94a3b8" fontSize={10} fontFamily="JetBrains Mono, monospace" letterSpacing={2}>MULE RISK INDEX</text>
    </svg>
  );
}

export function Bar({ value, color = "#06b6d4", className, height = 6 }: { value: number; color?: string; className?: string; height?: number }) {
  return (
    <div className={cn("w-full bg-slate-800/70 rounded-full overflow-hidden", className)} style={{ height }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color, boxShadow: `0 0 8px ${color}` }} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="glass rounded-xl p-10 flex flex-col items-center justify-center text-center gap-2">
      <div className="text-cyan-300 font-mono text-sm tracking-widest uppercase">{title}</div>
      <div className="text-slate-500 text-sm max-w-md">{children}</div>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn("text-left text-[10px] uppercase tracking-[0.16em] text-cyan-300/70 font-semibold px-3 py-2 border-b border-cyan-500/15 whitespace-nowrap", className)}>{children}</th>;
}
export function Td({ children, className, mono = true, onClick }: { children?: ReactNode; className?: string; mono?: boolean; onClick?: () => void }) {
  return <td onClick={onClick} className={cn("px-3 py-1.5 text-xs border-b border-slate-800/60 whitespace-nowrap", mono && "font-mono", onClick && "cursor-pointer hover:text-cyan-300", className)}>{children}</td>;
}
