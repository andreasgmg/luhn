// server.js - PRODUCTION READY (DUAL RATE LIMITS)
require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// --- KONFIGURATION FÖR PLANER ---
const PLAN_LIMITS = {
    hobby: { rate: 100,   bulk: 100,   name: "Hobby" }, // Max 100 rader per anrop
    pro:   { rate: 2000,  bulk: 10000, name: "Pro" },   // Max 10 000 rader per anrop
    team:  { rate: 10000, bulk: 10000, name: "Team" }   // Max 10 000 rader per anrop
};

// --- SQLITE SETUP ---
const DB_FILE = './luhn.db';
let db = null;

(async () => {
    try {
        const dbExists = fs.existsSync(DB_FILE);
        db = await open({
            filename: DB_FILE,
            driver: sqlite3.Database
        });

        if (!dbExists) {
            console.log("🏃‍➡️ Creating database schema...");
            await db.exec(`
                CREATE TABLE api_keys (
                    key_value TEXT PRIMARY KEY,
                    plan_type TEXT NOT NULL,
                    is_active BOOLEAN NOT NULL DEFAULT true
                );
                CREATE TABLE leads (
                    email TEXT PRIMARY KEY
                );
            `);
            // Lägg till en testnyckel för Pro-planen
            await db.run("INSERT INTO api_keys (key_value, plan_type) VALUES (?, ?)", "PRO-TEST-KEY-123", "pro");
            console.log("🔑 Added a test 'pro' API key: PRO-TEST-KEY-123");
        }
        console.log("✅ SQLite database is connected and ready.");
    } catch (err) {
        console.error("❌ CRITICAL: SQLite failed to initialize.", err.message);
    }
})();


app.use(cors());
// Ta bort index false i prod
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(express.json());

// --- MIDDLEWARE: API NYCKEL CHECK ---
const identifyUser = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;
    
    // Default: Hobby-användare (identifierad via IP)
    req.userContext = { 
        type: 'hobby', 
        plan: PLAN_LIMITS.hobby, 
        identifier: req.ip 
    };

    if (apiKey && db) {
        try {
            const keyData = await db.get('SELECT plan_type, is_active FROM api_keys WHERE key_value = ?', apiKey);

            if (keyData && keyData.is_active) {
                const planType = keyData.plan_type.toLowerCase();
                if (PLAN_LIMITS[planType]) {
                    req.userContext = {
                        type: planType,
                        plan: PLAN_LIMITS[planType],
                        identifier: apiKey // Betalande kunder identifieras via nyckel
                    };
                }
            } else {
                // Om man skickar en nyckel som är fel/inaktiv -> Neka direkt.
                return res.status(401).json({ error: true, message: "Ogiltig eller inaktiv API-nyckel." });
            }
        } catch (err) {
            console.error("Database query error in identifyUser:", err.message);
            // Fail open to hobby plan if db fails
        }
    }
    next();
};

// --- RATE LIMITERS (TVÅFILSSYSTEM) ---

// 1. STANDARD LIMITER (Hög frekvens, små datamängder)
// Denna räknare tickar ALLTID upp, oavsett storlek på request.
const standardLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minuter
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userContext.identifier,
    limit: (req) => req.userContext.plan.rate, // 100, 2000 eller 10000
    handler: (req, res) => {
        res.status(429).json({
            error: true, 
            message: `Rate limit uppnådd. Din plan (${req.userContext.plan.name}) tillåter ${req.userContext.plan.rate} anrop per 15 min.`
        });
    }
});

// 2. BULK LIMITER (Låg frekvens, stora datamängder)
// Denna spärr aktiveras BARA om man ber om > 100 rader (Big Data).
const bulkLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 timme
    max: 10, // Max 10 st "Big Data"-nedladdningar per timme
    standardHeaders: false, // Vi döljer headers för bulk för att inte förvirra standard-headers
    legacyHeaders: false,
    keyGenerator: (req) => req.userContext.identifier,
    skip: (req) => {
        // Om användaren ber om 100 eller färre rader -> Hoppa över denna spärr
        const amount = parseInt(req.query.amount) || 1;
        return amount <= 100; 
    },
    handler: (req, res) => {
        res.status(429).json({
            error: true, 
            message: "Fair Usage Policy: Du har gjort för många Bulk-exporter (>100 rader) den senaste timmen. Max 10 st per timme."
        });
    }
});

