import { Route as RouteIcon, FileText } from "lucide-react";
import { fmtINR, fmtNum, fmtTs } from "@/store";
import { Panel, Badge, Th, Td } from "@/components/ui";
import { CHANNELS, CHANNEL_ORDER, type ChannelId, type ExitSummary } from "@/engine/exits";
import type { Dataset } from "@/engine/types";

/** Colour-coded badge for one exit channel (crypto / ATM / wallet ...). */
export function ChannelBadge({ ch }: { ch: ChannelId }) {
  const c = CHANNELS[ch];
  return <span className="inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono font-semibold tracking-wider uppercase whitespace-nowrap" style={{ color: c.color, borderColor: c.color + "88", background: c.color + "18" }}>{c.short}</span>;
}

/**
 * HOW TO READ THIS SCREEN - a plain-language glossary for people with no security background.
 * Purely additive: it explains the existing graph, it does not change it.
 */
export function HowToRead({ context }: { context: "trail" | "flow" }) {
  const terms: [string, string][] = [
    ["Mule account", "A bank account (often rented or sold by its real owner) that criminals use to receive and pass on stolen money so it cannot be traced back to them."],
    ["Victim → Level 1 (Collectors)", "The first mule accounts to receive the stolen money straight from the victim."],
    ["Level 2 (Distributors)", "They split the money into many smaller transfers and forward it within minutes - this is called 'layering' and it is meant to confuse investigators."],
    ["Level 3 (Indicators)", "Last relay accounts. Amounts are often kept just under reporting limits (e.g. ₹49,000) before the money is cashed out."],
    ["Leaf · Final stop", "An account where the chain ends inside this picture. The coloured tags under a leaf show HOW the money left: crypto, ATM cash, wallet, card, or still parked."],
    ["Freeze", "A request to the bank to block an account so the money cannot be withdrawn. Accounts that still hold money (PARKED) are the best candidates."],
  ];
  return (
    <details className="glass rounded-xl px-4 py-3 group" open={false}>
      <summary className="cursor-pointer text-[11px] font-semibold tracking-[0.18em] uppercase text-cyan-300/90 flex items-center gap-2 select-none"><FileText size={13} /> New to this? How to read the {context === "flow" ? "flow picture" : "trail"} (plain-language guide)</summary>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5">
        {terms.map(([t, d]) => <div key={t} className="text-xs leading-relaxed"><span className="font-semibold text-cyan-200">{t}</span><span className="text-slate-400"> - {d}</span></div>)}
      </div>
      <div className="mt-3 text-xs text-slate-400 leading-relaxed">Read the picture <b className="text-slate-200">top to bottom</b>: each horizontal band is one step further from the victim. Arrows show the direction of money. Redder circles = riskier accounts. Click any circle to see why it is risky.</div>
    </details>
  );
}

/** "WHERE DID THE MONEY GO?" - summary of exit channels plus a per-leaf breakdown. Follows the playback cursor. */
export function ExitPanel({ ex, ds, cur, onPick }: { ex: ExitSummary; ds: Dataset; cur: number | null; onPick?: (acc: number) => void }) {
  const present = CHANNEL_ORDER.filter((c) => ex.totals[c]);
  return (
    <Panel title={<>Where did the money go? <span className="normal-case tracking-normal text-slate-500 font-normal">· {cur === null ? "full trail" : "as of " + fmtTs(cur)}</span></>} icon={<RouteIcon size={13} />} strong>
      {ex.leaves.length === 0 ? (
        <div className="text-xs text-slate-500">No money has reached a final stop yet{cur !== null ? " at this point of the playback - press Play or drag the slider forward." : "."}</div>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex h-3 w-full rounded-full overflow-hidden bg-slate-800/70">
              {present.map((c) => <div key={c} title={`${CHANNELS[c].label}: ${fmtINR(ex.totals[c]!.amount)}`} style={{ width: `${(ex.totals[c]!.amount / (ex.grand || 1)) * 100}%`, background: CHANNELS[c].color }} />)}
            </div>
            <div className="mt-2 text-[11px] font-mono text-slate-400">{fmtINR(ex.grand)} reached {fmtNum(ex.leaves.length)} final-stop account(s)</div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {present.map((c) => (
              <div key={c} className="rounded-lg border px-3 py-2" style={{ borderColor: CHANNELS[c].color + "55", background: CHANNELS[c].color + "0d" }}>
                <div className="flex items-center justify-between gap-2"><ChannelBadge ch={c} /><span className="font-mono text-sm text-slate-100">{fmtINR(ex.totals[c]!.amount)}</span></div>
                <div className="text-[11px] font-semibold text-slate-200 mt-1">{CHANNELS[c].label} · {ex.totals[c]!.count} transfer(s)</div>
                <div className="text-[11px] text-slate-500 leading-snug mt-0.5">{CHANNELS[c].plain}</div>
              </div>
            ))}
          </div>
          {CHANNEL_ORDER.some((c) => ex.beyondTotals[c]) && (
            <div className="text-[11px] text-slate-400 font-mono border border-amber-500/30 bg-amber-500/5 rounded px-3 py-2">
              Forwarded-onward accounts continued within 24 h outside this picture:{" "}
              {CHANNEL_ORDER.filter((c) => ex.beyondTotals[c]).map((c) => `${CHANNELS[c].short} ${fmtINR(ex.beyondTotals[c]!.amount)}`).join(" · ")}
            </div>
          )}
          <div className="max-h-[320px] overflow-auto rounded-lg border border-cyan-500/10">
            <table className="w-full">
              <thead className="sticky top-0 bg-[#060b18] z-10"><tr><Th>Final-stop account</Th><Th className="text-right">Received</Th><Th>How it left</Th><Th>Signals</Th></tr></thead>
              <tbody>
                {ex.leaves.slice(0, 100).map((l) => (
                  <tr key={l.acc} onClick={() => onPick?.(l.acc)} className="hover:bg-cyan-500/5 cursor-pointer">
                    <Td>{ds.accounts[l.acc]}</Td>
                    <Td className="text-right text-slate-100">{fmtINR(l.total)}</Td>
                    <Td className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">{CHANNEL_ORDER.filter((c) => l.byChannel[c]).map((c) => <span key={c} className="inline-flex items-center gap-1"><ChannelBadge ch={c} /><span className="text-[10px] text-slate-400">{fmtINR(l.byChannel[c]!.amount)}</span></span>)}</div>
                    </Td>
                    <Td>
                      {l.foreignIp > 0 && <Badge tone="red" className="mr-1 shadow-none">FOREIGN IP ×{l.foreignIp}</Badge>}
                      {l.headless > 0 && <Badge tone="amber" className="shadow-none">BOT/EMULATOR ×{l.headless}</Badge>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
