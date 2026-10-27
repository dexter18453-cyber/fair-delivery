const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const PORT = 3000;
const CASH_LIMIT = 250.00;
const VAT_RATE = 0.24; // 24% ΦΠΑ

// ΔΙΚΑΙΕΣ ΤΙΜΕΣ (ΒΑΣΕΙ ΝΟΜΟΥ & ΣΥΝΤΗΡΗΣΗΣ)
const BASE_FARE = 2.50;      // Ελάχιστη αμοιβή εκκίνησης για κοντινά
const PER_KM_RATE = 0.80;    // Χρέωση ανά χιλιόμετρο απόστασης
const WEATHER_BONUS = 1.50;  // Bonus κακοκαιρίας (αν ισχύει)

const db = new sqlite3.Database('./delivery.db', (err) => {
    if (err) console.error(err.message);
});

db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT,
    lat REAL,
    lng REAL,
    distance_km REAL DEFAULT 1.5,
    is_bad_weather INTEGER DEFAULT 0,
    cash_collected REAL DEFAULT 0,
    rider_net_locked REAL DEFAULT 0,
    rider_vat_locked REAL DEFAULT 0,
    rider_total_locked REAL DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    if (req.url === '/api/order' && req.method === 'GET') {
        db.get("SELECT * FROM orders ORDER BY id DESC LIMIT 1", (err, row) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(row || { id: 1042, status: "New Order", cash_collected: 0, rider_total_locked: 0 }));
        });
        return;
    }

    if (req.url === '/api/order' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                db.get("SELECT * FROM orders ORDER BY id DESC LIMIT 1", (err, row) => {
                    let currentStatus = data.status || row.status;
                    let currentLat = data.lat || row.lat;
                    let currentLng = data.lng || row.lng;
                    let cash = row ? row.cash_collected : 0;
                    let netLocked = row ? row.rider_net_locked : 0;
                    let vatLocked = row ? row.rider_vat_locked : 0;
                    let totalLocked = row ? row.rider_total_locked : 0;
                    let orderId = row ? row.id : 1042;

                    if (data.status === 'Παραδόθηκε' && row.status !== 'Παραδόθηκε') {
                        let dist = row ? row.distance_km : 1.5;
                        let weather = row ? row.is_bad_weather : 0;
                        
                        // ΑΛΓΟΡΙΘΜΟΣ ΔΙΚΑΙΗΣ ΧΙΛΙΟΜΕΤΡΙΚΗΣ ΑΜΟΙΒΗΣ
                        let calculatedFee = BASE_FARE + (dist * PER_KM_RATE);
                        if (weather === 1) calculatedFee += WEATHER_BONUS;

                        if (cash >= CASH_LIMIT) {
                            cash -= 12.50; // Κλασματικός συμψηφισμός στο ταμείο μετρητών
                        } else {
                            cash += (12.50 + calculatedFee); // Είσπραξη μετρητών (Φαγητό + Δίκαια Μεταφορικά)
                        }

                        // ΔΙΑΧΩΡΙΣΜΟΣ ΦΠΑ 24% ΓΙΑ ΤΟ 15ΗΜΕΡΟ
                        let net = calculatedFee / (1 + VAT_RATE);
                        let vat = calculatedFee - net;

                        netLocked += net;
                        vatLocked += vat;
                        totalLocked += calculatedFee; // Όλο το ποσό κλειδώνει για την πληρωμή του 15ημέρου
                    }

                    if (data.status === 'Νέα Παραγγελία' && row && row.status === 'Παραδόθηκε') {
                        db.run("INSERT INTO orders (status, lat, lng, cash_collected, rider_net_locked, rider_vat_locked, rider_total_locked) VALUES (?, ?, ?, ?, ?, ?, ?)", 
                            ['Νέα Παραγγελία', 37.962, 23.640, cash, netLocked, vatLocked, totalLocked], function(err) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: true, id: this.lastID }));
                        });
                    } else {
                        db.run("UPDATE orders SET status = ?, lat = ?, lng = ?, cash_collected = ?, rider_net_locked = ?, rider_vat_locked = ?, rider_total_locked = ? WHERE id = ?", 
                            [currentStatus, currentLat, currentLng, cash, netLocked, vatLocked, totalLocked, orderId], (err) => {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: true }));
                        });
                    }
                });
            } catch (e) { res.writeHead(400); res.end(); }
        });
        return;
    }

    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, content) => {
        if (err) { res.writeHead(404); res.end("Not Found"); } 
        else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); }
    });
});

server.listen(PORT, () => {
    console.log('=========================================');
    console.log('🚀 SERVER RUNNING: FAIR KM FARES & 15-DAY PAYOUTS ACTIVE');
    console.log('=========================================');
});
