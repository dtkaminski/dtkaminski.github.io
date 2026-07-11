#!/usr/bin/env python3
"""
Greta data-integrity harness. Parses a brand's greta-live-data.js and prints,
per window, per-channel spend->value/ROAS, DTC net, MER, feed coverage, and the
sum-of-channel-revenue vs actual-store-revenue ratio (double-count check).

Fails (exit 1) if any paid channel's latest row is >48h behind meta.captured,
so a dead feed (e.g. frkl's Google sync stopping 2026-06-02) can't silently
inflate MER by reading missing spend as zero.

Usage: python reconcile_live_data.py path/to/greta-live-data.js
"""
import json, datetime, sys

def load(path):
    raw = open(path, encoding="utf-8").read()
    obj = raw[raw.index("{"):].rstrip().rstrip(";")
    return json.loads(obj)

def acc(arr, keys, start, end):
    tot = {k: 0.0 for k in keys}; n = 0; mx = None
    for r in arr:
        d = datetime.date.fromisoformat(r["date"])
        mx = d if mx is None or d > mx else mx
        if start <= d <= end:
            n += 1
            for k in keys: tot[k] += (r.get(k, 0) or 0)
    tot["_n"] = n; tot["_max"] = mx
    return tot

def sd(a, b): return a / b if b else float("nan")

def main(path):
    D = load(path)
    end = datetime.date.fromisoformat(D["meta"]["captured"])
    full = datetime.date.fromisoformat(D["meta"]["range"]["start"])
    rng = lambda days: end - datetime.timedelta(days=days - 1)
    stale = []
    for label, start in [("30d", rng(30)), ("90d", rng(90)), ("FULL", full)]:
        m  = acc(D["metaDaily"], ["cost", "purchaseValue"], start, end)
        g  = acc(D["googleAds"], ["cost", "convValue", "conversions"], start, end)
        k  = acc(D["klaviyo"],   ["orderValue"], start, end)
        sh = acc(D["shopify"],   ["totalSales", "netSales", "orders", "discounts", "returns"], start, end)
        adspend = m["cost"] + g["cost"]
        chanrev = m["purchaseValue"] + g["convValue"] + k["orderValue"]
        print(f"\n===== {label} ({start} -> {end}) =====")
        print(f"Meta    : £{m['cost']:>8,.0f} -> £{m['purchaseValue']:>9,.0f}  ROAS {sd(m['purchaseValue'],m['cost']):.2f}x")
        print(f"Google  : £{g['cost']:>8,.0f} -> £{g['convValue']:>9,.0f}  ROAS {sd(g['convValue'],g['cost']):.2f}x  (last row {g['_max']})")
        print(f"ShopifyDTC net £{sh['netSales']:>9,.0f}  orders {sh['orders']:.0f}  AOV(net) £{sd(sh['netSales'],sh['orders']):.2f}  disc {100*sd(sh['discounts'],sh['totalSales']):.1f}%  ret {100*sd(sh['returns'],sh['totalSales']):.1f}%")
        print(f"Adspend £{adspend:,.0f}  MER(net) {sd(sh['netSales'],adspend):.2f}x")
        print(f"Sum-channel-rev £{chanrev:,.0f} vs DTC net £{sh['netSales']:,.0f}  ratio {sd(chanrev,sh['netSales']):.2f}x  <-- must NOT be summed into any headline")
    # freshness gate
    for nm, arr in [("Meta", D["metaDaily"]), ("Google", D["googleAds"]), ("Klaviyo", D["klaviyo"]), ("Shopify", D["shopify"])]:
        mx = max(datetime.date.fromisoformat(r["date"]) for r in arr)
        lag = (end - mx).days
        flag = "  <-- STALE" if lag > 2 else ""
        print(f"feed {nm:<8} latest {mx}  lag {lag}d{flag}")
        if lag > 2 and nm in ("Meta", "Google"):
            stale.append((nm, mx, lag))
    if stale:
        print("\nFAIL: stale paid feed(s):", ", ".join(f"{n} ({d}, {l}d)" for n, d, l in stale))
        sys.exit(1)
    print("\nOK: all paid feeds fresh.")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "greta-live-data.js")
