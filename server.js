// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const Stripe = require('stripe');
const PocketBase = require('pocketbase/cjs');
const crypto = require('crypto'); // Added for UUID generation


const app = express();
const PORT = process.env.PORT || 3000;

// --- GLOBAL MIDDLEWARE ---
app.use(cors());
// --- NY KOD HÄR: Logga alla anrop ---
app.use((req, res, next) => {
    console.log(`📡 [${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next(); // Skickar vidare anropet till nästa funktion
});
// Lägg till { index: false } för att hindra den från att ladda index.html automatiskt
app.use(express.static(path.join(__dirname, 'public'), { index: false }));


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
        pb = new PocketBase(process.env.POCKETBASE_URL || 'https://pb.luhn.se');
        await pb.admins.authWithPassword(process.env.POCKETBASE_ADMIN_EMAIL, process.env.POCKETBASE_ADMIN_PASSWORD);
        pb.autoCancellation(false);
        console.log("✅ Pocketbase Admin client authenticated.");
    } catch (err) {
        console.error("❌ CRITICAL: Pocketbase Admin client failed to authenticate.", err);
    }
})();


// --- API MIDDLEWARE ---
const PLAN_LIMITS = {
    hobby: { rate: 100, bulk: 100, name: "Hobby" },
    pro: { rate: 2000, bulk: 10000, name: "Pro" },
    team: { rate: 10000, bulk: 10000, name: "Team" }
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
const cyrb128 = (str) => { let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762; for (let i = 0, k; i < str.length; i++) { k = str.charCodeAt(i); h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233); h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179); } h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233); h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179); return (h1 ^ h2 ^ h3 ^ h4) >>> 0; }
const getRandomGenerator = (seed) => { if (seed) { const seedNumber = typeof seed === 'number' ? seed : cyrb128(String(seed)); return mulberry32(seedNumber); } return Math.random; };

const toXML = (obj, rootName = "response") => {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName}>\n`;
    const parse = (items) => {
        let str = "";
        if (Array.isArray(items)) { items.forEach(item => { str += `  <item>\n${parse(item)}  </item>\n`; }); }
        else if (typeof items === 'object' && items !== null) {
            for (const key in items) {
                if (items[key] === undefined || items[key] === null) continue;
                str += `    <${key}>\n`;
                if (typeof items[key] === 'object') { str += parse(items[key]); } else { str += `      ${String(items[key]).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}\n`; }
                str += `    </${key}>\n`;
            }
        }
        return str;
    }
    xml += parse(obj);
    xml += `</${rootName}>`;
    return xml;
};

const toCSV = (data) => {
    if (!Array.isArray(data) || data.length === 0) {
        return "";
    }

    const flattenObject = (obj, prefix = '') => {
        return Object.keys(obj).reduce((acc, k) => {
            const pre = prefix.length ? prefix + '.' : '';
            if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
                Object.assign(acc, flattenObject(obj[k], pre + k));
            } else {
                acc[pre + k] = obj[k];
            }
            return acc;
        }, {});
    };

    const flattenedData = data.map(item => flattenObject(item));

    const headers = Array.from(new Set(flattenedData.flatMap(Object.keys)));

    const escapeCSV = (value) => {
        if (value === null || value === undefined) {
            return '';
        }
        let strValue = String(value);
        if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
            return `"${strValue.replace(/"/g, '""')}"`;
        }
        return strValue;
    };

    let csv = headers.map(escapeCSV).join(',') + '\n';

    flattenedData.forEach(row => {
        csv += headers.map(header => escapeCSV(row[header])).join(',') + '\n';
    });

    return csv;
};