// Applicera limiters: Först identifiera, sen kolla Bulk, sen Standard.
app.use('/api', identifyUser, bulkLimiter, standardLimiter);


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

// --- MATEMATIK & VALIDATORER ---
const calculateLuhn = (str) => {
    let sum = 0;
    for (let i = 0; i < str.length; i++) {
        let v = parseInt(str[i]);
        v *= 2 - (i % 2);
        if (v > 9) v -= 9;
        sum += v;
    }
    return (10 - (sum % 10)) % 10;
};
const isValidLuhn = (str) => {
    if (!str) return false;
    let clean = str.replace(/[-+]/g, ''); 
    if (clean.length === 12) { const century = parseInt(clean.slice(0, 2)); if (century >= 16 && century <= 20) clean = clean.slice(2); }
    if (clean.length === 0) return false;
    const base = clean.slice(0, -1);
    const control = parseInt(clean.slice(-1));
    return calculateLuhn(base) === control;
};

// --- GENERATORER ---
const generateInvalidPersonnummer = (rng) => {
    const pnr = generatePersonnummer(rng).split('-');
    const base = pnr[0] + pnr[1].slice(0, -1);
    const correctDigit = calculateLuhn(base);
    const wrongDigit = (correctDigit + randomInt(1, 9, rng)) % 10;
    return `${pnr[0]}-${pnr[1].slice(0, -1)}${wrongDigit} (INVA)`;
};
const generatePersonnummer = (rng, options = {}) => { 
    if (options.invalidRate > 0 && rng() * 100 < options.invalidRate) { return generateInvalidPersonnummer(rng); }
    const currentYear = new Date().getFullYear();
    let minAge = (typeof options.minAge === 'number' && !Number.isNaN(options.minAge)) ? options.minAge : null;
    let maxAge = (typeof options.maxAge === 'number' && !Number.isNaN(options.maxAge)) ? options.maxAge : null;
    if (minAge === null && maxAge === null) { minAge = 18; maxAge = 65; }
    if (minAge === null && maxAge !== null) { minAge = 0; }
    if (minAge !== null && maxAge === null) { maxAge = 100; }
    minAge = Math.max(0, Math.min(minAge, 120));
    maxAge = Math.max(0, Math.min(maxAge, 120));
    if (minAge > maxAge) [minAge, maxAge] = [maxAge, minAge];
    const minYear = currentYear - maxAge;
    const maxYear = currentYear - minAge;
    const year = randomInt(minYear, maxYear, rng);
    const month = randomInt(1, 12, rng).toString().padStart(2, '0'); 
    const day = randomInt(1, 28, rng).toString().padStart(2, '0'); 
    const birthNum = randomInt(100, 999, rng).toString(); 
    const datePart = year.toString().slice(2) + month + day; 
    const base = datePart + birthNum; 
    const controlDigit = calculateLuhn(base); 
    return `${year.toString().slice(2)}${month}${day}-${birthNum}${controlDigit}`; 
};
const maskPersonnummer = (pnr, seed) => {
    const cleanPnr = pnr.replace(/[-+]/g, '');
    if (!isValidLuhn(cleanPnr)) return pnr;
    const maskSeed = cleanPnr + (seed || 'luhn.se-mask-salt');
    const rng = getRandomGenerator(maskSeed);
    const year = randomInt(1950, 2003, rng);
    const month = randomInt(1, 12, rng).toString().padStart(2, '0');
    const day = randomInt(1, 28, rng).toString().padStart(2, '0');
    const birthNum = randomInt(100, 999, rng).toString();
    const datePart = year.toString().slice(2) + month + day; 
    const base = datePart + birthNum; 
    const controlDigit = calculateLuhn(base); 
    return `${datePart.slice(0, 6)}-${birthNum}${controlDigit}`;
};

