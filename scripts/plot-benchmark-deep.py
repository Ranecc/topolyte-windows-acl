# -*- coding: utf-8 -*-
"""Generate the deep benchmark figure for @topolyte/windows-acl.

Reads docs/bench-acl-deep.json (written by scripts/bench-acl-deep.ts v2) and plots:
  - left:    scaling curve (log-log) — sync first provision (median of N
    independent dirs) with the fitted power law t = c*n^alpha, vs subsequent
    provision (O(1) exact-ACE skip, flat).
  - middle:  event-loop responsiveness — sync first stall (= first provision
    wall clock, the freeze a user feels) vs async grant-cli stall (max & p50
    tick gap on the main thread while the child walks the tree; flat,
    spawn-cold-start bound).
  - right:   fail-closed window — grant-cli confirm wall clock (cold: spawn +
    full-tree propagation) vs prewarmed confirm (exact-ACE skip, ≈ cold start).

Real-directory runs (--real) are drawn with hollow markers and excluded from
the power-law fit (single-point, different source).

Output: docs/benchmark-acl-deep.png
"""

import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# English-only figure: use the default sans-serif (no Chinese font needed).
plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["axes.unicode_minus"] = False

HERE = os.path.dirname(os.path.abspath(__file__))
REPORT = os.path.join(HERE, "..", "docs", "bench-acl-deep.json")
OUT = os.path.join(HERE, "..", "docs", "benchmark-acl-deep.png")

with open(REPORT, "r", encoding="utf-8") as f:
    data = json.load(f)

rows = sorted(data["results"], key=lambda r: r["actualFiles"])
synth = [r for r in rows if r["source"] == "synthetic"]
real = [r for r in rows if r["source"] == "real"]
fit = data.get("fit", {})
alpha = fit.get("alpha")
r_sq = fit.get("rSquared")

fig, axes = plt.subplots(1, 3, figsize=(18, 5.2), gridspec_kw={"width_ratios": [1.15, 1, 1]})
fig.suptitle(
    "ACL grant deep benchmark: scaling (power-law fit) + event-loop responsiveness + fail-closed confirm window",
    fontsize=14,
    fontweight="bold",
    y=0.98,
)

# --- left: scaling curve with power-law fit (log-log) -----------------------
ax = axes[0]
s_files = [r["actualFiles"] for r in synth]
s_first = [r["sync"]["first"]["median"] for r in synth]
s_sub = [r["sync"]["subsequent"]["median"] for r in synth]
ax.plot(s_files, s_first, "o-", color="#c0392b", linewidth=2, markersize=7,
        label="First provision (sync full-tree walk, median)")
ax.plot(s_files, s_sub, "s-", color="#27ae60", linewidth=2, markersize=7,
        label="Subsequent provision (exact-ACE skip)")
# power-law fit line over the observed range
if alpha is not None and r_sq is not None and len(s_files) >= 2:
    import math

    xs = [min(s_files), max(s_files)]
    ys = [math.exp(fit["intercept"]) * x ** alpha for x in xs]
    ax.plot(xs, ys, "--", color="#7f8c8d", linewidth=1.5,
            label=f"Power-law fit t=c·n^α (α={alpha:.2f}, R²={r_sq:.3f})")
# real-directory data (hollow marker, excluded from fit)
for r in real:
    ax.plot(r["actualFiles"], r["sync"]["first"]["median"], "D",
            markerfacecolor="none", markeredgecolor="#c0392b", markersize=9,
            label=os.path.basename(r["realPath"]) if r.get("realPath") else "real dir")
    ax.annotate(f'{os.path.basename(r["realPath"])}\n{r["sync"]["first"]["median"]:.0f}ms',
                (r["actualFiles"], r["sync"]["first"]["median"]),
                textcoords="offset points", xytext=(6, 6), fontsize=8, color="#c0392b")
ax.set_xscale("log")
ax.set_yscale("log")
ax.set_xlabel("Workspace file count (log)")
ax.set_ylabel("Wall clock (ms, log)")
ax.set_title("Scaling: first ~O(files) vs subsequent O(1)", fontsize=12)
ax.grid(True, which="both", linestyle=":", alpha=0.4)
ax.legend(fontsize=8, loc="upper left")
for x, y in zip(s_files, s_first):
    ax.annotate(f"{y:,.0f}ms", (x, y), textcoords="offset points",
                xytext=(4, 6), fontsize=8, color="#c0392b")

# --- middle: event-loop responsiveness (max + p50) --------------------------
ax = axes[1]
s_stall_max = [r["async"]["stall"]["max"] for r in synth]
s_stall_p50 = [r["async"]["stall"]["p50"] for r in synth]
ax.plot(s_files, s_first, "o-", color="#c0392b", linewidth=2, markersize=7,
        label="Sync path: server freeze (= first wall clock)")
ax.plot(s_files, s_stall_max, "o-", color="#2980b9", linewidth=2, markersize=7,
        label="Async path: max main-thread tick jitter")
ax.plot(s_files, s_stall_p50, "o--", color="#5dade2", linewidth=1.8, markersize=6,
        label="Async path: tick jitter p50")
ax.set_xscale("log")
ax.set_yscale("log")
ax.set_xlabel("Workspace file count (log)")
ax.set_ylabel("Event-loop stall (ms, log)")
ax.set_title("Event-loop responsiveness: sync freeze vs async responsive", fontsize=12)
ax.grid(True, which="both", linestyle=":", alpha=0.4)
ax.legend(fontsize=8, loc="upper left")
ax.annotate("Jitter from child spawn cold start\n(max ~80-145ms, p50 ~5-10ms, tree-size independent)",
            (s_files[-1], s_stall_max[-1]), textcoords="offset points",
            xytext=(-150, -30), fontsize=9, color="#2980b9")

# --- right: fail-closed confirm window (cold vs prewarmed) ------------------
ax = axes[2]
s_confirm = [r["async"]["confirmMs"] for r in synth]
s_prewarm = [r["async"]["confirmPrewarmedMs"] for r in synth]
ax.plot(s_files, s_confirm, "o-", color="#8e44ad", linewidth=2, markersize=7,
        label="Confirm window (cold): spawn→ACE landed")
ax.plot(s_files, s_prewarm, "o-", color="#e67e22", linewidth=2, markersize=7,
        label="Confirm window (prewarmed): ≈ cold start + skip")
for r in real:
    ax.plot(r["actualFiles"], r["async"]["confirmPrewarmedMs"], "D",
            markerfacecolor="none", markeredgecolor="#e67e22", markersize=9)
ax.set_xscale("log")
ax.set_yscale("log")
ax.set_xlabel("Workspace file count (log)")
ax.set_ylabel("Fail-closed confirm window (ms, log)")
ax.set_title("Fail-closed window: prewarm before vs after", fontsize=12)
ax.grid(True, which="both", linestyle=":", alpha=0.4)
ax.legend(fontsize=8, loc="upper left")
ax.annotate("Window = cold start + propagation; prewarmed\n= cold start only (standing ACE already → skip)",
            (s_files[-1], s_prewarm[-1]), textcoords="offset points",
            xytext=(-150, -30), fontsize=9, color="#e67e22")

fig.tight_layout(rect=[0, 0, 1, 0.94])
os.makedirs(os.path.dirname(OUT), exist_ok=True)
fig.savefig(OUT, dpi=160, bbox_inches="tight")
print(f"written: {OUT}")
