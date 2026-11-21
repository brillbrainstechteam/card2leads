# Card2Leads — Play Store, Google and AI search playbook

Written 22 Nov 2026. Everything marked **[done]** is already live in the repo;
everything marked **[to do]** needs a person in a console.

---

## 1. The single most important keyword decision

In India, **"visiting card"** is searched far more than "business card". Both
terms need to appear, but the listing should lead with *visiting card* and keep
*business card* as the secondary term so you rank on the phrasing people here
actually type.

The second decision: do not compete head-on with CamCard, ABBYY and Microsoft
Lens on the generic term "business card scanner". You will lose. Win the niche
you already serve — **exhibition and trade-show lead capture in India** — where
the competition is thin and the intent is commercial.

Primary terms, in order of priority:

| Term | Why |
|---|---|
| visiting card scanner | Highest local volume, moderate competition |
| exhibition lead capture app | Low competition, exactly your buyer |
| business card to Excel | High intent, poorly served by the big apps |
| trade show lead management | The B2B phrasing buyers and agencies use |
| visiting card to Google Contacts | Long tail, near-zero competition |
| IIJS / jewellery exhibition leads | Your actual client base |

---

## 2. Play Store listing (ASO)

Play ranks on three text fields: **title, short description, full description**.
There is no keyword field. Your primary term should appear in all three, and
roughly 3–5 times across the full description — more than that reads as spam and
Play discounts it.

### App title — max 30 characters

**Recommended:** `Card2Leads: Visiting Card Scan` *(30/30)*

Alternatives:

| Title | Chars | Note |
|---|---|---|
| `Card2Leads: Visiting Card Scan` | 30 | Best keyword coverage. Recommended. |
| `Card2Leads: Card Scanner & CRM` | 30 | Use if you want to signal lead management |
| `Card2Leads: Card Scanner` | 24 | Safest, weakest for ranking |

Keep **Card2Leads** first — it must match the Google OAuth consent-screen app
name, and you have clients who search for it by name.

### Short description — max 80 characters

**Recommended:** `Scan visiting cards to Excel, Google Contacts & Sheets. Built for exhibitions.` *(78/80)*

This is the line shown under the icon in search results, and it carries real
ranking weight. It names the keyword, the output and the niche in one sentence.

### Full description — max 4000 characters

Paste this as-is. Play renders the bullets; it does not render Markdown.

```
Card2Leads turns a stack of visiting cards into a clean contact list — on your phone, at the stall, before you get home.

It is a business card scanner built for exhibitions and trade shows, where you collect three hundred cards in four days and lose half of them by the following week.

SCAN A VISITING CARD IN SECONDS
• Photograph a card with your camera, or pick up to 200 card images from your gallery in one go
• Front and back of the same card are read as one contact
• Name, company, designation, mobile number, email, address, city, state and pincode are pulled out automatically
• Every field is shown for you to check and correct before it is saved — nothing is guessed behind your back

BUILT FOR EXHIBITION TEAMS
• Tag every card with the event it was collected at, and the date
• Assign leads to the team member who met them, so a shared stall does not become a shared mess
• Classify by industry, business type, customer status and star rating, using dropdown lists your own team controls
• Record a voice note while the conversation is still fresh — it is saved against the contact

YOUR DATA, IN YOUR FORMAT
• Export to Excel, CSV or VCF, with the same columns in every format
• Sync to Google Contacts and Google Sheets
• Download an Excel file, classify hundreds of rows on a laptop, and upload it back — only the rows you changed are updated
• Save contacts straight to your phone's address book

FOLLOW UP THE SAME DAY
• Open a ready-written WhatsApp message to any lead, using your own templates and catalogue link
• Messages open in WhatsApp for you to send — nothing is ever sent automatically
• Filter by event, team member, city, industry, or whether you have already messaged them

ONE-TIME PRICING, NO SUBSCRIPTION TRAP
• Starter Pack — ₹699 for 150 scans, valid 30 days
• Exhibition Pass — ₹1,299 for 300 scans, valid 90 days
• Pro Annual — ₹5,799 for 1,500 scans, valid 12 months
• 200 extra scans — ₹799 whenever you run short

Plans are paid once and do not auto-renew. One credit is one card; the front and back of the same card count as one. A GST tax invoice is issued for every payment.

WORKS ON THE WEB TOO
The same workspace opens in any browser, so the field team scans on the phone while the office works the list on a laptop.

PRIVACY
Card photos and voice recordings are deleted 90 days after the card is created. Connecting a Google account is optional and is only requested when you use a feature that needs it. Google data is never sold or used for advertising.

Card2Leads is built and operated by BrillBrains Consultants Pvt. Ltd.
Questions: tech@brillbrainsconsultants.com
```

### The rest of the Play Console listing **[to do]**

- **Category:** Business. **Tags:** choose Business, Productivity, and the
  closest CRM/sales tags offered.
- **Screenshots carry more conversion weight than any text.** Put a one-line
  caption *in* each image — "300 cards, one upload", "Straight to Excel",
  "Split leads across your team". Phones show 2–3 before a scroll, so the first
  three decide installs. You already have `app_submission_screenshots/`.