const generateCreditCard = (type, rng) => {
    let base;
    if (type === 'Visa') { base = '424242'; while (base.length < 15) base += randomInt(0, 9, rng); }
    else if (type === 'Mastercard') { base = '555555'; while (base.length < 15) base += randomInt(0, 9, rng); }
    else { base = '424242' + randomInt(100000000, 999999999, rng); }
    return base + calculateLuhn(base);
};
const generateIMEI = (rng) => { const tacs = ["35", "86", "99", "01"]; let base = random(tacs, rng); while (base.length < 14) base += randomInt(0, 9, rng); return base + calculateLuhn(base); };
const generateOrgNummer = (rng) => { const prefix = "55"; const third = randomInt(6, 9, rng); const middle = randomInt(100000, 999999, rng).toString(); const base = prefix + third + middle; const controlDigit = calculateLuhn(base); return `${base.slice(0, 6)}-${base.slice(6)}${controlDigit}`; };
const generateSafeMobile = (rng) => { const suffix = randomInt(5, 99, rng).toString().padStart(2, '0'); return `070-17406${suffix}`; };
const generateRegPlat = (rng) => { const letters = "ABCDEFGHJKLMNPRSTUXYZ"; const numbers = "0123456789"; let plate = ""; for(let i=0; i<3; i++) plate += random(letters.split(''), rng); plate += " "; plate += random(numbers.split(''), rng); plate += random(numbers.split(''), rng); if (rng() > 0.5) plate += random(numbers.split(''), rng); else plate += random(letters.split(''), rng); return plate; };
const generatePlusgiro = (rng) => { const len = randomInt(6, 7, rng); let base = ""; for (let i = 0; i < len; i++) base += randomInt(0, 9, rng); const control = calculateLuhn(base); const full = base + control; return `${full.slice(0, full.length - 1)}-${full.slice(full.length - 1)}`; };
const generateBankgiro = (rng) => { const base = randomInt(100000, 999999, rng).toString(); const control = calculateLuhn(base); const full = base + control; return `${full.slice(0, 3)}-${full.slice(3)}`; };
const generateOCR = (length = 15, rng) => { let base = ""; for(let i=0; i<length; i++) base += randomInt(0,9, rng); const control = calculateLuhn(base); return base + control; };
const generateIBAN = (rng) => { let bban = ""; for(let i=0; i<20; i++) bban += randomInt(0,9, rng); const tempString = bban + "281400"; const remainder = BigInt(tempString) % 97n; const checkDigits = (98n - remainder).toString().padStart(2, '0'); return `SE${checkDigits}${bban}`; };

// --- DATA LISTOR ---
const firstNames = ["Erik", "Lars", "Karl", "Anders", "Johan", "Per", "Nils", "Mikael", "Jan", "Hans", "Maria", "Anna", "Margareta", "Elisabeth", "Eva", "Birgitta", "Kristina", "Karin", "William", "Liam", "Noah", "Hugo", "Lucas", "Oliver", "Alice", "Maja", "Elsa", "Astrid", "Wilma", "Freja"];
const lastNames = ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson", "Persson", "Svensson", "Gustafsson", "Lindberg", "Lindström", "Lindqvist", "Lindgren", "Berg", "Lundberg", "Björk", "Sjöberg", "Ek", "Blom"];
const companyPrefixes = ["Nordic", "Svea", "Väst", "Stockholm", "Tech", "Bygg", "Konsult", "Media", "Data", "Din", "Svensk", "Norr", "Global", "Future", "Smart", "Green", "Blue", "Red", "Alpha", "Omega", "Prime"];
const companySuffixes = ["AB", "Consulting AB", "Gruppen AB", "Partners AB", "Teknik AB", "Invest AB", "Solutions AB", "Entreprenad AB", "Logistik AB", "Fastigheter AB"];
const banks = ["Swedbank", "Nordea", "SEB", "Handelsbanken", "Länsförsäkringar", "Danske Bank", "ICA Banken", "SBAB", "Skandia", "Avanza"];
const streets = ["Storgatan", "Drottninggatan", "Kungsgatan", "Sveavägen", "Långholmsgatan", "Vasagatan", "Linnégatan", "Odengatan", "Björkvägen", "Ringvägen", "Skolgatan", "Kyrkogatan", "Industrivägen", "Hamngatan", "Stationsgatan"];
const cityRanges = [
    { city: "Stockholm", min: 111, max: 199 }, { city: "Göteborg", min: 411, max: 418 }, { city: "Malmö", min: 211, max: 227 },
    { city: "Uppsala", min: 752, max: 757 }, { city: "Västerås", min: 722, max: 725 }, { city: "Örebro", min: 702, max: 703 },
    { city: "Linköping", min: 582, max: 589 }, { city: "Helsingborg", min: 252, max: 256 }, { city: "Jönköping", min: 553, max: 556 },
    { city: "Norrköping", min: 602, max: 603 }, { city: "Lund", min: 222, max: 227 }, { city: "Umeå", min: 903, max: 907 },
    { city: "Gävle", min: 802, max: 806 }, { city: "Borås", min: 504, max: 507 }, { city: "Eskilstuna", min: 632, max: 633 },
    { city: "Halmstad", min: 302, max: 305 }, { city: "Växjö", min: 352, max: 355 }, { city: "Karlstad", min: 652, max: 656 },
    { city: "Sundsvall", min: 852, max: 857 }, { city: "Luleå", min: 972, max: 976 }
];
const vehicleTypes = [{ type: "Personbil", models: ["Volvo V60", "Volvo XC40", "Tesla Model Y", "Volkswagen ID.4", "Kia Niro", "Polestar 2"] }, { type: "Lastbil", models: ["Scania R500", "Volvo FH16", "Mercedes-Benz Actros"] }, { type: "MC", models: ["Yamaha MT-07", "Kawasaki Ninja", "Honda CBR650R"] }, { type: "Släp", models: ["Fogelsta FS1425", "Brenderup 4260"] }];
const products = [{ name: "Trådlösa hörlurar", price: 799 }, { name: "Laptop Pro 14", price: 12499 }, { name: "Gamingmus RGB", price: 499 }, { name: "Mekaniskt Tangentbord", price: 1299 }, { name: "USB-C Kabel 2m", price: 199 }, { name: "4K Monitor 27\"", price: 3499 }, { name: "Mobilskal Läder", price: 299 }, { name: "Powerbank 20000mAh", price: 599 }];