const toSQLInsert = (data, tableName) => {
    if (!Array.isArray(data) || data.length === 0) {
        return "";
    }

    const flattenObject = (obj, prefix = '') => {
        return Object.keys(obj).reduce((acc, k) => {
            const pre = prefix.length ? prefix + '_' : ''; // Use underscore for SQL column names
            if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
                Object.assign(acc, flattenObject(obj[k], pre + k));
            } else {
                acc[pre + k] = obj[k];
            }
            return acc;
        }, {});
    };

    const flattenedData = data.map(item => flattenObject(item));

    const columns = Array.from(new Set(flattenedData.flatMap(Object.keys)));
    const quotedColumns = columns.map(col => `\`${col}\``).join(', ');

    let sql = [];

    flattenedData.forEach(row => {
        const values = columns.map(col => {
            const value = row[col];
            if (value === null || value === undefined) {
                return 'NULL';
            }
            if (typeof value === 'string') {
                return `'${value.replace(/'/g, "''")}'`; // Escape single quotes
            }
            return value; // Numbers, booleans (might need conversion to 0/1)
        });
        sql.push(`INSERT INTO \`${tableName}\` (${quotedColumns}) VALUES (${values.join(', ')});`);
    });

    return sql.join('\n');
};

const calculateLuhn = (str) => { let sum = 0; for (let i = 0; i < str.length; i++) { let v = parseInt(str[i]); v *= 2 - (i % 2); if (v > 9) v -= 9; sum += v; } return (10 - (sum % 10)) % 10; };
const calculateMod10Weighted = (str, weights) => {
    let sum = 0;
    for (let i = 0; i < str.length; i++) {
        const digit = parseInt(str[str.length - 1 - i]);
        sum += digit * weights[i % weights.length];
    }
    return (10 - (sum % 10)) % 10;
};
const isValidLuhn = (str) => { if (!str) return false; let clean = str.replace(/[-+]/g, ''); if (clean.length === 12) { const century = parseInt(clean.slice(0, 2)); if (century >= 16 && century <= 20) clean = clean.slice(2); } if (clean.length === 0) return false; const base = clean.slice(0, -1); const control = parseInt(clean.slice(-1)); return calculateLuhn(base) === control; };

const generateBankgiro = (rng) => {
    let base = '';
    for (let i = 0; i < 7; i++) {
        base += randomInt(0, 9, rng);
    }
    const checkDigit = calculateLuhn(base);
    return `${base.slice(0, 3)}-${base.slice(3)}${checkDigit}`;
};

const generatePlusgiro = (rng) => {
    let base = '';
    const length = randomInt(6, 8, rng);
    for (let i = 0; i < length; i++) {
        base += randomInt(0, 9, rng);
    }
    const checkDigit = calculateMod10Weighted(base, [7, 3, 1]); // Plusgiro weights

    if (base.length === 6) {
        return `${base.slice(0, 2)} ${base.slice(2, 4)} ${base.slice(4)}-${checkDigit}`;
    } else if (base.length === 7) {
        return `${base.slice(0, 3)} ${base.slice(3, 5)} ${base.slice(5)}-${checkDigit}`;
    } else if (base.length === 8) {
        return `${base.slice(0, 4)} ${base.slice(4, 6)} ${base.slice(6)}-${checkDigit}`;
    }
    return `${base}-${checkDigit}`;
};

