# Operator Intelligence — marketing site

Single-page production-ready landing site. Static HTML, no build step, no dependencies (Inter loaded from Google Fonts CDN). Deploy in 60 seconds.

## Local preview

```bash
# from this directory
python -m http.server 8080
# then open http://localhost:8080
```

Or just double-click `index.html` — works as a `file://` URL too.

## Deploy

### Option A — Netlify drag-and-drop (60 sec)

1. Open https://app.netlify.com/drop
2. Drag the `marketing-site` folder onto the page
3. Done — Netlify gives you a URL like `https://random-name.netlify.app`
4. Custom domain via Netlify Dashboard → Domain settings

### Option B — Netlify via Git (recommended for iteration)

```bash
# from the frkl repo root
netlify deploy --dir=saas/marketing-site --prod
```

Then connect the repo for auto-deploy on push. The included `netlify.toml` sets sane security headers + CSP.

### Option C — Anywhere else

It's pure static HTML. Drop the folder onto Vercel, Cloudflare Pages, GitHub Pages, S3, or your own server. No build required.

## What's on the page

| Section | Anchor | Purpose |
|---|---|---|
| Hero | (top) | Headline + sub + dual CTA + product mockup |
| Proof bar | — | 5 stats from frkl data |
| Problem | `#how` | "Your dashboard tells you what happened. It doesn't tell you what to do." |
| Wedge quote | — | "Triple Whale tells you where your last sale came from. We tell you why next month's looks shaky." |
| Two pillars | — | Holistic coverage + Intellectual honesty |
| Honesty table | — | 6-row failure-mode comparison |
| Case study | `#case-study` | frkl receipts — £30.7k/mo, £295k inventory, etc. |
| Eval scorecard | — | 54.5/62 combined |
| Pricing | `#pricing` | Four tiers (£99 / £249 / £599 / £1750+) |
| FAQ | `#faq` | 8 questions a sceptical founder would ask |
| Final CTA | `#trial` | Free-trial conversion surface |
| Footer | — | Brand, links, legal |

## What's not on the page yet (intentional)

- **Real auth / trial flow** — CTAs link to `#trial` placeholders. Wire to a real signup endpoint when the tenant onboarding flow exists.
- **Live demo link** — points to `#demo`. Replace with the actual frkl dashboard URL once it's deployed at a stable domain.
- **Email capture form** — no JS-driven lead form yet. Drop in Formspree, Netlify Forms, or your own backend.
- **Analytics** — no pixel/Plausible/Fathom yet. Add to `<head>` when chosen.
- **Real legal pages** — `/privacy`, `/terms`, `/contact` are footer placeholders.

## Brand consistency

The site reuses the **exact same design tokens** as the dashboard (`frkl-live-dashboard.html`):

- Inter typography (400 / 450 / 500 / 550 / 600 / 650 / 700 / 800)
- Same colour palette (`--bg-app`, `--accent` `#7c8cff`, `--good` `#4ade80`, etc.)
- Same spacing scale (4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64 / 96)
- Same radius scale (6 / 10 / 14 / 20)
- Same motion tokens

This means visitors landing on the site → clicking "See live demo" experience zero visual whiplash. They feel the dashboard is the same product they were just reading about.

## Hero mockup notes

The hero "screenshot" is **not an image** — it's HTML/CSS replicating the actual `ThisWeekHero` component from the dashboard. Advantages: it crisp-renders at any DPI, weighs ~2KB instead of 200KB, and stays in sync with the real product if we change tokens. The data shown is frkl's real numbers from the case study.

If you want a real screenshot instead, capture one with the dashboard at 1440px and replace the `.mockup-body` contents with an `<img>` tag.

## TODO before going live

- [ ] Decide on real CTA destinations (signup form, Calendly, email)
- [ ] Connect a domain (`operatorintelligence.com` if available)
- [ ] Add Plausible / Fathom analytics snippet
- [ ] Write the real Privacy + Terms + Contact pages
- [ ] OG image for social sharing (use the hero mockup screenshot)
- [ ] Verify all anchor links work after any anchor renames
- [ ] Decide on a real lead-capture mechanism (Formspree, ConvertKit, Notion DB)