const generateAddress = (rng) => { const area = random(cityRanges, rng); const prefix = randomInt(area.min, area.max, rng); const suffix = randomInt(10, 99, rng); return { gata: `${random(streets, rng)} ${randomInt(1, 150, rng)}`, postnummer: `${prefix} ${suffix}`, ort: area.city }; };

const createPerson = (rng, options) => { 
    let person = null;
    let attempts = 0;
    while (!person && attempts < 50) {
        attempts++;
        const fn = random(firstNames, rng); 
        const ln = random(lastNames, rng); 
        const cleanName = (str) => str.toLowerCase().replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o'); 
        const generatedAddress = generateAddress(rng);
        const candidate = { 
            id: randomInt(1, 999999, rng), 
            namn: `${fn} ${ln}`, 
            personnummer: generatePersonnummer(rng, options),
            ...generatedAddress, 
            kontakt: { mobil: generateSafeMobile(rng), email: `${cleanName(fn)}.${cleanName(ln)}@luhn.se` } 
        };
        let passesConstraints = true;
        if (options && options.city && candidate.ort.toLowerCase() !== options.city.toLowerCase()) { passesConstraints = false; }
        if (passesConstraints) { person = candidate; }
    }
    if (!person) { return createPerson(rng, { invalidRate: 0 }); }
    return person;
};

const createCompany = (rng) => { const name = `${random(companyPrefixes, rng)} ${random(companySuffixes, rng)}`; const cleanWebName = name.toLowerCase().replace(" ab", "").replace(/ /g, "").replace(/å|ä/g, 'a').replace(/ö/g, 'o'); return { id: randomInt(1, 999999, rng), foretag: name, orgnummer: generateOrgNummer(rng), momsnummer: "SE" + generateOrgNummer(rng).replace("-", "") + "01", ...generateAddress(rng), webb: `www.${cleanWebName}.se`, status: "Aktivt" }; };
const createFinance = (rng) => { return { id: randomInt(1, 999999, rng), bank: random(banks, rng), bankgiro: generateBankgiro(rng), plusgiro: generatePlusgiro(rng), iban: generateIBAN(rng), ocr: generateOCR(randomInt(10, 20, rng), rng), valuta: "SEK" }; };
const createVehicle = (rng) => { const cat = random(vehicleTypes, rng); return { id: randomInt(1, 999999, rng), regnummer: generateRegPlat(rng), typ: cat.type, status: "I trafik", modell: random(cat.models, rng) }; };
const createCard = (rng) => { const brand = random(['Visa', 'Mastercard'], rng); return { id: randomInt(1, 999999, rng), typ: "Kreditkort", brand: brand, nummer: generateCreditCard(brand, rng), cvv: randomInt(100, 999, rng).toString(), exp: `${randomInt(1, 12, rng).toString().padStart(2,'0')}/${randomInt(25, 30, rng)}`, agare: "Test Testsson" }; };
const createDevice = (rng) => { return { id: randomInt(1, 999999, rng), typ: "Mobiltelefon", imei: generateIMEI(rng), modell: random(["iPhone 15", "Samsung S24", "Pixel 8"], rng), serienummer: "SN" + randomInt(100000, 999999, rng) }; };
const createBankID = (rng) => { const status = random(["complete", "pending", "failed"], rng); return { orderRef: "ref_" + randomInt(100000, 999999, rng), status: status, completionData: status === 'complete' ? { user: createPerson(rng), device: { ipAddress: "192.168.0.1" }, cert: { notBefore: "1700000000", notAfter: "1800000000" } } : null }; };
const createCustomerJourney = (rng, options) => {
    const person = createPerson(rng, options);
    const card = createCard(rng);
    const product = random(products, rng);
    const historyCount = randomInt(1, 4, rng);
    const history = [];
    for(let i=0; i<historyCount; i++) {
        const histProd = random(products, rng);
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - randomInt(1, 365, rng));
        history.push({ datum: pastDate.toISOString().split('T')[0], produkt: histProd.name, pris: histProd.price, status: random(["Levererad", "Skickad", "Retur"], rng) });
    }
    return {
        customer: { personnummer: person.personnummer, namn: person.namn, adress: { gata: person.gata, postnummer: person.postnummer, ort: person.ort }, kontakt: { email: person.kontakt.email, telefon: person.kontakt.mobil } },
        account: { iban: generateIBAN(rng), kreditkort: card.nummer, swish: person.kontakt.mobil },
        transaction: { produkt: product.name, pris: product.price, valuta: "SEK", ocr: generateOCR(10, rng), faktura: { organisationsnummer: generateOrgNummer(rng), status: "Obetald" } },
        history: history
    };
};

