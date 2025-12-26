// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const Stripe = require('stripe');
const PocketBase = require('pocketbase/cjs');

const app = express();
const PORT = process.env.PORT || 3000;

// --- GLOBAL MIDDLEWARE ---
app.use(cors());
// Serve all static files (html, css, js) from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));


// --- STRIPE & POCKETBASE CLIENTS AND WEBHOOK ---
let stripe, pb;

// Stripe webhook handler needs the raw body, so it's defined before express.json()
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !pb) return res.status(500).send("Server not fully initialized.");
    
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.log(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log(`Received Stripe event: ${event.type}`);

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            const userId = session.client_reference_id;
            const stripeCustomerId = session.customer;
            const stripeSubscriptionId = session.subscription;
            
            if (!userId) {
                console.error("Webhook Error: No client_reference_id (userId) in completed session.");
                break;
            }

            try {
                const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
                const priceId = subscription.items.data[0].price.id;

                let plan = 'hobby';
                if ([process.env.STRIPE_PRICE_PRO_MONTHLY, process.env.STRIPE_PRICE_PRO_YEARLY].includes(priceId)) {
                    plan = 'pro';
                } else if ([process.env.STRIPE_PRICE_TEAM_MONTHLY, process.env.STRIPE_PRICE_TEAM_YEARLY].includes(priceId)) {
                    plan = 'team';
                }

                const data = {
                    plan: plan,
                    stripe_customer_id: stripeCustomerId,
                    stripe_subscription_id: stripeSubscriptionId,
                };
                await pb.collection('users').update(userId, data);
                console.log(`Updated user ${userId} to plan '${plan}'`);

            } catch (error) {
                console.error(`Failed to update user for session ${session.id}:`, error);
            }
            break;
        }
        case 'customer.subscription.deleted': {
            const subscription = event.data.object;
            try {
                const users = await pb.collection('users').getFullList({
                    filter: `stripe_subscription_id = "${subscription.id}"`,
                });
                
                if (users && users.length > 0) {
                    const user = users[0];
                    await pb.collection('users').update(user.id, { plan: 'hobby' });
                    console.log(`Reverted user ${user.id} to 'hobby' plan due to subscription cancellation.`);
                }
            } catch (error) {
                console.error(`Failed to handle subscription deletion for ${subscription.id}:`, error);
            }
            break;
        }
    }
    res.json({ received: true });
});

// For all other routes, use JSON parser
app.use(express.json());

// --- CLIENT INITIALIZATION ---
try {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    console.log("✅ Stripe client initialized.");
} catch (err) {
    console.error("❌ CRITICAL: Stripe failed to initialize.", err.message);
}

(async () => {
    try {
        pb = new PocketBase(process.env.POCKETBASE_URL);
        await pb.admins.authWithPassword(process.env.POCKETBASE_ADMIN_EMAIL, process.env.POCKETBASE_ADMIN_PASSWORD);
        pb.autoCancellation(false);
        console.log("✅ Pocketbase Admin client authenticated.");
    } catch (err) {
        console.error("❌ CRITICAL: Pocketbase Admin client failed to authenticate.", err);
    }
})();


// --- API MIDDLEWARE ---
const PLAN_LIMITS = {
    hobby: { rate: 100,   bulk: 100,   name: "Hobby" },
    pro:   { rate: 2000,  bulk: 10000, name: "Pro" },
    team:  { rate: 10000, bulk: 10000, name: "Team" }
};

const identifyUser = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;
    req.userContext = { type: 'hobby', plan: PLAN_LIMITS.hobby, identifier: req.ip };

    if (apiKey && pb) {
        try {
            const user = await pb.collection('users').getFirstListItem(`api_key = "${apiKey}"`);
            if (user && PLAN_LIMITS[user.plan]) {
                req.userContext = { type: user.plan, plan: PLAN_LIMITS[user.plan], identifier: apiKey };
            } else {
                 return res.status(401).json({ error: true, message: "Ogiltig API-nyckel." });
            }
        } catch (err) {
            if (err.status === 404) {
                return res.status(401).json({ error: true, message: "Ogiltig API-nyckel." });
            }
            console.error("Pocketbase query error in identifyUser:", err.message);
        }
    }
    next();
};

const standardLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userContext.identifier,
    limit: (req) => req.userContext.plan.rate,
    handler: (req, res) => res.status(429).json({ error: true, message: `Rate limit uppnådd. Din plan (${req.userContext.plan.name}) tillåter ${req.userContext.plan.rate} anrop per 15 min.` }),
});

const bulkLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => req.userContext.identifier,
    skip: (req) => (parseInt(req.query.amount) || 1) <= 100,
    handler: (req, res) => res.status(429).json({ error: true, message: "Fair Usage Policy: Du har gjort för många Bulk-exporter (>100 rader) den senaste timmen. Max 10 st per timme." }),
});

app.use('/api', identifyUser, bulkLimiter, standardLimiter);


// --- API ENDPOINTS ---
app.post('/api/create-checkout-session', async (req, res) => {
    const { priceId, userId } = req.body;
    if (!stripe || !priceId || !userId) return res.status(400).json({ error: "Missing priceId or userId" });

    try {
        const session = await stripe.checkout.sessions.create({
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            success_url: `https://luhn.se/profile.html?status=success`,
            cancel_url: `https://luhn.se/profile.html?status=cancelled`,
            client_reference_id: userId,
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error("Stripe session creation failed:", error);
        res.status(500).json({ error: "Could not create Stripe session" });
    }
});

app.post('/api/create-customer-portal-session', async (req, res) => {
    const { stripeCustomerId, returnUrl } = req.body;
    if (!stripe || !stripeCustomerId || !returnUrl) return res.status(400).json({ error: "Missing stripeCustomerId or returnUrl" });

    try {
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: stripeCustomerId,
            return_url: returnUrl,
        });
        res.json({ url: portalSession.url });
    } catch (error) {
        console.error("Stripe Customer Portal session creation failed:", error);
        res.status(500).json({ error: "Could not create Customer Portal session" });
    }
});

app.get('/api/stripe-config', (req, res) => {
    res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// All the data generation routes follow...
// --- HJÄLPFUNKTIONER ---
const random = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];
const randomInt = (min, max, rng = Math.random) => Math.floor(rng() * (max - min + 1)) + min;
const mulberry32 = (a) => { return () => { var t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; } }
const cyrb128 = (str) => { let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762; for (let i = 0, k; i < str.length; i++) { k = str.charCodeAt(i); h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233); h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179); } h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233); h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179); return (h1^h2^h3^h4) >>> 0; }
const getRandomGenerator = (seed) => { if (seed) { const seedNumber = typeof seed === 'number' ? seed : cyrb128(String(seed)); return mulberry32(seedNumber); } return Math.random; };

