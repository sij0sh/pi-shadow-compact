"""Roast A/B analyzer with the fix.md evaluation fixes.

Implements, for every roast run dir given on the command line:

1. Normalized quality metrics: normalizedF2P = F2P / maxF2P (likewise P2P).
   Treatment effects are reported as percentage-point deltas vs the
   same-task Observe arm. Raw scores are printed alongside but no decision
   is made from raw cross-task deltas.
2. Normalized non-inferiority: margin -5pp (mean norm(T) >= mean
   norm(Observe) - 0.05), with a 95% bootstrap CI (10k resamples,
   percentile, seed 0) when an arm has >= 5 trials. Below n=5 only point
   deltas are reported -- no CI.
3. Proportional floor: normalizedF2P < 0.25 (not raw F2P < 25).
4. Exposure gate (first-class status, not a score): a treated trial is
   EVALUABLE iff it served a swap with >= 3 post-swap model turns;
   otherwise NOT_TESTABLE (reason TRIGGERLESS or UNSERVED). Observe and
   bare-control trials are baseline, never gated. The served >= 5 tier is
   reported alongside as a stricter exposure view.
5. Workload qualification: sustained context via turn_usage trace --
   samples >= 100k, max 3-turn rolling median ("sustainedPeak"), and turns
   remaining after the first 90k crossing. One-turn spikes do not qualify.
6. Context from the turn_usage trace only (mean/p50/p95/AUC/peaks), never
   summary.csv peak_context_tokens. AUC stays the working-set metric; it
   is never mixed into cost.
7. Spend integration (fix.md section 4): headline "total effective cost"
   = primary-model token spend (assistant message usage in
   pi-events.jsonl) + detached summarizer spend (prepare_completed usage
   in the Shadow trace). Native-fallback summarization is not separately
   attributable; its trigger count is reported as `nfb` instead. Cost
   unit is tokens because harness cost fields are zero when pricing is
   unset.
8. Packet eviction as a first-class column (fix.md section 8): max
   packetEvicted, any packetTruncated, and whether the oldest retained
   evidence id is present on every completion.
9. Checkpoint value (fix.md section 7): served post-swap turns per
   checkpoint generation and summarizer tokens per served turn.
10. Within-task arm distributions (n, median/min/max of AUC, medians of
    total cost and summarizer spend). No pooled cross-task averages.

Trace files are read from both layouts: flat `agent/pi-stderr.log` and
staged `steps/*/agent/pi-stderr.log` (SWE-Interact), with events
attributed to their step name.

Usage: python3 analysis/analyze_roast.py <run1> [<run2> ...]
"""
import glob
import json
import os
import random
import re
import statistics
import sys

NI_MARGIN_PP = -5.0
FLOOR_NORM = 0.25
MIN_POST_SWAP_TURNS = 3
STRICT_POST_SWAP_TURNS = 5


def m(x):
    if x is None:
        return "n/a"
    if abs(x) >= 1e6:
        return f"{x / 1e6:.1f}M"
    if abs(x) >= 1e3:
        return f"{x / 1e3:.0f}k"
    return f"{x:.0f}"


def trace_files(trial_dir):
    """All Shadow trace stderr files, flat layout first, then staged steps."""
    paths = []
    flat = os.path.join(trial_dir, "agent", "pi-stderr.log")
    if os.path.exists(flat):
        paths.append((flat, "agent"))
    for path in sorted(glob.glob(os.path.join(trial_dir, "steps", "*", "agent", "pi-stderr.log"))):
        step = path.split("/steps/")[1].split("/agent/")[0]
        paths.append((path, step))
    return paths


def load_trace(trial_dir):
    """(step, event) pairs for every parseable Shadow trace line."""
    evs = []
    for path, step in trace_files(trial_dir):
        try:
            with open(path) as fh:
                for line in fh:
                    if "shadow-compact-trace" in line:
                        try:
                            evs.append((step, json.loads(line.split("shadow-compact-trace ", 1)[1])))
                        except Exception:
                            pass
        except FileNotFoundError:
            pass
    return evs