// --- RESPONSE HANDLER (CAPS DATA) ---
const handleResponse = async (req, res, dataFunction, options = {}) => {
    let rng = Math.random;
    if (req.query.seed) rng = getRandomGenerator(req.query.seed);
    else if (req.params.id) rng = getRandomGenerator(req.params.id);

    if (req.query.delay) await new Promise(r => setTimeout(r, parseInt(req.query.delay)));
    if (req.query.status) { const code = parseInt(req.query.status); if (code >= 400) return res.status(code).json({ error: true, message: "Simulerat fel från Luhn.se", code: code }); }
    
    let data;
    if (req.params.id) { 
        data = dataFunction(rng, options); 
        if(data.id) data.id = parseInt(req.params.id); 
    } else { 
        const amount = parseInt(req.query.amount) || 1;
        // Här kollar vi vad planen tillåter (100 för hobby, 10000 för pro)
        const planLimit = req.userContext ? req.userContext.plan.bulk : 100;
        const limit = Math.min(amount, planLimit); 

        if (limit === 1) data = dataFunction(rng, options); 
        else { 
            data = []; 
            for(let i=0; i<limit; i++) data.push(dataFunction(rng, options)); 
        } 
    }

    const finalData = Array.isArray(data) ? data : [data];
    const timestamp = new Date().toISOString();
    finalData.forEach(item => item.generatedAt = timestamp);
    if (!Array.isArray(data) && finalData.length === 1) data = finalData[0];
    if (req.query.format === 'xml') { res.header('Content-Type', 'application/xml'); return res.send(toXML(data)); }
    res.json(data);
};

const getScenarioOptions = (req) => ({
    invalidRate: parseInt(req.query.invalidRate) || 0,
    city: req.query.city,
    minAge: parseInt(req.query.minAge) || null,
    maxAge: parseInt(req.query.maxAge) || null,
});

// Ta bort när vi går live
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'coming-soon.html')); });
// app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/docs', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'docs.html')); });
app.get('/luhn-algoritmen', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'luhn-algoritmen.html')); });
app.get('/terms', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'terms.html')); });

app.get('/api/person', async (req, res) => handleResponse(req, res, createPerson, getScenarioOptions(req)));
app.get('/api/person/:id', async (req, res) => handleResponse(req, res, createPerson, getScenarioOptions(req)));
app.get('/api/company', async (req, res) => handleResponse(req, res, createCompany));
app.get('/api/company/:id', async (req, res) => handleResponse(req, res, createCompany));
app.get('/api/finance', async (req, res) => handleResponse(req, res, createFinance));
app.get('/api/finance/:id', async (req, res) => handleResponse(req, res, createFinance));
app.get('/api/vehicle', async (req, res) => handleResponse(req, res, createVehicle));
app.get('/api/vehicle/:id', async (req, res) => handleResponse(req, res, createVehicle));
app.get('/api/creditcard', async (req, res) => handleResponse(req, res, createCard));
app.get('/api/imei', async (req, res) => handleResponse(req, res, createDevice));
app.get('/api/identity', async (req, res) => handleResponse(req, res, createCustomerJourney, getScenarioOptions(req)));
app.get('/api/identity/:id', async (req, res) => handleResponse(req, res, createCustomerJourney, getScenarioOptions(req)));
app.get('/api/bankid', async (req, res) => handleResponse(req, res, createBankID));