const toXML = (obj, rootName = "response") => {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName}>\n`;
    const parse = (items) => {
        let str = "";
        if (Array.isArray(items)) { items.forEach(item => { str += `  <item>\n${parse(item)}  </item>\n`; }); } 
        else if (typeof items === 'object' && items !== null) {
            for (const key in items) {
                str += `    <${key}>\n`;
                if (typeof items[key] === 'object') { str += parse(items[key]); } else { str += `      ${items[key]}\n`; } 
                str += `    </${key}>\n`;
            }
        }
        return str;
    }
    xml += parse(obj);
    xml += `</${rootName}>`;
    return xml;
};

const calculateLuhn = (str) => { let sum = 0; for (let i = 0; i < str.length; i++) { let v = parseInt(str[i]); v *= 2 - (i % 2); if (v > 9) v -= 9; sum += v; } return (10 - (sum % 10)) % 10; };
const isValidLuhn = (str) => { if (!str) return false; let clean = str.replace(/[-+]/g, ''); if (clean.length === 12) { const century = parseInt(clean.slice(0, 2)); if (century >= 16 && century <= 20) clean = clean.slice(2); } if (clean.length === 0) return false; const base = clean.slice(0, -1); const control = parseInt(clean.slice(-1)); return calculateLuhn(base) === control; };

const generatePersonnummer = (rng, options = {}) => { if (options.invalidRate > 0 && rng() * 100 < options.invalidRate) { const pnr = generatePersonnummer(rng).split('-'); const base = pnr[0] + pnr[1].slice(0, -1); const correctDigit = calculateLuhn(base); const wrongDigit = (correctDigit + randomInt(1, 9, rng)) % 10; return `${pnr[0]}-${pnr[1].slice(0, -1)}${wrongDigit} (INVA)`; } const currentYear = new Date().getFullYear(); let minAge = (typeof options.minAge === 'number' && !Number.isNaN(options.minAge)) ? options.minAge : 18; let maxAge = (typeof options.maxAge === 'number' && !Number.isNaN(options.maxAge)) ? options.maxAge : 65; if (minAge > maxAge) [minAge, maxAge] = [maxAge, minAge]; const minYear = currentYear - maxAge; const maxYear = currentYear - minAge; const year = randomInt(minYear, maxYear, rng); const month = randomInt(1, 12, rng).toString().padStart(2, '0'); const day = randomInt(1, 28, rng).toString().padStart(2, '0'); const birthNum = randomInt(100, 999, rng).toString(); const datePart = year.toString().slice(2) + month + day; const base = datePart + birthNum; const controlDigit = calculateLuhn(base); return `${year.toString().slice(2)}${month}${day}-${birthNum}${controlDigit}`; };
const maskPersonnummer = (pnr, seed) => { const cleanPnr = pnr.replace(/[-+]/g, ''); if (!isValidLuhn(cleanPnr)) return pnr; const maskSeed = cleanPnr + (seed || 'luhn.se-mask-salt'); const rng = getRandomGenerator(maskSeed); const year = randomInt(1950, 2003, rng); const month = randomInt(1, 12, rng).toString().padStart(2, '0'); const day = randomInt(1, 28, rng).toString().padStart(2, '0'); const birthNum = randomInt(100, 999, rng).toString(); const datePart = year.toString().slice(2) + month + day; const base = datePart + birthNum; const controlDigit = calculateLuhn(base); return `${datePart.slice(0, 6)}-${birthNum}${controlDigit}`; };
const generateCreditCard = (type, rng) => { let base; if (type === 'Visa') { base = '424242'; while (base.length < 15) base += randomInt(0, 9, rng); } else if (type === 'Mastercard') { base = '555555'; while (base.length < 15) base += randomInt(0, 9, rng); } else { base = '424242' + randomInt(100000000, 999999999, rng); } return base + calculateLuhn(base); };
const generateIMEI = (rng) => { const tacs = ["35", "86", "99", "01"]; let base = random(tacs, rng); while (base.length < 14) base += randomInt(0, 9, rng); return base + calculateLuhn(base); };
const generateOrgNummer = (rng) => { const prefix = "55"; const third = randomInt(6, 9, rng); const middle = randomInt(100000, 999999, rng).toString(); const base = prefix + third + middle; const controlDigit = calculateLuhn(base); return `${base.slice(0, 6)}-${base.slice(6)}${controlDigit}`; };
const firstNames = ["Erik", "Lars", "Karl", "Anders", "Johan", "Per", "Nils", "Mikael", "Jan", "Hans", "Maria", "Anna", "Margareta", "Elisabeth", "Eva", "Birgitta", "Kristina", "Karin", "William", "Liam", "Noah", "Hugo", "Lucas", "Oliver", "Alice", "Maja", "Elsa", "Astrid", "Wilma", "Freja"];
const lastNames = ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson", "Persson", "Svensson", "Gustafsson"];
const streets = ["Storgatan", "Drottninggatan", "Kungsgatan", "Sveavägen", "Vasagatan", "Linnégatan", "Odengatan", "Ringvägen", "Skolgatan", "Kyrkogatan"];
const cityRanges = [ { city: "Stockholm", min: 111, max: 199 }, { city: "Göteborg", min: 411, max: 418 }, { city: "Malmö", min: 211, max: 227 }, { city: "Uppsala", min: 752, max: 757 } ];
const generateAddress = (rng) => { const area = random(cityRanges, rng); const prefix = randomInt(area.min, area.max, rng); const suffix = randomInt(10, 99, rng); return { gata: `${random(streets, rng)} ${randomInt(1, 150, rng)}`, postnummer: `${prefix} ${suffix}`, ort: area.city }; };

const createPerson = (rng, options) => { const fn = random(firstNames, rng); const ln = random(lastNames, rng); const cleanName = (str) => str.toLowerCase().replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o'); return { id: randomInt(1, 999999, rng), namn: `${fn} ${ln}`, personnummer: generatePersonnummer(rng, options), ...generateAddress(rng), kontakt: { mobil: `070-17406${randomInt(5, 99, rng).toString().padStart(2, '0')}`, email: `${cleanName(fn)}.${cleanName(ln)}@luhn.se` } }; };
const createCompany = (rng) => { const name = `${random(["Nordic", "Svea", "Tech"])} ${random(["AB", "Consulting AB"])}`; return { id: randomInt(1, 999999, rng), foretag: name, orgnummer: generateOrgNummer(rng), ...generateAddress(rng) }; };
const createVehicle = (rng) => { return { id: randomInt(1, 999999, rng), regnummer: "ABC 123", typ: "Personbil", modell: "Volvo V60" }; };
const createCard = (rng) => { const brand = random(['Visa', 'Mastercard'], rng); return { id: randomInt(1, 999999, rng), typ: "Kreditkort", brand: brand, nummer: generateCreditCard(brand, rng), cvv: randomInt(100, 999, rng).toString(), exp: `${randomInt(1, 12, rng).toString().padStart(2,'0')}/${randomInt(25, 30, rng)}` }; };
const createDevice = (rng) => { return { id: randomInt(1, 999999, rng), typ: "Mobiltelefon", imei: generateIMEI(rng), modell: "iPhone 15" }; };

const handleResponse = async (req, res, dataFunction, options = {}) => {
    let rng = Math.random;
    if (req.query.seed) rng = getRandomGenerator(req.query.seed);
    else if (req.params.id) rng = getRandomGenerator(req.params.id);

    if (req.query.delay) await new Promise(r => setTimeout(r, parseInt(req.query.delay)));
    if (req.query.status) { const code = parseInt(req.query.status); if (code >= 400) return res.status(code).json({ error: true, message: "Simulerat fel från Luhn.se", code: code }); }
    
    const amount = parseInt(req.query.amount) || 1;
    const planLimit = req.userContext ? req.userContext.plan.bulk : 100;
    const limit = Math.min(amount, planLimit); 

    let data = limit === 1 ? dataFunction(rng, options) : Array.from({ length: limit }, () => dataFunction(rng, options));
    if (req.params.id && !Array.isArray(data)) data.id = parseInt(req.params.id);

    const finalData = Array.isArray(data) ? data : [data];
    finalData.forEach(item => item.generatedAt = new Date().toISOString());
    if (!Array.isArray(data)) data = finalData[0];
    if (req.query.format === 'xml') { res.header('Content-Type', 'application/xml'); return res.send(toXML(data)); }
    res.json(data);
};

const getScenarioOptions = (req) => ({ invalidRate: parseInt(req.query.invalidRate) || 0, city: req.query.city, minAge: parseInt(req.query.minAge), maxAge: parseInt(req.query.maxAge), });

// --- PAGE ROUTES ---
// Serve clean URLs for static pages
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/luhn-algoritmen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'luhn-algoritmen.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));

// --- API DATA ROUTES ---
app.get('/api/person', (req, res) => handleResponse(req, res, createPerson, getScenarioOptions(req)));
app.get('/api/person/:id', (req, res) => handleResponse(req, res, createPerson, getScenarioOptions(req)));
app.get('/api/company', (req, res) => handleResponse(req, res, createCompany));
app.get('/api/company/:id', (req, res) => handleResponse(req, res, createCompany));
app.get('/api/vehicle', (req, res) => handleResponse(req, res, createVehicle));
app.get('/api/creditcard', (req, res) => handleResponse(req, res, createCard));
app.get('/api/imei', (req, res) => handleResponse(req, res, createDevice));

app.post('/api/mask', (req, res) => {
    const data = req.body.data || [];
    if (!Array.isArray(data)) return res.status(400).json({ error: true, message: "Input måste vara en array i 'data'." });
    res.json({ success: true, maskedData: data.map(item => ({ masked: maskPersonnummer(item, req.query.seed), isValid: isValidLuhn(maskPersonnummer(item, req.query.seed)) })) });
});

app.get('/api/validate/:input', (req, res) => {
    const input = req.params.input;
    const isValid = isValidLuhn(input);
    res.json({ input, isValid });
});





// Starta servern om filen körs direkt
if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
}

module.exports = app;