const generatePersonnummer = (rng, options = {}) => {
    if (options.invalidRate > 0 && rng() * 100 < options.invalidRate) {
        const pnr = generatePersonnummer(rng, { ...options, invalidRate: 0 }).split('-'); // Generate a valid one first, then invalidate
        const base = pnr[0] + pnr[1].slice(0, -1);
        const correctDigit = calculateLuhn(base);
        const wrongDigit = (correctDigit + randomInt(1, 9, rng)) % 10;
        return `${pnr[0]}-${pnr[1].slice(0, -1)}${wrongDigit} (INVA)`;
    }

    const currentYear = new Date().getFullYear();
    let minAge = (typeof options.minAge === 'number' && !Number.isNaN(options.minAge)) ? options.minAge : 18;
    let maxAge = (typeof options.maxAge === 'number' && !Number.isNaN(options.maxAge)) ? options.maxAge : 65;
    if (minAge > maxAge) [minAge, maxAge] = [maxAge, minAge];
    const minYear = currentYear - maxAge;
    const maxYear = currentYear - minAge;

    const year = randomInt(minYear, maxYear, rng);
    const month = randomInt(1, 12, rng).toString().padStart(2, '0');
    const day = randomInt(1, 28, rng).toString().padStart(2, '0');

    let birthNumCandidates = [];
    for (let i = 0; i <= 999; i++) {
        const numStr = String(i).padStart(3, '0');
        const thirdToLastDigit = parseInt(numStr.charAt(2)); // The last digit of birthNum part, which determines gender parity

        if (options.gender === 'female' && thirdToLastDigit % 2 === 0) {
            birthNumCandidates.push(numStr);
        } else if (options.gender === 'male' && thirdToLastDigit % 2 !== 0) {
            birthNumCandidates.push(numStr);
        } else if (!options.gender) { // No gender specified, allow any
            birthNumCandidates.push(numStr);
        }
    }

    // Fallback if no specific gender candidates are found (shouldn't happen for 0-999 range)
    if (birthNumCandidates.length === 0) {
        for (let i = 0; i <= 999; i++) birthNumCandidates.push(String(i).padStart(3, '0'));
    }

    const birthNum = random(birthNumCandidates, rng);
    const datePart = year.toString().slice(2) + month + day;
    const base = datePart + birthNum;
    const controlDigit = calculateLuhn(base);

    return `${year.toString().slice(2)}${month}${day}-${birthNum}${controlDigit}`;
};
const maskPersonnummer = (pnr, seed) => { const cleanPnr = pnr.replace(/[-+]/g, ''); if (!isValidLuhn(cleanPnr)) return pnr; const maskSeed = cleanPnr + (seed || 'luhn.se-mask-salt'); const rng = getRandomGenerator(maskSeed); const year = randomInt(1950, 2003, rng); const month = randomInt(1, 12, rng).toString().padStart(2, '0'); const day = randomInt(1, 28, rng).toString().padStart(2, '0'); const birthNum = randomInt(100, 999, rng).toString(); const datePart = year.toString().slice(2) + month + day; const base = datePart + birthNum; const controlDigit = calculateLuhn(base); return `${datePart.slice(0, 6)}-${birthNum}${controlDigit}`; };
const generateCreditCard = (type, rng) => { let base; if (type === 'Visa') { base = '424242'; while (base.length < 15) base += randomInt(0, 9, rng); } else if (type === 'Mastercard') { base = '555555'; while (base.length < 15) base += randomInt(0, 9, rng); } else { base = '424242' + randomInt(100000000, 999999999, rng); } return base + calculateLuhn(base); };
const generateIMEI = (rng) => { const tacs = ["35", "86", "99", "01"]; let base = random(tacs, rng); while (base.length < 14) base += randomInt(0, 9, rng); return base + calculateLuhn(base); };
const generateOrgNummer = (rng) => { const prefix = "55"; const third = randomInt(6, 9, rng); const middle = randomInt(100000, 999999, rng).toString(); const base = prefix + third + middle; const controlDigit = calculateLuhn(base); return `${base.slice(0, 6)}-${base.slice(6)}${controlDigit}`; };
const firstNames = ["Erik", "Lars", "Karl", "Anders", "Johan", "Per", "Nils", "Mikael", "Jan", "Hans", "Maria", "Anna", "Margareta", "Elisabeth", "Eva", "Birgitta", "Kristina", "Karin", "William", "Liam", "Noah", "Hugo", "Lucas", "Oliver", "Alice", "Maja", "Elsa", "Astrid", "Wilma", "Freja"];
const lastNames = ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson", "Persson", "Svensson", "Gustafsson"];
const streets = ["Storgatan", "Drottninggatan", "Kungsgatan", "Sveavägen", "Vasagatan", "Linnégatan", "Odengatan", "Ringvägen", "Skolgatan", "Kyrkogatan"];

