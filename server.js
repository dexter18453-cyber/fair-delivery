
const http = require('http');
const fs = require('fs');
const path = require('path');
const Datastore = require('@seald-io/nedb');

const PORT = 3000;
const CASH_LIMIT = 250.00;
const VAT_RATE = 0.24;

const db = new Datastore({ filename: './delivery_nedb.db', autoplay: true });

db.count({}, (err, count) => {
    if (count === 0) {
        db.insert({ id: 1042, status: 'New Order', lat: 37.962, lng: 23.640, distance_km: 1.5, is_bad_weather: 0, cash_collected: 0, rider_net_locked: 0, rider_vat_locked: 0, rider_total_locked: 0 });
    }
});

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    if (req.url === '/api/order' && req.method === 'GET') {
        db.find({}).sort({ id: -1 }).limit(1).exec((err, docs) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(docs[0] || { id: 1042, status: "New Order", cash_collected: 0, rider_total_locked: 0 }));
        });
        return;
    }

    if (req.url === '/api/order' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                db.find({}).sort({ id: -1 }).limit(1).exec((err, docs) => {
                    let row = docs[0] || {};
                    let currentStatus = data.status || row.status;
                    let currentLat = data.lat || row.lat;
                    let currentLng = data.lng || row.lng;
                    let cash = row.cash_collected || 0;
                    let netLocked = row.rider_net_locked || 0;
                    let vatLocked = row.rider_vat_locked || 0;
                    let totalLocked = row.rider_total_locked || 0;
                    let orderId = row.id || 1042;

                    if (data.status === 'Παραδόθηκε' && row.status !== 'Παραδόθηκε') {
                        let dist = row.distance_km || 1.5;
                        let weather = row.is_bad_weather || 0;
                        
                        let calculatedFee = 2.50 + (dist * 0.80);
                        if (weather === 1) calculatedFee += 1.50;

                        if (cash >= CASH_LIMIT) {
                            cash -= 12.50;
                        } else {
                            cash += (12.50 + calculatedFee);
                        }

                        let net = calculatedFee / (1 + VAT_RATE);
                        let vat = calculatedFee - net;

                        netLocked += net;
                        vatLocked += vat;
                        totalLocked += calculatedFee;
                    }

                    if (data.status === 'Νέα Παραγγελία' && row && row.status === 'Παραδόθηκε') {
                        let newId = orderId + 1;
                        db.insert({ id: newId, status: 'Νέα Παραγγελία', lat: 37.962, lng: 23.640, distance_km: 1.5, is_bad_weather: 0, cash_collected: cash, rider_net_locked: netLocked, rider_vat_locked: vatLocked, rider_total_locked: totalLocked }, () => {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true, id: newId }));
                        });
                    } else {
                        db.update({ _id: row._id }, { $set: { status: currentStatus, lat: currentLat, lng: currentLng, cash_collected: cash, rider_net_locked: netLocked, rider_vat_locked: vatLocked, rider_total_locked: totalLocked } }, {}, () => {
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
    console.log('Server is running...');
});
