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
import matplotlib.ticker as mticker

# Try Chinese font (Microsoft YaHei ships with Windows); fall back to default.
import matplotlib.font_manager as fm

ZH_FONT = None
for name in ("Microsoft YaHei", "SimHei", "PingFang SC"):
    if any(f.name == name for f in fm.fontManager.ttflist):
        ZH_FONT = name
        break

plt.rcParams["font.family"] = ZH_FONT or "sans-serif"
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
fig.suptitle("ACL 授权耗时对比（实测，劫持官方 grant.ts 源码）", fontsize=14, fontweight="bold", y=0.98)

# --- left: same directory, first vs second (log scale) ----------------------
ax = axes[0]
labels = ["首次 provision\n（同步全树传播）", "二次 provision\n（O(1) skip）"]
values = [2773.7, 1.2]
colors = ["#c0392b", "#27ae60"]
bars = ax.bar(labels, values, color=colors, width=0.55)
ax.set_yscale("log")
ax.set_ylim(0.1, 10000)
ax.set_ylabel("耗时（毫秒，对数轴）")
ax.set_title("同一目录：首次 vs 二次", fontsize=12)
for bar, v in zip(bars, values):
    ax.text(bar.get_x() + bar.get_width() / 2, v * 1.4, f"{v:,.1f} ms",
            ha="center", va="bottom", fontsize=11, fontweight="bold")
ax.text(0.5, 0.05, "≈2,300 倍差距\n（用户可感知的整服务器冻结）",
        transform=ax.transAxes, ha="center", fontsize=9, color="#555555")

# --- right: skip is flat regardless of tree size ----------------------------
ax = axes[1]
ax.bar(["4,332 文件", "182,053 文件"], [1.2, 1.2], color="#27ae60", width=0.5)
ax.set_ylim(0, 2.0)
ax.set_ylabel("耗时（毫秒）")
ax.set_title("二次 provision（exact-ACE skip）", fontsize=12)
for i, v in enumerate([1.2, 1.2]):
    ax.text(i, v + 0.08, f"{v} ms", ha="center", va="bottom", fontsize=11, fontweight="bold")
ax.text(0.5, 0.9, "与树大小无关：\nhasExactGrant 只读目录自身 DACL 头",
        transform=ax.transAxes, ha="center", fontsize=9, color="#555555")

fig.tight_layout(rect=[0, 0, 1, 0.94])
out = "docs/benchmark-acl.png"
fig.savefig(out, dpi=160, bbox_inches="tight")
print(f"written: {out}")
