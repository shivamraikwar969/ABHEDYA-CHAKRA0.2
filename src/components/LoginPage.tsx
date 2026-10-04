import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertOctagon, Check, Eye, EyeOff, Lock, ShieldAlert, User } from "lucide-react";
import { cn } from "@/utils/cn";
import { authenticate, serverReachable } from "@/engine/auth";
import "./login.css";

type Mode = "login" | "signup";
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

/** Mirrors the server policy (server/security/passwords.mjs) so people get instant feedback; the server remains the authority. */
function strength(pw: string, user: string) {
  const checks = [
    { ok: pw.length >= 12, label: "12+ characters" },
    { ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), label: "Upper & lower case" },
    { ok: /\d/.test(pw), label: "A number" },
    { ok: /[^A-Za-z0-9]/.test(pw), label: "A symbol" },
  ];
  const score = checks.filter((c) => c.ok).length;
  const blocked = user.length >= 3 && pw.toLowerCase().includes(user.toLowerCase());
  return { checks, score, blocked, valid: pw.length >= 12 && pw.length <= 128 && !blocked };
}

export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; n: number } | null>(null);
  const [granted, setGranted] = useState(false);
  const [server, setServer] = useState<boolean | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const signup = mode === "signup";
  const st = useMemo(() => strength(password, username), [password, username]);

  useEffect(() => { userRef.current?.focus(); }, []);
  useEffect(() => { let live = true; const ping = () => serverReachable().then((v) => live && setServer(v)); ping(); const t = window.setInterval(ping, 8000); return () => { live = false; window.clearInterval(t); }; }, []);
  const switchMode = (m: Mode) => { if (busy || m === mode) return; setMode(m); setError(null); setConfirm(""); setShow(false); };
  const fail = (msg: string) => setError({ msg, n: (error?.n ?? 0) + 1 });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || granted) return;
    const u = username.trim();
    if (!USERNAME_RE.test(u)) return fail("Username must be 3–32 characters: letters, numbers, dot, dash or underscore.");
    if (!password) return fail("Enter your password.");
    if (signup) {
      if (!st.valid) return fail(st.blocked ? "Password must not contain your username." : "Password must be at least 12 characters.");
      if (password !== confirm) return fail("Passwords do not match.");
    }
    setBusy(true); setError(null);
    const res = await authenticate(mode, u, password);
    setBusy(false);
    if (!res.ok) { setPassword(""); setConfirm(""); return fail(res.reason); }
    setGranted(true);
    window.setTimeout(onAuthed, 650); // let the "access granted" exit animation play before the dashboard mounts
  };

  return (
    <div className={cn("rk-login relative min-h-screen w-full overflow-hidden grid-bg flex items-center justify-center p-4", granted && "rk-exit")}>
      {/* animated backdrop: radar sweep + drifting transaction network */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div className="rk-sweep" />
        <svg className="absolute inset-0 w-full h-full opacity-70" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">
          {[[120, 140, 300, 90], [300, 90, 470, 200], [470, 200, 640, 120], [640, 120, 860, 210], [470, 200, 520, 380], [520, 380, 760, 450], [760, 450, 880, 340], [120, 140, 180, 330], [180, 330, 340, 470], [340, 470, 520, 380]].map(([a, b, c, d], i) => (
            <line key={i} x1={a} y1={b} x2={c} y2={d} stroke="rgba(6,182,212,.22)" strokeWidth="1" className="rk-dash" style={{ animationDelay: `${i * 0.2}s` }} />
          ))}
          {[[120, 140], [300, 90], [470, 200], [640, 120], [860, 210], [520, 380], [760, 450], [880, 340], [180, 330], [340, 470]].map(([x, y], i) => (
            <g key={i} className="rk-node" style={{ animationDelay: `${i * 0.5}s` }}>
              <circle cx={x} cy={y} r="3.5" fill={i % 4 === 0 ? "#ef4444" : "#22d3ee"} />
              <circle cx={x} cy={y} r="6" fill="none" stroke={i % 4 === 0 ? "#ef4444" : "#22d3ee"} className="rk-pulse" style={{ animationDelay: `${i * 0.35}s` }} />
            </g>
          ))}
        </svg>
        <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at center, transparent 30%, #030712 85%)" }} />
      </div>

      <div className="relative w-full max-w-md rk-rise">
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-xl bg-cyan-500/15 border border-cyan-400/50 flex items-center justify-center glow-cyan"><ShieldAlert className="text-cyan-300" size={26} /></div>
          <div className="mt-4 font-mono text-lg font-bold text-cyan-200 tracking-[0.3em] text-glow">ABHEDYA-CHAKRA</div>
          <div className="mt-1 text-[10px] text-slate-500 tracking-[0.35em] font-mono rk-caret">SETU · CYBER-FORENSIC COMMAND CENTER</div>
          <div className={cn("mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-mono tracking-wider uppercase transition-colors", server === null ? "border-slate-600/50 text-slate-400" : server ? "border-emerald-400/40 text-emerald-300 bg-emerald-500/10" : "border-amber-400/40 text-amber-300 bg-amber-500/10")}>
            <span className={cn("w-1.5 h-1.5 rounded-full", server === null ? "bg-slate-500" : server ? "bg-emerald-400" : "bg-amber-400")} />
            {server === null ? "Checking auth service" : server ? "Auth: secure server" : "Auth: offline mode · this browser"}
          </div>
        </div>

        <form onSubmit={submit} noValidate className={cn("glass glass-strong rounded-2xl p-6 relative overflow-hidden", error && "rk-shake")} key={error ? `e${error.n}` : "ok"} autoComplete="on">
          {/* Login / Signup toggle */}
          <div role="tablist" aria-label="Authentication mode" className="relative grid grid-cols-2 p-1 rounded-lg bg-black/40 border border-cyan-500/20 mb-6">
            <div className="rk-slider absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] rounded-md bg-cyan-500/20 border border-cyan-400/50 glow-cyan" style={{ transform: signup ? "translateX(100%)" : "translateX(0)" }} />
            {(["login", "signup"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => switchMode(m)}
                className={cn("relative z-10 py-2 text-[11px] font-mono font-semibold tracking-[0.25em] uppercase transition-colors", mode === m ? "text-cyan-100" : "text-slate-500 hover:text-slate-300")}>
                {m === "login" ? "Login" : "Sign up"}
              </button>
            ))}
          </div>

          <div key={mode} className="rk-fade space-y-4">
            <label className="block">
              <span className="block text-[10px] uppercase tracking-[0.2em] text-slate-400 mb-1.5">Username</span>
              <span className="rk-field flex items-center gap-2 bg-slate-900/60 border border-cyan-500/20 rounded-lg px-3">
                <User size={15} className="text-cyan-400/70 shrink-0" />
                <input ref={userRef} value={username} onChange={(e) => setUsername(e.target.value)} name="username" autoComplete="username" spellCheck={false} autoCapitalize="none" maxLength={32}
                  placeholder="officer.name" className="w-full bg-transparent py-2.5 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none" />
              </span>
            </label>

            <label className="block">
              <span className="block text-[10px] uppercase tracking-[0.2em] text-slate-400 mb-1.5">Password</span>
              <span className="rk-field flex items-center gap-2 bg-slate-900/60 border border-cyan-500/20 rounded-lg px-3">
                <Lock size={15} className="text-cyan-400/70 shrink-0" />
                <input value={password} onChange={(e) => setPassword(e.target.value)} name="password" type={show ? "text" : "password"} autoComplete={signup ? "new-password" : "current-password"} maxLength={128}
                  placeholder="••••••••••••" className="w-full bg-transparent py-2.5 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none" />
                <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} className="text-slate-500 hover:text-cyan-300 transition-colors shrink-0">
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </span>
            </label>

            {signup && (
              <>
                <div className="rk-fade">
                  <div className="flex gap-1.5">
                    {[0, 1, 2, 3].map((i) => <div key={i} className={cn("h-1 flex-1 rounded-full transition-all duration-300", i < st.score ? (st.score <= 1 ? "bg-red-500" : st.score <= 2 ? "bg-amber-400" : "bg-emerald-400") : "bg-slate-700/60")} />)}
                  </div>
                  <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                    {st.checks.map((c) => (
                      <li key={c.label} className={cn("flex items-center gap-1.5 text-[10px] font-mono transition-colors", c.ok ? "text-emerald-300" : "text-slate-500")}>
                        <Check size={11} className={c.ok ? "opacity-100" : "opacity-30"} />{c.label}
                      </li>
                    ))}
                  </ul>
                </div>
                <label className="block rk-fade">
                  <span className="block text-[10px] uppercase tracking-[0.2em] text-slate-400 mb-1.5">Confirm password</span>
                  <span className="rk-field flex items-center gap-2 bg-slate-900/60 border border-cyan-500/20 rounded-lg px-3">
                    <Lock size={15} className="text-cyan-400/70 shrink-0" />
                    <input value={confirm} onChange={(e) => setConfirm(e.target.value)} name="confirm" type={show ? "text" : "password"} autoComplete="new-password" maxLength={128}
                      placeholder="repeat password" className="w-full bg-transparent py-2.5 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none" />
                    {confirm && <Check size={15} className={password === confirm ? "text-emerald-300" : "text-red-400 rotate-45"} />}
                  </span>
                </label>
              </>
            )}
          </div>

          {error && <div role="alert" className="mt-4 text-xs text-red-200 font-mono border border-red-500/50 bg-red-500/10 rounded px-3 py-2 flex items-start gap-2 rk-fade"><AlertOctagon size={14} className="shrink-0 mt-0.5" /><span>{error.msg}</span></div>}

          <button type="submit" disabled={busy || granted}
            className="mt-6 w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-cyan-400/60 bg-cyan-500/15 text-cyan-100 text-xs font-mono font-semibold tracking-[0.3em] uppercase hover:bg-cyan-500/25 hover:glow-cyan disabled:opacity-60 transition-all">
            {granted ? <><Check size={14} /> Access granted</> : busy ? <><span className="rk-spinner" /> {signup ? "Creating account" : "Authenticating"}</> : signup ? "Create account" : "Authenticate"}
          </button>
          <p className="mt-4 text-center text-[10px] text-slate-500 font-mono leading-relaxed">{server === false ? "Offline mode: password is hashed with bcrypt (cost 12) and stored only in this browser. " : "Passwords are hashed with Argon2id on the server. "}Sessions live in memory only and end when this tab is closed.</p>
        </form>
      </div>
    </div>
  );
}
