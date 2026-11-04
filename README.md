# Fair Delivery 1.1.0 — διορθωμένη πιλοτική βάση

Αυτή η έκδοση αντικαθιστά το προβληματικό demo flow με μία κοινή, πρωτότυπη εφαρμογή Node.js για τοπική πιλοτική δοκιμή. Δεν αντιγράφει κώδικα, APK, ιδιωτικά endpoints ή μηχανισμούς της efood.

## Τι διορθώθηκε

- Ένα ενιαίο backend με πραγματικά endpoints `/api/...` αντί για τις λανθασμένες κλήσεις `https://onrender.com`.
- Κοινή ροή παραγγελίας: πελάτης → κατάστημα → διανομέας → παράδοση.
- Ξεχωριστές οθόνες πελάτη, καταστήματος, διανομέα και Control Center.
- Επιβεβαίωση κατάστασης με έλεγχο επιτρεπτών μεταβάσεων.
- Δημιουργία παραγγελίας με τιμές προϊόντων που ελέγχονται στον server, όχι με τιμές που στέλνει ο browser.
- Τοπική αποθήκευση σε JSON με σειριοποιημένες εγγραφές και atomic rename.
- Σύνδεση shop/rider/admin με κωδικούς ρόλων και HttpOnly session cookie.
- Περιορισμός συχνότητας στις δημόσιες δοκιμαστικές παραγγελίες και στον AI βοηθό.
- Προαιρετικός AI βοηθός μέσω OpenAI Responses API. Το API key παραμένει αποκλειστικά στον server.
- Πραγματικά στατιστικά από τη βάση· δεν χρησιμοποιούνται ψεύτικοι μετρητές.
- Ρητή άδεια browser πριν από κοινοποίηση GPS από τον διανομέα.

## Γρήγορη τοπική εκκίνηση σε Linux Mint

Απαιτείται Node.js 20 ή νεότερο. Το project δεν έχει εξωτερικές npm εξαρτήσεις.

```bash
cp .env.example .env
npm test
npm start
```

Άνοιξε:

- Control Center: http://localhost:3000/
- Πελάτης: http://localhost:3000/customer-app.html
- Κατάστημα: http://localhost:3000/shop-app.html
- Διανομέας: http://localhost:3000/Rider-App.html

Στην τοπική λειτουργία `DEMO_MODE=true`, ο κωδικός δοκιμής για shop, rider και admin είναι `demo`.

Τα προϊόντα που εμφανίζονται αρχικά είναι σαφώς δοκιμαστικά. Άλλαξε τα στο `server.js` / `DEFAULT_PRODUCTS` πριν από οποιαδήποτε παρουσίαση σε πραγματικούς πελάτες.

## AI βοηθός

Ο AI βοηθός εμφανίζεται στο Control Center και λειτουργεί μόνο όταν έχουν οριστεί στον server:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (ένα model ID διαθέσιμο στο συγκεκριμένο API project)

Μην τοποθετήσεις ποτέ το API key σε HTML, JavaScript του browser, APK, Git ή δημόσιο αρχείο. Το API χρεώνεται ξεχωριστά από τη συνδρομή ChatGPT. Ρύθμισε budget/alerts στην πλατφόρμα API πριν το ενεργοποιήσεις.

## Render — προτεινόμενη ρύθμιση πιλοτικού

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- `HOST=0.0.0.0`
- `DEMO_MODE=false`
- `DATA_DIR=/var/data` (μόνο αν έχεις προσθέσει Render Persistent Disk με mount path `/var/data`)
- Πρόσθεσε `SHOP_ACCESS_CODE`, `RIDER_ACCESS_CODE`και `ADMIN_ACCESS_CODE` ως Environment Variables με μεγάλους, διαφορετικούς μυστικούς κωδικούς.
- Πρόσθεσε `OPENAI_API_KEY` και `OPENAI_MODEL` μόνο αν ενεργοποιήσεις τον AI βοηθό.

**Μη χρησιμοποιήσεις `DEMO_MODE=true` σε δημόσια υπηρεσία.** Το `.env` δεν πρέπει να ανέβει στο GitHub. Αν έχει εκτεθεί οποιοδήποτε κλειδί, κάνε ανάκληση/περιστροφή του.

## API

- `GET /api/health` — έλεγχος server
- `GET /api/config` — δημόσιες επιχειρηματικές ρυθμίσεις
- `GET /api/products` — ενεργά προϊόντα
- `POST /api/orders` — δημιουργία δοκιμαστικής παραγγελίας
- `GET /api/orders` — λίστα παραγγελιών για shop/rider/admin
- `GET /api/orders/:id` — δημόσιο tracking με τυχαίο UUID
- `PATCH /api/orders/:id` — ελεγχόμενη αλλαγή κατάστασης ανά ρόλο
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/stats` — admin στατιστικά
- `PATCH /api/settings` — admin ρυθμίσεις
- `POST /api/rider/status`, `POST /api/rider/location`
- `POST /api/assistant` — admin AI assistant

## Τι ΔΕΝ είναι ακόμη έτοιμο για εμπορική παραγωγή

Αυτή είναι λειτουργική τεχνική βάση πιλοτικού, όχι ολοκληρωμένη εμπορική πλατφόρμα. Δεν περιλαμβάνει ακόμη:

- Πραγματικούς λογαριασμούς χρηστών, επαλήθευση email/τηλεφώνου, ανάκτηση κωδικού ή 2FA.
- Πολλαπλά καταστήματα με απομόνωση δεδομένων ανά κατάστημα και διαχείριση καταλόγων από UI.
- Πληρωμές, επιστροφές, τιμολόγηση, φορολογική/λογιστική ροή ή διασύνδεση PSP.
- Επίσημη/εξουσιοδοτημένη διασύνδεση με τρίτες πλατφόρμες.
- Πλήρη live route navigation, push notifications ή αξιόπιστο GPS στο παρασκήνιο.
- PostgreSQL ή άλλη managed βάση για πολλούς servers/instances. Το JSON store είναι μόνο για single-instance pilot και χρειάζεται persistent disk στο Render.
- Νομικό έλεγχο, GDPR διαδικασίες, όρους χρήσης, πολιτική απορρήτου, συμφωνίες καταστημάτων/διανομέων ή production security review.

Οι τιμές `0,20€`, `0%`, `2,50€ + 0,80€/km` και `1,50€` είναι αρχικές παραδοχές του concept και επεξεργάσιμες ρυθμίσεις, όχι επιβεβαιωμένοι κανόνες πληρωμής ή φορολογίας.

## Smoke test

Το `npm test` ξεκινά προσωρινό server σε τυχαία τοπική θύρα και ελέγχει health, static pages, login, δημιουργία παραγγελίας, ροή καταστήματος, ροή διανομέα, εκτιμώμενη αμοιβή, admin stats και αποθήκευση. Δεν ελέγχει πραγματικό deployment, πληρωμές ή εξωτερικό AI API.