app.post('/api/mask', identifyUser, (req, res) => {
    const data = req.body.data || [];
    const seed = req.query.seed;
    if (!Array.isArray(data)) return res.status(400).json({ error: true, message: "Input måste vara en array i 'data'." });
    const maskedData = data.map(item => ({
        masked: maskPersonnummer(item, seed),
        isValid: isValidLuhn(maskPersonnummer(item, seed))
    }));
    res.json({ success: true, maskedData });
});

app.get('/api/validate/:input', identifyUser, async (req, res) => {
    if (req.query.delay) await new Promise(r => setTimeout(r, parseInt(req.query.delay)));
    let input = req.params.input; try { input = decodeURIComponent(input); } catch(e){}
    const cleanInput = input.trim(); const cleanNumbers = cleanInput.replace(/\D/g, '');
    let isValid = false, type = "Okänt nummer", checkDigit = "-";
    if (cleanNumbers.length === 16 && (cleanNumbers.startsWith('4') || cleanNumbers.startsWith('5'))) { type = cleanNumbers.startsWith('4') ? "Kreditkort (Visa)" : "Kreditkort (Mastercard)"; if (calculateLuhn(cleanNumbers.slice(0, -1)) == cleanNumbers.slice(-1)) { isValid = true; checkDigit = "Luhn"; } }
    else if (cleanNumbers.length === 15) { type = "IMEI (Mobil)"; if (calculateLuhn(cleanNumbers.slice(0, -1)) == cleanNumbers.slice(-1)) { isValid = true; checkDigit = "Luhn"; } }
    else if (cleanInput.toUpperCase().startsWith("SE") && cleanInput.length > 20) { type = "IBAN (Bankkonto)"; if (isValidIBAN(cleanInput)) { isValid = true; checkDigit = "Mod-97"; } }
    else if (cleanInput.toUpperCase().startsWith("SE") && cleanInput.endsWith("01")) { type = "Momsnummer (VAT)"; if (isValidMoms(cleanInput)) { isValid = true; checkDigit = "Luhn"; } }
    else if (/[a-zA-Z]/.test(cleanInput) && cleanInput.length <= 8) { type = "Registreringsskylt"; if (isValidRegnummer(cleanInput)) { isValid = true; checkDigit = "N/A"; } else { type = "Registreringsskylt (Ogiltigt format)"; } }
    else {
        if (cleanNumbers.length === 10 || cleanNumbers.length === 12) { type = parseInt((cleanNumbers.length === 12 ? cleanNumbers.slice(2) : cleanNumbers).slice(2, 4)) >= 20 ? "Organisationsnummer" : "Personnummer"; } 
        else if (cleanNumbers.length >= 2 && cleanNumbers.length <= 8) type = "Bankgiro/Plusgiro";
        else if (cleanNumbers.length > 12) type = "OCR-nummer";
        else type = "Okänt sifferformat";
        isValid = isValidLuhn(cleanInput); checkDigit = cleanNumbers.slice(-1);
    }
    res.json({ input: input, isValid: isValid, type: type, checkDigit: checkDigit });
});

app.post('/api/subscribe', async (req, res) => {
    const email = req.body.email;
    if (!db) {
        console.log("Subscription attempt failed: Database not available. Email:", email);
        // Svara positivt för att inte skapa en dålig UX om databasen är nere.
        return res.json({ success: true, message: "Mottaget (loggat lokalt)." });
    }
    try {
        // INSERT OR IGNORE förhindrar fel om e-posten redan finns.
        await db.run('INSERT OR IGNORE INTO leads (email) VALUES (?)', email);
        res.json({ success: true, message: "Sparat!" });
    } catch (error) {
        console.error("Failed to save lead to SQLite:", error.message);
        res.status(500).json({ success: false, message: "Databasfel vid sparning." });
    }
});

if (process.env.NODE_ENV !== 'production') app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
module.exports = app;