def trial_context(evs):
    toks = [e["contextTokens"] for _, e in evs
            if e.get("event") == "turn_usage" and e.get("contextTokens") is not None]
    if not toks:
        return None
    s = sorted(toks)
    n = len(s)
    sust = max(sum(toks[i:i + 3]) / 3 for i in range(n - 2)) if n >= 3 else max(toks)
    first90 = next((i for i, t in enumerate(toks) if t >= 90_000), None)
    return {
        "n_turns": n,
        "mean": sum(toks) / n,
        "p50": s[n // 2],
        "p95": s[min(n - 1, int(n * 0.95))],
        "peak": max(toks),
        "auc": sum(toks),
        "n_ge_100k": sum(1 for t in toks if t >= 100_000),
        "sustained_peak": sust,
        "turns_after_90k": (n - 1 - first90) if first90 is not None else 0,
        "series": toks,
    }


def summarizer_spend(evs):
    """Detached summarizer token spend from prepare_completed usage fields."""
    spend = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    n = 0
    wall_ms = 0
    for _, e in evs:
        if e.get("event") != "prepare_completed":
            continue
        n += 1
        wall_ms += e.get("summaryWallMs") or 0
        for key in list(spend):
            spend[key] += e.get(f"summary{key[0].upper()}{key[1:]}") or 0
    spend["tokens"] = sum(spend.values())
    return {"prepares": n, "tokens": spend["tokens"], "wall_ms": wall_ms, **spend}


def primary_spend(trial_dir):
    """Primary-model token spend from assistant message usage in pi-events.jsonl.

    Events are grouped by session id so a trial dir that carries both a flat
    agent/ dir and per-step copies never double-counts a session.
    """
    sessions = {}
    paths = []
    for path in [os.path.join(trial_dir, "agent", "pi-events.jsonl")] + sorted(
            glob.glob(os.path.join(trial_dir, "steps", "*", "agent", "pi-events.jsonl"))):
        if os.path.exists(path):
            paths.append(path)
    for path in paths:
        sid = None
        try:
            with open(path) as fh:
                for line in fh:
                    try:
                        e = json.loads(line)
                    except Exception:
                        continue
                    if e.get("type") == "session":
                        sid = e.get("id")
                        sessions.setdefault(sid, 0)
                        continue
                    if sid not in sessions or e.get("type") != "message_end":
                        continue
                    msg = e.get("message") or {}
                    if msg.get("role") != "assistant":
                        continue
                    u = msg.get("usage")
                    if not u:
                        continue
                    sessions[sid] += u.get("input", 0) + u.get("output", 0) \
                        + u.get("cacheRead", 0) + u.get("cacheWrite", 0)
        except FileNotFoundError:
            pass
    return {"requests": None, "tokens": sum(sessions.values())}


def trial_treatment(evs):
    tc = [(st, e) for st, e in evs if e.get("event") == "threshold_crossed"]
    pc = [e for _, e in evs if e.get("event") == "prepare_completed"]
    sw = [e for _, e in evs if e.get("event") == "swap_applied"]
    first_swap = next((e["turn"] for e in sw if e.get("firstSwap")), None)
    # Turn numbers reset per staged step, so served turns must come from
    # stream order: every turn_usage after the first swap is a model turn
    # served with the checkpoint, across steps. A restored checkpoint can
    # re-mark firstSwap after a per-step state reset, so latch on the
    # first one only.
    post = None
    counting = False
    for _, e in evs:
        if not counting and e.get("event") == "swap_applied" and e.get("firstSwap"):
            counting = True
            post = 0
        elif counting and e.get("event") == "turn_usage":
            post += 1
    trig_step, trig = (tc[0][0], tc[0][1]) if tc else (None, None)
    return {
        "triggered": bool(tc),
        "trigger_step": trig_step,
        "trigger_turn": trig.get("turn") if trig else None,
        "trigger_tokens": trig.get("contextTokens") if trig else None,
        "soft_tokens": trig.get("softThresholdTokens") if trig else None,
        "prepared": bool(pc),
        "prepares": len(pc),
        "thinking": sorted({e.get("summaryThinking") for e in pc}),
        "render": sorted({e.get("renderOrder") for e in pc}),
        "evicted": [e.get("packetEvicted") for e in pc],
        "truncated": [e.get("packetTruncated") for e in pc],
        "oldest_retained": [e.get("packetOldestRetained") for e in pc],
        "native_fallbacks": sum(1 for _, e in evs if e.get("event") == "native_fallback"
                                and e.get("action") != "skipped-recovered"),
        # empty-snapshot prepare_failed is by-design suppression
        # (suppress -> growth-rearm -> restart), not an error.
        "suppressions": sum(1 for _, e in evs if e.get("event") == "prepare_failed"
                            and e.get("reason") == "empty-snapshot"),
        "errors": sum(1 for _, e in evs if e.get("event") in
                      ("summary_failed", "swap_failed") or
                      (e.get("event") == "prepare_failed"
                       and e.get("reason") != "empty-snapshot")),
        "swaps": len(sw),
        "first_swap_turn": first_swap,
        "post_swap_turns": post,
        "served_ge3": post is not None and post >= MIN_POST_SWAP_TURNS,
        "served_ge5": post is not None and post >= STRICT_POST_SWAP_TURNS,
    }


def arm_of(variant):
    return re.sub(r"-r\d+$", "", variant)


def exposure_status(arm, tr):
    """First-class experimental status for treated trials."""
    if arm in ("observe", "control"):
        return "BASELINE"
    if not tr["triggered"]:
        return "NOT_TESTABLE:TRIGGERLESS"
    if not tr["served_ge3"]:
        return "NOT_TESTABLE:UNSERVED"
    return "EVALUABLE"


def load_trials(runs):
    trials = []
    for run in runs:
        for res in glob.glob(f"{run}/jobs/*/*/*/result.json"):
            # jobs/<variant>/<trial-id>/<task-trial-id>/result.json
            trial_dir = os.path.dirname(res)
            parts = res.split("/jobs/", 1)[1].split("/")
            variant = parts[0]
            try:
                r = json.load(open(res))
            except Exception:
                continue
            if "trial_name" not in r:
                continue
            v = (r.get("verifier_result") or {}).get("rewards", {}) or {}
            evs = load_trace(trial_dir)
            f2p, f2p_tot = v.get("f2p_passed"), v.get("f2p_total")
            p2p, p2p_tot = v.get("p2p_passed"), v.get("p2p_total")
            tr = trial_treatment(evs)
            summ = summarizer_spend(evs)
            prim = primary_spend(trial_dir)
            trials.append({
                "run": os.path.basename(run.rstrip("/"))[:40],
                "variant": variant,
                "arm": arm_of(variant),
                "task": (r.get("task_name") or "").split("/")[-1],
                "steps": r.get("n_agent_steps"),
                "f2p": f2p, "f2p_total": f2p_tot,
                "nf2p": (f2p / f2p_tot) if f2p is not None and f2p_tot else None,
                "p2p": p2p, "p2p_total": p2p_tot,
                "np2p": (p2p / p2p_tot) if p2p is not None and p2p_tot else None,
                "exc": r.get("exception_info"),
                "ctx": trial_context(evs),
                "tr": tr,
                "summ": summ,
                "prim": prim,
                "total_spend": prim["tokens"] + summ["tokens"],
                "status": exposure_status(arm_of(variant), tr),
            })
    return trials


def boot_diff(a, b, n=10000, seed=0):
    rng = random.Random(seed)
    diffs = sorted(statistics.mean(rng.choice(a) for _ in a)
                   - statistics.mean(rng.choice(b) for _ in b) for _ in range(n))
    return diffs[int(0.025 * n)], diffs[int(0.975 * n)]


def fmt_pp(x):
    return f"{x * 100:+.1f}pp"


def fmt_med(vals, fmt=str):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "n/a"
    return fmt(statistics.median(vals))


def print_trial_row(t):
    c = t["ctx"] or {}
    tr = t["tr"]
    raw = f"{t['f2p']}/{t['f2p_total']}" if t["f2p"] is not None else "n/a"
    norm = f"{t['nf2p'] * 100:.1f}%" if t["nf2p"] is not None else "n/a"
    floor = "FLOOR" if t["nf2p"] is not None and t["nf2p"] < FLOOR_NORM else "ok"
    evict = max([e for e in tr["evicted"] if e is not None], default=0)
    trunc = any(tr["truncated"])
    oldest = all(tr["oldest_retained"]) if tr["oldest_retained"] else False
    trig = f"{tr['trigger_tokens']}@{tr['trigger_step']}:{tr['trigger_turn']}" if tr["triggered"] else "none"
    vpt = (tr["post_swap_turns"] / tr["prepares"]) if tr["prepares"] and tr["post_swap_turns"] is not None else None
    print(f"  {t['variant']:10s} raw={raw:>9s} norm={norm:>7s} {floor} "
          f"p2p={t['p2p']}/{t['p2p_total']} steps={t['steps']} "
          f"turns={c.get('n_turns')} peak={c.get('peak')} "
          f"sust3={round(c['sustained_peak']) if c.get('sustained_peak') else None} "
          f"n100k={c.get('n_ge_100k')} post90k={c.get('turns_after_90k')} auc={m(c.get('auc'))}")
    print(f"    spend prim={m(t['prim']['tokens'])} summ={m(t['summ']['tokens'])} "
          f"({t['summ']['prepares']}p) tot={m(t['total_spend'])} "
          f"nfb={tr['native_fallbacks']} supp={tr['suppressions']} err={tr['errors']} "
          f"value: sv/ck={f'{vpt:.0f}' if vpt is not None else 'n/a'} "
          f"sumToks/svTurn="
          f"{m(round(t['summ']['tokens'] / tr['post_swap_turns'])) if tr['post_swap_turns'] else 'n/a'}")
    print(f"    trig={trig} swaps={tr['swaps']} post={tr['post_swap_turns']} "
          f"ge3={tr['served_ge3']} ge5={tr['served_ge5']} status={t['status']} exc={t['exc']} "
          f"think={tr['thinking']} ev={tr['evicted']} tr={tr['truncated']} oldest={oldest}")


def print_arm_distributions(task, tts):
    arms = {}
    for t in tts:
        arms.setdefault(t["arm"], []).append(t)
    print("  --- within-task arm distributions (auc / total spend / summarizer spend) ---")
    for arm, ats in sorted(arms.items()):
        aucs = [t["ctx"]["auc"] for t in ats if t["ctx"]]
        totals = [t["total_spend"] for t in ats]
        summs = [t["summ"]["tokens"] for t in ats]
        evaluable = sum(1 for t in ats if t["status"] == "EVALUABLE")
        strict = sum(1 for t in ats if t["tr"]["served_ge5"])
        evicting = sum(1 for t in ats if any((e or 0) > 0 for e in t["tr"]["evicted"]))
        nfb = sum(t["tr"]["native_fallbacks"] for t in ats)
        err = sum(t["tr"]["errors"] for t in ats)
        dist = (f"med={m(statistics.median(aucs))} "
                f"[{m(min(aucs))},{m(max(aucs))}]") if aucs else "no ctx"
        print(f"    {arm:8s} n={len(ats)} auc {dist} "
              f"tot med={fmt_med(totals, m)} summ med={fmt_med(summs, m)} "
              f"| eval3={evaluable}/{len(ats)} eval5={strict} evict={evicting} nfb={nfb} err={err}")


def main(runs):
    ts = load_trials(runs)
    print(f"trials={len(ts)} runs={runs}")
    by_task = {}
    for t in ts:
        by_task.setdefault(t["task"], []).append(t)

    for task in sorted(by_task):
        tts = sorted(by_task[task], key=lambda t: t["variant"])
        print(f"\n## task {task}")
        obs = [t for t in tts if t["arm"] == "observe"]
        obs_mean = None
        obs_n = [t["nf2p"] for t in obs if t["nf2p"] is not None]
        if obs_n:
            obs_mean = statistics.mean(obs_n)
        for t in tts:
            print_trial_row(t)
        print_arm_distributions(task, tts)

        # powered comparison only at n>=5 per arm (single task)
        arms = {}
        for t in tts:
            arms.setdefault(t["arm"], []).append(t)
        obs_arm = arms.get("observe", [])
        obs_auc = [t["ctx"]["auc"] for t in obs_arm if t["ctx"]]
        obs_n = [t["nf2p"] for t in obs_arm if t["nf2p"] is not None]
        obs_mean = statistics.mean(obs_n) if obs_n else None
        for arm, ats in sorted(arms.items()):
            if arm in ("observe", "control"):
                continue
            a_n = [t["nf2p"] for t in ats if t["nf2p"] is not None]
            ev = [t for t in ats if t["status"] == "EVALUABLE"]
            if len(a_n) >= 5 and obs_n:
                d = statistics.mean(a_n) - obs_mean
                # sorted: bootstrap resampling is order-invariant in theory,
                # but the realized fixed-seed CI depends on list order.
                lo, hi = boot_diff(sorted(a_n), sorted(obs_n))
                verdict = "NON-INFERIOR" if d >= NI_MARGIN_PP / 100 else "INFERIOR"
                print(f"  [{arm} vs observe] D={fmt_pp(d)} CI[{fmt_pp(lo)},{fmt_pp(hi)}] "
                      f"margin={NI_MARGIN_PP}pp -> {verdict} | evaluable={len(ev)}/{len(ats)}")
                continue
            parts = [f"[{arm} vs observe]"]
            if a_n and obs_mean is not None:
                parts.append(f"D={fmt_pp(statistics.mean(a_n) - obs_mean)} (n<5, no CI)")
            else:
                parts.append("no scores")
            a_auc = [t["ctx"]["auc"] for t in ats if t["ctx"]]
            if a_auc and obs_auc:
                # cost-side deltas stay point-only below n=5: no CI theater.
                dm = statistics.median(a_auc) - statistics.median(obs_auc)
                parts.append(f"auc medD={m(dm)}")
            parts.append(f"evaluable={len(ev)}/{len(ats)}")
            print("  " + " ".join(parts))

    print("\nP2P cells <99%:")
    for t in sorted(ts, key=lambda t: (t["task"], t["variant"])):
        if t["np2p"] is not None and t["np2p"] < 0.99:
            print(f"  {t['task']} {t['variant']}: p2p={t['p2p']}/{t['p2p_total']} "
                  f"f2p={t['f2p']}/{t['f2p_total']}")


if __name__ == "__main__":
    main(sys.argv[1:])
