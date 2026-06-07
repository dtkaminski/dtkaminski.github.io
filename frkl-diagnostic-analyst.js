// frkl-diagnostic-analyst.js — Layer 2 output (the LLM analyst's read).
//
// Normally generated daily by the `diagnostic-analyst` edge function during the
// snapshot refresh. Seeded here by running the operator reasoning protocol over
// frkl's live 30d evidence bundle — ENRICHED from already-authorised connections
// (GA4 funnel + paid/organic split, Meta campaign-level + frequency, Shopify
// inventory). Once ANTHROPIC_API_KEY (or an OSS LLM_PROVIDER) is set, the daily
// refresh overwrites this with real model output over the same enriched bundle.
//
// Keyed by period. Schema matches the edge function's operator_read tool exactly.
window.FRKL_DX_ANALYST = {
  "30d": {
    "headline": "There's no broken campaign to cut — both Meta campaigns report ~3× ROAS. The problem is that Meta over-claims ~£5k vs GA4, so paid's true return is unproven and closer to ~1.3× than the blended 4.55×.",
    "narrative": "Three views of the same spend tell the real story. In-platform, both campaigns look fine: HOP A+ Shopping UK (£2.5k → 3.08×) and Ireland (£1.9k → 2.94×), healthy frequency (2.1× / 1.7×) and CTR (~2.2%). But Meta claims £13.5k of revenue from £4.5k spend, while GA4 attributes only ~£8.1k to ALL paid — a ~£5.4k over-attribution gap, and blended revenue (4.55× MER) is two-thirds organic/email. So paid's true incremental return sits well below Meta's 3× and probably nearer GA4's ~1.3×. Separately, the site leaks mid/late-funnel (24% cart→checkout, 28% checkout→purchase) and 24 products are out of stock — and frequency is low, so this is not creative fatigue.",
    "findings": [
      {
        "area": "Efficiency",
        "metric": "Meta 3× in-platform vs GA4 paid ~1.3× — ~£5.4k attribution gap",
        "verdict": "act",
        "confidence": "high",
        "reasoning": "Both campaigns report healthy ~3× ROAS at healthy frequency, so no single campaign is the problem. But Meta claims £13.5k from £4.5k while GA4 credits only £8.1k to all paid — Meta is over-crediting conversions GA4 assigns to organic/email/direct. The in-platform 3× can't be taken at face value.",
        "recommendation": "You have a built-in experiment: UK and Ireland run near-identical A+ Shopping. Pause or halve Ireland for 2 weeks and watch TOTAL revenue — that geo-holdout measures real incremental paid return and sets a defensible MER floor before adding budget.",
        "gbp": null
      },
      {
        "area": "Conversion",
        "metric": "Checkout completion 28% · cart→checkout 24%",
        "verdict": "act",
        "confidence": "high",
        "reasoning": "GA4 funnel localises the loss: session→cart is a healthy 17.4%, but cart→checkout (24%) and checkout→purchase (28%) are far below ~45–55% norms — a mid/late-funnel leak (checkout friction), not poor traffic. Fixing it lifts the return on every channel at once.",
        "recommendation": "Audit checkout (payment options, error states, when shipping cost appears) + cart UX. This is the cheapest lever and it compounds across paid and organic alike.",
        "gbp": 5643
      },
      {
        "area": "Availability",
        "metric": "24 of 230 active products out of stock",
        "verdict": "act",
        "confidence": "med",
        "reasoning": "~10% of the live catalogue is out of stock; visitors landing on or searching these hit dead ends, suppressing add-to-cart and checkout — and the A+ Shopping campaigns may be paying to send traffic to them.",
        "recommendation": "Restock the top sellers among the 24; exclude the rest from the Shopping product feed and hide from collections/search so spend doesn't flow to dead ends.",
        "gbp": null
      },
      {
        "area": "Margin",
        "metric": "Discount load 9.5% · contribution ~56% of net",
        "verdict": "monitor",
        "confidence": "high",
        "reasoning": "Margin is healthy — discount load well under 20%, contribution ~56% of net. No margin problem; keep the fix on paid efficiency, conversion and availability.",
        "recommendation": "No action on margin. Hold discount discipline while you fix the above."
      }
    ],
    "blindspots": [
      "True incremental paid return is still unmeasured — Meta says 3×, GA4 last-click says ~1.3×; the Ireland geo-holdout above is how to pin it. (A test to run, no longer missing data.)",
      "Google Ads campaign detail is still account-level only (dev-token Basic-access approval pending), so the ~£1.9k of non-Meta paid isn't broken out by campaign.",
      "Prior-window GA4 is too sparse to compare period-over-period, so funnel + channel reads are current-window vs benchmarks."
    ],
    "model": "seeded (agent) — enriched: GA4 funnel + paid/organic + Meta campaigns + frequency + inventory",
    "generatedAt": "2026-06-03"
  }
};