let postalCodeData = [];

const FALLBACK_POSTAL_DATA = [
    { postnummer: "111 22", ort: "Stockholm", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "111 29", ort: "Stockholm", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "113 56", ort: "Stockholm", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "115 21", ort: "Stockholm", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "118 60", ort: "Stockholm", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "121 31", ort: "Bromma", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "122 32", ort: "Enskede", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "126 30", ort: "Hägersten", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "127 40", ort: "Skärholmen", kommun: "Stockholm", län: "Stockholms län" },
    { postnummer: "131 40", ort: "Nacka", kommun: "Nacka", län: "Stockholms län" },
    { postnummer: "141 71", ort: "Huddinge", kommun: "Huddinge", län: "Stockholms län" },
    { postnummer: "151 50", ort: "Södertälje", kommun: "Södertälje", län: "Stockholms län" },
    { postnummer: "181 32", ort: "Lidingö", kommun: "Lidingö", län: "Stockholms län" },
    { postnummer: "191 43", ort: "Sollentuna", kommun: "Sollentuna", län: "Stockholms län" },

    { postnummer: "201 20", ort: "Malmö", kommun: "Malmö", län: "Skåne län" },
    { postnummer: "211 35", ort: "Malmö", kommun: "Malmö", län: "Skåne län" },
    { postnummer: "212 18", ort: "Malmö", kommun: "Malmö", län: "Skåne län" },
    { postnummer: "214 32", ort: "Malmö", kommun: "Malmö", län: "Skåne län" },
    { postnummer: "217 46", ort: "Malmö", kommun: "Malmö", län: "Skåne län" },
    { postnummer: "221 00", ort: "Lund", kommun: "Lund", län: "Skåne län" },
    { postnummer: "252 21", ort: "Helsingborg", kommun: "Helsingborg", län: "Skåne län" },
    { postnummer: "291 33", ort: "Kristianstad", kommun: "Kristianstad", län: "Skåne län" },

    { postnummer: "411 01", ort: "Göteborg", kommun: "Göteborg", län: "Västra Götalands län" },
    { postnummer: "413 04", ort: "Göteborg", kommun: "Göteborg", län: "Västra Götalands län" },
    { postnummer: "415 03", ort: "Göteborg", kommun: "Göteborg", län: "Västra Götalands län" },
    { postnummer: "417 55", ort: "Göteborg", kommun: "Göteborg", län: "Västra Götalands län" },
    { postnummer: "421 30", ort: "Västra Frölunda", kommun: "Göteborg", län: "Västra Götalands län" },
    { postnummer: "431 37", ort: "Mölndal", kommun: "Mölndal", län: "Västra Götalands län" },
    { postnummer: "451 50", ort: "Uddevalla", kommun: "Uddevalla", län: "Västra Götalands län" },
    { postnummer: "461 30", ort: "Trollhättan", kommun: "Trollhättan", län: "Västra Götalands län" },

    { postnummer: "753 10", ort: "Uppsala", kommun: "Uppsala", län: "Uppsala län" },
    { postnummer: "754 40", ort: "Uppsala", kommun: "Uppsala", län: "Uppsala län" },
    { postnummer: "756 51", ort: "Uppsala", kommun: "Uppsala", län: "Uppsala län" },

    { postnummer: "903 26", ort: "Umeå", kommun: "Umeå", län: "Västerbottens län" },
    { postnummer: "981 32", ort: "Kiruna", kommun: "Kiruna", län: "Norrbottens län" },
    { postnummer: "802 55", ort: "Gävle", kommun: "Gävle", län: "Gävleborgs län" },
    { postnummer: "632 20", ort: "Eskilstuna", kommun: "Eskilstuna", län: "Södermanlands län" },
    { postnummer: "582 24", ort: "Linköping", kommun: "Linköping", län: "Östergötlands län" },
    { postnummer: "352 36", ort: "Växjö", kommun: "Växjö", län: "Kronobergs län" },
    { postnummer: "702 10", ort: "Örebro", kommun: "Örebro", län: "Örebro län" },
    { postnummer: "654 60", ort: "Karlstad", kommun: "Karlstad", län: "Värmlands län" },
    { postnummer: "722 10", ort: "Västerås", kommun: "Västerås", län: "Västmanlands län" },
    { postnummer: "371 34", ort: "Karlskrona", kommun: "Karlskrona", län: "Blekinge län" },
    { postnummer: "852 36", ort: "Sundsvall", kommun: "Sundsvall", län: "Västernorrlands län" },
];