- **Feature graphic** (1024×500): must read at thumbnail size. Product name plus
  one benefit, nothing else.
- **Custom store listing for India** if Play offers it for your account — same
  copy, with *visiting card* weighted even more heavily.
- **Account deletion URL:** declare `https://card2leads.brillbrainsconsultants.com/delete-account.html`
  in the Data safety form. Play requires this for any app with accounts, and a
  missing one is a common cause of rejected updates.

### What actually moves Play ranking

Installs and retention outrank text. Two cheap levers:

1. Ask a dozen real users — Dishaa's team included — for a rated review in the
   week after an exhibition, when the app has just saved them a day of typing.
2. Keep the crash rate near zero in Android vitals. Play demotes apps above the
   bad-behaviour threshold regardless of keywords.

---

## 3. Google (web) SEO

### Already live **[done]**

- Title, description, canonical, Open Graph and Twitter cards.
- Four valid JSON-LD blocks: `SoftwareApplication`, `FAQPage`, `Organization`,
  `HowTo`.
- A full static, crawlable copy of the homepage inside `index.html`, so the site
  indexes even though the app itself is JavaScript.
- `robots.txt` with the API and private storage closed, sitemap declared.
- `sitemap.xml` now covers home, privacy, terms, retention, contact and
  delete-account.
- `max-image-preview:large` and `max-snippet:-1`, which let Google and the AI
  summarisers quote more of the page.

### The real limitation

**One page cannot rank for six different searches.** Everything you sell sits on
a single URL, so each keyword competes with the others for the same page. The
single highest-value SEO investment is three more pages, each answering one
search properly, each 800–1200 words, each linked from the homepage:

| URL | Target search |
|---|---|
| `/visiting-card-scanner` | visiting card scanner, business card scanner app |
| `/exhibition-lead-capture` | exhibition leads, trade show lead capture, IIJS |
| `/business-card-to-excel` | business card to Excel, card scanner export CSV |

Write them as the answer to the question, not as brochure copy. Each one should
restate the pricing and link to Play — that is what gets quoted back.

### Console work **[to do]**

1. Verify the domain in **Google Search Console** and submit
   `https://card2leads.brillbrainsconsultants.com/sitemap.xml`.
2. Request indexing for the homepage once, then leave it alone.
3. Check Core Web Vitals after a week. The app shell is light, so this should
   pass, but the Razorpay preconnect is worth confirming is not blocking paint.
4. Link the Play listing and the website to each other — Google treats the pair
   as corroboration of the same entity.

---

## 4. AI search (ChatGPT, Claude, Perplexity, Google AI Overviews)

AI answers are built from pages the crawler can read and facts it can
corroborate across sources. Two things matter: **access** and **consistency**.

### Already live **[done]**

- `robots.txt` names GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot,
  Claude-Web, anthropic-ai, PerplexityBot, Perplexity-User, Google-Extended,
  Applebot, Amazonbot, meta-externalagent and Bingbot explicitly. Several of
  these ignore the wildcard group, so naming them is what gets you read.
- `llms.txt` — a plain-text brief of what the product is, what it does, what it
  costs and who runs it.
- `FAQPage` and `HowTo` structured data, which is the shape answer engines lift
  from most readily.

### The bug this review found **[fixed]**

`llms.txt` was still advertising **₹499 / ₹899 / ₹3,999** — the prices before the
increase. Every AI assistant reading that file has been quoting prices you no
longer charge. It now carries ₹699 / ₹1,299 / ₹5,799 and the ₹799 top-up, and
the full current feature list.

**This is the thing to watch.** An AI answer is only as current as the least
current page it read. When pricing or features change, these five surfaces must
change together:

1. `public/llms.txt`
2. The `SoftwareApplication` offers in `public/index.html`
3. The FAQ answers — both the visible copy and the `FAQPage` JSON-LD
4. The Play Store full description
5. The in-app plan cards (`mobile/app/pricing.tsx` and the web `app.js`)

### Where to be mentioned **[to do]**

LLMs weight third-party corroboration heavily, and currently almost nothing
about Card2Leads exists outside your own domain. In rough order of value:

- **Listing directories** AI tools read constantly: G2, Capterra, AlternativeTo,
  SaaSHub, Product Hunt. Free, and they produce the "alternatives to CamCard"
  comparisons that assistants quote.
- **A comparison page on your own site** — "Card2Leads vs CamCard vs ABBYY" —
  written honestly, including what you do not do. Comparison pages are
  disproportionately quoted.
- **Answers on Reddit and Quora** to questions like *"best app to scan visiting
  cards at an exhibition in India"*. Answer the question genuinely and mention
  the product once.
- **A changelog or release-notes page.** Gives the crawlers a reason to return,
  and gives assistants a dated source for "what is new".

---

## 5. Order I would do this in

1. Fix the Play Store listing text — one hour, and it is the field you control
   most directly. **[to do]**
2. Redo the first three screenshots with captions. **[to do]**
3. Verify Search Console and submit the sitemap. **[to do]**
4. Get the first ten reviews from Dishaa's team after their next exhibition. **[to do]**
5. Write the three landing pages. **[to do]**
6. Claim the directory listings. **[to do]**

Items 1–4 are a day's work and will do more than the rest combined.
