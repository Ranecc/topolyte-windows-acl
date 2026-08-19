# -*- coding: utf-8 -*-
"""Generate the benchmark comparison figure for the @topolyte/windows-acl plugin.

Real measured values (hijacking the official grant.ts sources, tsx runtime):
  - 4,332-file workspace: first provision 2,773.7ms (blocked) -> second 1.2ms
  - 182,053-file monorepo (DSH itself): second provision 1.2ms (O(1) skip)
Output: docs/benchmark-acl.png (used by the plugin README + the Show Your
Plugins! discussion).
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# English-only figure: use the default sans-serif (no Chinese font needed).
plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["axes.unicode_minus"] = False

# --- real measured data -----------------------------------------------------
DIRS = [
    {
        "label": "Workspace (4,332 files)\nsame directory, first vs second",
        "first_ms": 2773.7,
        "second_ms": 1.2,
    },
    {
        "label": "Monorepo (182,053 files)\nDSH checkout itself",
        "first_ms": None,  # already granted during measurement; first scales worse
        "second_ms": 1.2,
    },
]

fig, axes = plt.subplots(1, 2, figsize=(12, 4.6), gridspec_kw={"width_ratios": [1.15, 1]})
fig.suptitle("ACL grant wall clock, measured (hijacking official grant.ts sources)",
             fontsize=14, fontweight="bold", y=0.98)

# --- left: same directory, first vs second (log scale) ----------------------
ax = axes[0]
labels = ["First provision\n(sync full-tree walk)", "Second provision\n(O(1) skip)"]
values = [2773.7, 1.2]
colors = ["#c0392b", "#27ae60"]
bars = ax.bar(labels, values, color=colors, width=0.55)
ax.set_yscale("log")
ax.set_ylim(0.1, 10000)
ax.set_ylabel("Wall clock (ms, log scale)")
ax.set_title("Same directory: first vs second", fontsize=12)
for bar, v in zip(bars, values):
    ax.text(bar.get_x() + bar.get_width() / 2, v * 1.4, f"{v:,.1f} ms",
            ha="center", va="bottom", fontsize=11, fontweight="bold")
ax.text(0.5, 0.05, "≈2,300x gap\n(whole-server freeze a user feels)",
        transform=ax.transAxes, ha="center", fontsize=9, color="#555555")

# --- right: skip is flat regardless of tree size ----------------------------
ax = axes[1]
ax.bar(["4,332 files", "182,053 files"], [1.2, 1.2], color="#27ae60", width=0.5)
ax.set_ylim(0, 2.0)
ax.set_ylabel("Wall clock (ms)")
ax.set_title("Subsequent provision (exact-ACE skip)", fontsize=12)
for i, v in enumerate([1.2, 1.2]):
    ax.text(i, v + 0.08, f"{v} ms", ha="center", va="bottom", fontsize=11, fontweight="bold")
ax.text(0.5, 0.9, "Tree-size independent:\nhasExactGrant reads only the directory's own DACL header",
        transform=ax.transAxes, ha="center", fontsize=9, color="#555555")

fig.tight_layout(rect=[0, 0, 1, 0.94])
out = "docs/benchmark-acl.png"
fig.savefig(out, dpi=160, bbox_inches="tight")
print(f"written: {out}")