const loadPostalData = () => {
    const filePath = path.join(__dirname, 'data', 'postnummer.csv');

    if (!fs.existsSync(filePath)) {
        console.warn("⚠️  data/postnummer.csv saknas. Kör med begränsad fallback-data.");
        console.warn("👉  Ladda ner riktig data: https://raw.githubusercontent.com/Axelsson2000/data/master/Pnr-Ort-Kommun-KnKod-LnNamn-Lat-Long-GM_202409.csv");
        postalCodeData = FALLBACK_POSTAL_DATA;
        return;
    }

    try {
        console.log("⏳ Läser in postnummerdatabas...");
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split('\n');

        // Hoppa över header-raden om den finns och mappa datan
        postalCodeData = lines
            .slice(1) // Skippa header
            .map(line => {
                // ÄNDRING HÄR: Byt från ';' till ','
                const parts = line.split(',');

                if (parts.length < 5) return null;
                return {
                    postnummer: parts[0].trim().replace(" ", ""), // Index 0 är Postnummer
                    ort: parts[1].trim(),                         // Index 1 är Ort
                    kommun: parts[2].trim(),                      // Index 2 är KnNamn (Kommun)
                    län: parts[4].trim()                          // Index 4 är LnNamn (Län)
                };
            })
            .filter(item => item !== null && item.postnummer.length === 5);

        console.log(`✅ Postnummerdatabas laddad: ${postalCodeData.length} orter.`);
    } catch (err) {
        console.error("❌ Fel vid inläsning av postnummer.csv:", err.message);
        postalCodeData = FALLBACK_POSTAL_DATA;
    }
};

// Kör inläsningen direkt
loadPostalData();

const generateAddress = (rng, options = {}) => {
    // SÄKERHETSKOLL: Använd fallback om databasen är tom
    let sourceData = postalCodeData.length > 0 ? postalCodeData : FALLBACK_POSTAL_DATA;
    let filteredData = sourceData;

    // Filtrera på stad om parametern ?city=... används
    if (options.city) {
        const searchCity = options.city.trim().toLowerCase();
        
        filteredData = filteredData.filter(item => item.ort.toLowerCase() === searchCity);

        // DEBUG: Om vi inte hittar något, logga varför i terminalen
        if (filteredData.length === 0) {
            console.log(`⚠️  VARNING: Hittade ingen stad som matchade "${options.city}" (sökte efter "${searchCity}").`);
            console.log(`ℹ️  Första 3 orterna i databasen är: ${sourceData.slice(0, 3).map(i => `"${i.ort}"`).join(', ')}`);
            
            // Fallback: Använd hela listan igen så koden inte kraschar
            filteredData = sourceData; 
        }
    }
    
    // Slumpa en plats
    const selectedLocation = random(filteredData, rng);

    // Om något gick snett och vi inte fick en träff alls (extremt kantfall)
    if (!selectedLocation) {
        return { gata: "Storgatan 1", postnummer: "111 22", ort: "Stockholm", kommun: "Stockholm", lan: "Stockholms län" };
    }

    // Formatera postnumret (12345 -> 123 45)
    const pnr = selectedLocation.postnummer;
    const formattedPnr = `${pnr.slice(0, 3)} ${pnr.slice(3)}`;

    return { 
        gata: `${random(streets, rng)} ${randomInt(1, 150, rng)}`, 
        postnummer: formattedPnr, 
        ort: selectedLocation.ort,
        kommun: selectedLocation.kommun,
        lan: selectedLocation.län || selectedLocation.lan
    };
};

