'use strict';

// Preliminary eligibility checks only. This is NOT a government registry verification,
// licence authentication, approval decision or a substitute for a legal review.
const VEHICLES = Object.freeze(['bicycle', 'moped', 'motorcycle', 'car']);
const CATEGORIES = Object.freeze(['none', 'AM', 'A1', 'A2', 'A', 'B']);
const MOTOR_VEHICLES = new Set(['moped', 'motorcycle', 'car']);
const PERIOD_MS = 90 * 24 * 60 * 60 * 1000;

function text(value, field, min, max) {
  if (typeof value !== 'string') throw new Error('Μη έγκυρο πεδίο: ' + field);
  const v = value.trim().replace(/\s+/g, ' ');
  if (v.length < min || v.length > max) throw new Error('Έλεγξε το πεδίο: ' + field);
  return v;
}
function dateOnly(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Μη έγκυρη ημερομηνία: '+field);
  const parsed = new Date(value+'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==value) throw new Error('Μη έγκυρη ημερομηνία: '+field);
  return value;
}
function validateApplication(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Μη έγκυρη αίτηση.');
  const fullName = text(body.fullName, 'Ονοματεπώνυμο', 2, 80);
  const email = text(body.email, 'Email', 5, 120).toLowerCase();
  const phone = text(body.phone, 'Τηλέφωνο', 7, 22);
  const region = text(body.region, 'Περιοχή', 2, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Συμπλήρωσε έγκυρο email.');
  if (!/^\+?[0-9 ()-]{7,22}$/.test(phone) || (phone.match(/[0-9]/g)||[]).length < 7) throw new Error('Συμπλήρωσε έγκυρο τηλέφωνο.');
  if (!VEHICLES.includes(body.vehicle)) throw new Error('Επίλεξε μέσο διανομής.');
  if (!CATEGORIES.includes(body.licenseCategory)) throw new Error('Επίλεξε κατηγορία διπλώματος.');
  for (const field of ['licenseValid', 'businessActive', 'canInvoice', 'equipmentReady', 'independentChoice']) {
    if (typeof body[field] !== 'boolean') throw new Error('Συμπλήρωσε το πεδίο: '+field);
  }
  const insuranceUntil = body.vehicle === 'bicycle' ? null : (body.insuranceUntil ? dateOnly(body.insuranceUntil, 'Ασφάλιση') : null);
  if (body.privacyAcknowledged !== true) throw new Error('Χρειάζεται επιβεβαίωση ότι διάβασες την ενημέρωση δεδομένων.');
  if (body.website || body.extraNotes) throw new Error('Μη έγκυρο περιεχόμενο αίτησης.');
  return { fullName, email, phone, region, vehicle:body.vehicle, licenseCategory:body.licenseCategory,
    licenseValid:body.licenseValid, insuranceUntil, businessActive:body.businessActive,
    canInvoice:body.canInvoice, equipmentReady:body.equipmentReady, independentChoice:body.independentChoice };
}
function evaluateApplication(app, today = new Date()) {
  const issues=[];
  const motor=MOTOR_VEHICLES.has(app.vehicle);
  const licenseMatches = app.vehicle === 'bicycle' ||
    (app.vehicle === 'moped' && ['AM','A1','A2','A'].includes(app.licenseCategory)) ||
    (app.vehicle === 'motorcycle' && ['A1','A2','A'].includes(app.licenseCategory)) ||
    (app.vehicle === 'car' && app.licenseCategory === 'B');
  if (motor && (!app.licenseValid || !licenseMatches)) issues.push('Χρειάζεται κατάλληλο και σε ισχύ δίπλωμα για το συγκεκριμένο όχημα.');
  // A1/A2 impose technical vehicle restrictions; all category claims need document review.
  if (motor && !app.insuranceUntil) issues.push('Δεν δηλώθηκε ημερομηνία λήξης ασφάλισης οχήματος.');
  if (motor && app.insuranceUntil && app.insuranceUntil < today.toISOString().slice(0,10)) issues.push('Η δηλωμένη ασφάλιση οχήματος έχει λήξει.');
  if (!app.businessActive) issues.push('Δεν δηλώθηκε ενεργή επαγγελματική δραστηριότητα.');
  if (!app.canInvoice) issues.push('Δεν δηλώθηκε δυνατότητα έκδοσης νόμιμων παραστατικών.');
  if (!app.equipmentReady) issues.push('Χρειάζεται έλεγχος κατάλληλου εξοπλισμού ασφαλούς διανομής.');
  if (!app.independentChoice) issues.push('Χρειάζεται εξέταση του κατάλληλου εργασιακού μοντέλου και της πραγματικής ανεξαρτησίας.');
  return { status: issues.length ? 'needs-information' : 'ready-for-review',
    issues, requiresHumanVerification:true,
    notice:'Τα στοιχεία είναι αυτοδηλούμενα. Δεν ελέγχθηκε δίπλωμα, ασφάλιση, φορολογική εγγραφή ή ταυτότητα σε κρατικό μητρώο.' };
}
function pruneApplications(list, now = Date.now()) {
  return (Array.isArray(list)?list:[]).filter(item=>item && Number.isFinite(Date.parse(item.createdAt)) && now-Date.parse(item.createdAt)<PERIOD_MS);
}
module.exports={ validateApplication, evaluateApplication, pruneApplications, VEHICLES, CATEGORIES };
