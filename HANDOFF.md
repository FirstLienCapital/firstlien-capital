# FirstLien.capital — Full Project Handoff

## WORKING FILES (read these first)
- `/mnt/user-data/outputs/vault-animation-v6.html` — WORKING landing page. Vault bg + flying bills + two Monopoly cards. DO NOT BREAK THIS.
- `/mnt/user-data/outputs/firstlien-homepage-v45.html` — Full site with all functional modules (1335KB)

## WHAT'S BUILT IN v45
- Borrower deal submission (QSM modal, 4 steps, Firebase write)
- Lender criteria engine (LM modal, full criteria form)
- Deal showcase (5 sample deal cards, carousel)
- Doc room (3 options + e-sig + liability disclosure)
- Deal refresh ($9.99, flexibility checkboxes)
- Scout AI chat (Gemini-powered, bottom right)
- Firebase fully wired
- Gemini AI scoring/brief/narrative
- Lender criteria matching engine
- Broker protection section
- Full trust section

## FIREBASE CONFIG
```
apiKey: AIzaSyAw7KJpB2yu_i9OVDrYOoZZkbNK-4oCKoE
authDomain: firstlien-capital.firebaseapp.com
projectId: firstlien-capital
storageBucket: firstlien-capital.firebasestorage.app
messagingSenderId: 867672127759
appId: 1:867672127759:web:d24b328c6f55592b4d667a
```
Admin: firstliencapital@gmail.com
Brevo key: xkeysib-87885b95d3c776f21083b4020596168d1497441bd82817107797f27228f8588d
Netlify: jazzy-pothos-7e7899.netlify.app

## DESIGN SYSTEM
- Dark background: #02040a / #06080f
- Gold accent: rgba(200,155,40,.75) / #c49a1c
- Teal accent: #0d9882
- Fonts: Cormorant Garamond (serif/display) + Inter (sans/body)
- Cards: Monopoly style — borrower=gold banner, lender=teal banner
- Vault image: base64 embedded in vault-animation-v6.html

## CHARACTER ASSETS (transparent PNG)
- `/mnt/user-data/uploads/Screen_Shot_2026-04-13_at_4_49_00_PM.png` = LENDER (suit, holding cash)
- `/mnt/user-data/uploads/Screen_Shot_2026-04-13_at_4_49_12_PM.png` = BORROWER (casual, holding house)
- Use as AI helpers — lender char on lender pages, borrower char on borrower pages

## MONOPOLY CARDS (Christina's Photoshop files)
- `/mnt/user-data/uploads/Screen_Shot_2026-04-13_at_4_38_13_PM.png` = BORROWER card (gold banner, I NEED A LOAN, I have a property to mortgage)
- `/mnt/user-data/uploads/Screen_Shot_2026-04-13_at_4_38_33_PM.png` = LENDER card (teal banner, I WANT TO LEND, I have cash to invest)

## CORRECT ARCHITECTURE (do NOT do single-file routing)
1. `vault-animation-v6.html` = landing page (WORKING, don't touch)
2. `borrower.html` = borrower flow (build from v45 QSM + deal sections)
3. `lender.html` = lender flow (build from v45 LM + criteria engine)

## LANDING PAGE pick() FUNCTION
When borrower card clicked: window.location.href = 'borrower.html'
When lender card clicked: window.location.href = 'lender.html'
Currently pick() does a fade animation then needs the redirect added.

## BUSINESS CONTEXT
- "Travelocity of mortgages" — marketplace where lenders compete for deals
- Borrower submits once, 1000+ lenders see it
- Two lender types: Asset-based (no FICO, LTV only) + Full-spectrum (full underwrite)
- Fee: 1 point at close (0.5 above $2M), $0 if no close
- $19.99 single deal listing, $49/mo unlimited
- Physician partner: Dr. Crystal Broussard (separate wellness business, ignore for site)
- Organic Shimmer = separate business (ignore)

## NAV STRUCTURE
- Borrower pages: nav has "How it works | Live deals | Pricing | FAQ" + CTA "Submit Your Deal"
- Lender pages: nav has "How it works | Set criteria | Lender types" + CTA "Set Your Criteria"
- Both: logo "FirstLien.capital" links back to vault-animation-v6.html (landing)

## KEY CSS FROM WORKING LANDING PAGE
```css
font-family: 'Cormorant Garamond', serif  /* display */
font-family: 'Inter', sans-serif           /* body */
#wm-name .g { color: rgba(232,178,36,.96); font-style: italic; } /* "Lien" in gold italic */
```

## WHAT STILL NEEDS BUILDING
1. Update vault-animation-v6.html pick() to do window.location redirects
2. Build borrower.html with QSM from v45
3. Build lender.html with LM/criteria from v45
4. Doc prep engine ($1,499 at closing, 120-page state-specific loan docs)
5. Deploy to Netlify jazzy-pothos-7e7899

## QUICK START FOR NEW CLAUDE
1. Read vault-animation-v6.html to understand landing page
2. Read firstlien-homepage-v45.html to understand all functional modules
3. Fix pick() in vault-animation-v6.html to redirect to borrower.html / lender.html
4. Build borrower.html extracting QSM + deal showcase from v45
5. Build lender.html extracting LM + criteria engine from v45