const bankData = [{ name: "Swedbank", clearing: [7000, 7999] }, { name: "Handelsbanken", clearing: [6000, 6999] }, { name: "SEB", clearing: [5000, 5999] }, { name: "Nordea", clearing: [1100, 1199] },];
const mod97 = (str) => {
    let checksum = "";
    for (let i = 0; i < str.length; i++) {
        checksum = (checksum + str[i]) % 97;
    }
    return checksum;
};
const generateIban = (rng) => { const bank = random(bankData, rng); const clearing = randomInt(bank.clearing[0], bank.clearing[1], rng); const account = ('' + randomInt(1, 999999999, rng)).padStart(10, '0'); const bban = `${clearing}0000${account}`.slice(0, 20); const numericIban = bban.split('').map(c => c.charCodeAt(0) - 55).join('') + '281400'; let checksum = 98 - mod97(numericIban); return `SE${String(checksum).padStart(2, '0')}${clearing}${account}`.slice(0, 24); };

const createPerson = (rng, options) => { const fn = random(firstNames, rng); const ln = random(lastNames, rng); const cleanName = (str) => str.toLowerCase().replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o'); return { id: randomInt(1, 999999, rng), namn: `${fn} ${ln}`, personnummer: generatePersonnummer(rng, options), ...generateAddress(rng, options), kontakt: { mobil: `070-17406${randomInt(5, 99, rng).toString().padStart(2, '0')}`, email: `${cleanName(fn)}.${cleanName(ln)}@luhn.se` } }; };

const companyNamePrefixes = ["Nordic", "Svenska", "Global", "Stockholm", "Göteborgs", "Malmö", "Digitala", "Kreativa", "Svea", "Modern"];
const companyNameKeywords = ["Konsult", "Teknik", "Solutions", "Bygg", "Finans", "Media", "Design", "IT", "Partner", "Gruppen", "Invest"];
const companyLegalForms = ["Aktiebolag", "Handelsbolag", "Kommanditbolag", "Enskild Firma"];

const createCompany = (rng) => {
    const legalForm = random(companyLegalForms, rng);
    let name = "";

    if (legalForm === "Enskild Firma") {
        const fn = random(firstNames, rng);
        const ln = random(lastNames, rng);
        name = `${ln}, ${fn}`;
    } else {
        name = `${random(companyNamePrefixes, rng)} ${random(companyNameKeywords, rng)}`;
        if (legalForm === "Aktiebolag") {
            name += " AB";
        } else if (legalForm === "Handelsbolag") {
            name += " HB";
        } else if (legalForm === "Kommanditbolag") {
            name += " KB";
        }
    }

    return {
        id: randomInt(1, 999999, rng),
        foretag: name,
        bolagsform: legalForm,
        orgnummer: generateOrgNummer(rng),
        ...generateAddress(rng)
    };
};

const vehicleData = [
    // Bilar
    { typ: "Personbil", modell: "Volvo V60" },
    { typ: "Personbil", modell: "Volkswagen Golf" },
    { typ: "Personbil", modell: "Tesla Model Y" },
    { typ: "Personbil", modell: "Kia Niro" },
    { typ: "Personbil", modell: "Toyota RAV4" },
    { typ: "Personbil", modell: "BMW 3-serie" },
    { typ: "Personbil", modell: "Audi A4" },
    { typ: "Personbil", modell: "Skoda Octavia" },
    { typ: "Personbil", modell: "Porsche 911" },
    { typ: "Personbil", modell: "Polestar 2" },
    // Lastbilar
    { typ: "Lastbil", modell: "Scania R-serie" },
    { typ: "Lastbil", modell: "Volvo FH16" },
    { typ: "Lastbil", modell: "Mercedes-Benz Actros" },
    { typ: "Lastbil", modell: "MAN TGX" },
    // MC
    { typ: "MC", modell: "Harley-Davidson Sportster" },
    { typ: "MC", modell: "Honda CBR" },
    { typ: "MC", modell: "BMW R1250GS" },
    { typ: "MC", modell: "Yamaha MT-07" },
    // Släpvagnar
    { typ: "Släpvagn", modell: "Brenderup 1205S" },
    { typ: "Släpvagn", modell: "Fogelsta F1425" },
    { typ: "Släpvagn", modell: "Respo 750M" },
    { typ: "Släpvagn", modell: "Tiki C-265" },
];
const generateRegnummer = (rng) => {
    const letters = 'ABCDEFGHJKLMNPRSTUWXYZ'; // Bokstäver som används i regnummer
    const lastChars = '0123456789ABCDEFGHJKLMNPRSTUWXYZ';
    let reg = '';
    for (let i = 0; i < 3; i++) {
        reg += letters.charAt(Math.floor(rng() * letters.length));
    }
    reg += ' ';
    reg += randomInt(10, 99, rng);
    reg += lastChars.charAt(Math.floor(rng() * lastChars.length));
    return reg;
};
const createVehicle = (rng) => {
    const vehicleIndex = Math.floor(rng() * vehicleData.length);
    console.log("DEBUG: createVehicle - Picking vehicle at index:", vehicleIndex);
    const vehicle = vehicleData[vehicleIndex];
    return {
        id: randomInt(1, 999999, rng),
        regnummer: generateRegnummer(rng),
        typ: vehicle.typ,
        modell: vehicle.modell
    };
};

const createCard = (rng) => { const brand = random(['Visa', 'Mastercard'], rng); return { id: randomInt(1, 999999, rng), typ: "Kreditkort", brand: brand, nummer: generateCreditCard(brand, rng), cvv: randomInt(100, 999, rng).toString(), exp: `${randomInt(1, 12, rng).toString().padStart(2, '0')}/${randomInt(25, 30, rng)}` }; };
const createDevice = (rng) => { return { id: randomInt(1, 999999, rng), typ: "Mobiltelefon", imei: generateIMEI(rng), modell: "iPhone 15" }; };
const createFinance = (rng) => { const bank = random(bankData, rng); return { id: randomInt(1, 999999, rng), bank: bank.name, iban: generateIban(rng), typ: "Lönekonto" }; };
const createIdentity = (rng, options) => { const person = createPerson(rng, options); delete person.id; return { id: randomInt(1, 999999, rng), person, kort: createCard(rng), enhet: createDevice(rng), fordon: createVehicle(rng), }; };
const createBankIdMock = (rng) => {
    const orderRef = crypto.randomUUID();
    const autoStartToken = crypto.randomBytes(32).toString('hex');
    const qrCodeSvg = `<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="black"/></svg>`;
    const qrCode = `data:image/svg+xml;base64,${Buffer.from(qrCodeSvg).toString('base64')}`;

    return {
        orderRef: orderRef,
        autoStartToken: autoStartToken,
        qrCode: qrCode,
        status: 'pending',
        message: 'Starta din BankID-app.',
        generatedAt: new Date().toISOString()
    };
};


const handleResponse = async (req, res, dataFunction, options = {}) => {
    // --- NY LOGIK: Feature Gating för Hobby-användare ---
    if (req.query.format && ['xml', 'csv', 'sql'].includes(req.query.format)) {
        if (!req.userContext || req.userContext.type === 'hobby') {
            return res.status(403).json({
                error: true,
                message: `Formatet '${req.query.format}' kräver Pro- eller Team-plan. Uppgradera på https://luhn.se/profile`
            });
        }
    }

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
    if (!Array.isArray(data)) data = finalData[0]; // This line ensures that for single item requests, data is still an object not an array

    if (req.query.format === 'xml') { res.header('Content-Type', 'application/xml'); return res.send(toXML(data)); }
    if (req.query.format === 'csv') { res.header('Content-Type', 'text/csv'); return res.send(toCSV(finalData)); }
    if (req.query.format === 'sql') {
        const resourceName = req.path.split('/').filter(Boolean).pop(); // Extract 'person', 'company' etc.
        res.header('Content-Type', 'application/sql');
        return res.send(toSQLInsert(finalData, resourceName));
    }
    res.json(data);
};

const getScenarioOptions = (req) => ({
    invalidRate: parseInt(req.query.invalidRate) || 0,
    city: req.query.city,
    minAge: parseInt(req.query.minAge),
    maxAge: parseInt(req.query.maxAge),
    gender: req.query.gender // Add gender parameter
});

// --- PAGE ROUTES ---
// Serve clean URLs for static pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coming-soon.html')));
app.get('/d', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/luhn-algoritmen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'luhn-algoritmen.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/personnummer-generator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'personnummer-generator.html')));
app.get('/organisationsnummer-generator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'organisationsnummer-generator.html')));


// --- API DATA ROUTES ---
app.get('/api/person', (req, res) => handleResponse(req, res, createPerson, getScenarioOptions(req)));
app.get('/api/person/:id', (req, res) => handleResponse(req, res, createPerson, getScenarioOptions(req)));
app.get('/api/company', (req, res) => handleResponse(req, res, createCompany));
app.get('/api/company/:id', (req, res) => handleResponse(req, res, createCompany));
app.get('/api/vehicle', (req, res) => handleResponse(req, res, createVehicle));
app.get('/api/creditcard', (req, res) => handleResponse(req, res, createCard));
app.get('/api/imei', (req, res) => handleResponse(req, res, createDevice));
app.get('/api/finance', (req, res) => handleResponse(req, res, createFinance));
app.get('/api/identity', (req, res) => handleResponse(req, res, createIdentity));
app.get('/api/bankid', (req, res) => handleResponse(req, res, createBankIdMock));
app.get('/api/bankgiro', (req, res) => handleResponse(req, res, (rng) => ({ bankgiro: generateBankgiro(rng) })));
app.get('/api/plusgiro', (req, res) => handleResponse(req, res, (rng) => ({ plusgiro: generatePlusgiro(rng) })));

app.post('/api/mask', (req, res) => {
    // --- NY LOGIK: Feature Gating för Hobby-användare ---
    if (!req.userContext || req.userContext.type === 'hobby') {
        return res.status(403).json({
            error: true,
            message: "Data Maskning kräver Pro- eller Team-plan. Uppgradera på https://luhn.se/profile"
        });
    }
    // ----------------------------------------------------

    const data = req.body.data || [];
    if (!Array.isArray(data)) return res.status(400).json({ error: true, message: "Input måste vara en array i 'data'." });
    res.json({ success: true, maskedData: data.map(item => ({ masked: maskPersonnummer(item, req.query.seed), isValid: isValidLuhn(maskPersonnummer(item, req.query.seed)) })) });
});

const detectNumberType = (str) => {
    const cleanStr = str.replace(/[-+\s]/g, '');
    if (cleanStr.length === 10 || cleanStr.length === 12) {
        if (cleanStr.length === 10 && ['16', '55', '7', '8', '9'].some(prefix => cleanStr.startsWith(prefix))) {
            return "Organisationsnummer";
        }
        return "Personnummer";
    }
    if (cleanStr.length >= 13 && cleanStr.length <= 19) {
        return "Kreditkort";
    }
    return "Okänd";
};

app.post('/api/validate/bulk', (req, res) => {
    const { numbers } = req.body;
    if (!Array.isArray(numbers)) {
        return res.status(400).json({ error: true, message: "Input måste vara en JSON array med namnet 'numbers'." });
    }

    const results = numbers.map(num => {
        const type = detectNumberType(num);
        const isValid = isValidLuhn(num);
        return {
            number: num,
            type: type,
            isValid: isValid
        };
    });

    res.json(results);
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