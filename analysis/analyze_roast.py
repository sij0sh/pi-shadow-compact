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
   bare-control trials are baseline, never gated.
5. Workload qualification: sustained context via turn_usage trace --
   samples >= 100k, max 3-turn rolling median ("sustainedPeak"), and turns
   remaining after the first 90k crossing. One-turn spikes do not qualify.
6. Context from the turn_usage trace only (mean/p50/p95/AUC/peaks), never
   summary.csv peak_context_tokens.

Usage: python3 analysis/analyze_roast.py <run1> [<run2> ...]
"""
import glob
import json
import os
import random
import statistics
import sys

NI_MARGIN_PP = -5.0
FLOOR_NORM = 0.25
MIN_POST_SWAP_TURNS = 3


def load_trace(stderr_path):
    evs = []
    try:
        with open(stderr_path) as fh:
            for line in fh:
                if "shadow-compact-trace" in line:
                    try:
                        evs.append(json.loads(line.split("shadow-compact-trace ", 1)[1]))
                    except Exception:
                        pass
    except FileNotFoundError:
        pass
    return evs


def trial_context(evs):
    toks = [e["contextTokens"] for e in evs
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


def trial_treatment(evs):
    tc = [e for e in evs if e.get("event") == "threshold_crossed"]
    pc = [e for e in evs if e.get("event") == "prepare_completed"]
    sw = [e for e in evs if e.get("event") == "swap_applied"]
    tu = [e for e in evs if e.get("event") == "turn_usage"]
    first_swap = next((e["turn"] for e in sw if e.get("firstSwap")), None)
    post = None
    if first_swap is not None and tu:
        post = tu[-1].get("turn", 0) - first_swap
    return {
        "triggered": bool(tc),
        "trigger_turn": tc[0].get("turn") if tc else None,
        "trigger_tokens": tc[0].get("contextTokens") if tc else None,
        "soft_tokens": tc[0].get("softThresholdTokens") if tc else None,
        "prepared": bool(pc),
        "thinking": sorted({e.get("summaryThinking") for e in pc}),
        "render": sorted({e.get("renderOrder") for e in pc}),
        "evicted": [e.get("packetEvicted") for e in pc],
        "truncated": [e.get("packetTruncated") for e in pc],
        "native_fallbacks": sum(1 for e in evs if e.get("event") == "native_fallback"
                                and e.get("action") != "skipped-recovered"),
        # empty-snapshot prepare_failed is by-design suppression
        # (suppress -> growth-rearm -> restart), not an error.
        "suppressions": sum(1 for e in evs if e.get("event") == "prepare_failed"
                            and e.get("reason") == "empty-snapshot"),
        "errors": sum(1 for e in evs if e.get("event") in
                      ("summary_failed", "swap_failed") or
                      (e.get("event") == "prepare_failed"
                       and e.get("reason") != "empty-snapshot")),
        "swaps": len(sw),
        "first_swap_turn": first_swap,
        "post_swap_turns": post,
        "served_ge3": post is not None and post >= MIN_POST_SWAP_TURNS,
    }


def arm_of(variant):
    import re
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
            evs = load_trace(os.path.join(trial_dir, "agent", "pi-stderr.log"))
            f2p, f2p_tot = v.get("f2p_passed"), v.get("f2p_total")
            p2p, p2p_tot = v.get("p2p_passed"), v.get("p2p_total")
            tr = trial_treatment(evs)
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
        obs_n = [t["nf2p"] for t in obs if t["nf2p"] is not None]
        obs_mean = statistics.mean(obs_n) if obs_n else None
        for t in tts:
            c = t["ctx"] or {}
            tr = t["tr"]
            raw = f"{t['f2p']}/{t['f2p_total']}" if t["f2p"] is not None else "n/a"
            norm = f"{t['nf2p'] * 100:.1f}%" if t["nf2p"] is not None else "n/a"
            floor = "FLOOR" if t["nf2p"] is not None and t["nf2p"] < FLOOR_NORM else "ok"
            d = ""
            if (t["arm"] not in ("observe", "control") and t["nf2p"] is not None
                    and obs_mean is not None):
                d = f" d={fmt_pp(t['nf2p'] - obs_mean)}"
            print(f"  {t['variant']:10s} raw={raw:>9s} norm={norm:>7s}{d} {floor} "
                  f"p2p={t['p2p']}/{t['p2p_total']} steps={t['steps']} "
                  f"turns={c.get('n_turns')} peak={c.get('peak')} "
                  f"sust3={round(c['sustained_peak']) if c.get('sustained_peak') else None} "
                  f"n100k={c.get('n_ge_100k')} post90k={c.get('turns_after_90k')} "
                  f"trig={tr['trigger_tokens']}@{tr['trigger_turn']} "
                  f"swaps={tr['swaps']} post={tr['post_swap_turns']} "
                  f"status={t['status']} exc={t['exc']} "
                  f"think={tr['thinking']} ev={tr['evicted']} tr={tr['truncated']} "
                  f"supp={tr['suppressions']} nfb={tr['native_fallbacks']} err={tr['errors']}")
        # powered comparison only at n>=5 per arm (single task)
        arms = {}
        for t in tts:
            arms.setdefault(t["arm"], []).append(t)
        obs_arm = arms.get("observe", [])
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
            else:
                if a_n and obs_mean is not None:
                    d = statistics.mean(a_n) - obs_mean
                    print(f"  [{arm} vs observe] D={fmt_pp(d)} (n<{5}, no CI) "
                          f"| evaluable={len(ev)}/{len(ats)}")
                else:
                    print(f"  [{arm} vs observe] no scores | evaluable={len(ev)}/{len(ats)}")

    print("\nP2P cells <99%:")
    for t in sorted(ts, key=lambda t: (t["task"], t["variant"])):
        if t["np2p"] is not None and t["np2p"] < 0.99:
            print(f"  {t['task']} {t['variant']}: p2p={t['p2p']}/{t['p2p_total']} "
                  f"f2p={t['f2p']}/{t['f2p_total']}")


if __name__ == "__main__":
    main(sys.argv[1:])
