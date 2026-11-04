# Έλεγχος προηγούμενης δημόσιας έκδοσης

Έλεγχος του public main branch `dexter18453-cyber/fair-delivery` (4 Νοεμβρίου 2026):

1. `Rider-App.html`, `customer-app.html` και `shop-app.html` καλούσαν `fetch('https://onrender.com')` — αυτό είναι γενικό domain, όχι URL του deployment ή endpoint της εφαρμογής.
2. `Rider-App.html` και `customer-app.html` περιλάμβαναν `https://unpkg.com` χωρίς συγκεκριμένο πακέτο/έκδοση για Leaflet, άρα ο χάρτης δεν φορτώνει σωστά.
3. `server.js` επέτρεπε `Access-Control-Allow-Origin: *`, είχε μία λογική «τελευταίας παραγγελίας» και hard-coded sample coordinates, base fee, per-km fee, VAT και cash limit.
4. Τα frontends έστελναν status μόνο, όχι πλήρες, επικυρωμένο order payload.
5. Το Rider UI προσομοίωνε μετακίνηση με σταδιακή μεταβολή συντεταγμένων αντί για ρητή άδεια GPS.
6. Το Control Center εμφάνιζε μετρητές σχεδιαστικού demo και όχι δεδομένα που υπολογίζονται από πραγματική βάση.

Η νέα πιλοτική βάση αντικαθιστά αυτά τα endpoints με κοινό API και πραγματική ροή παραγγελιών. Διατηρεί τις αρχικές οικονομικές τιμές μόνο ως επεξεργάσιμες παραδοχές.
