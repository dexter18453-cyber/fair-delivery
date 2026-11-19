'use strict';
const $=id=>document.getElementById(id);
let applicationOpen=false;
function showMessage(message,error=false){const node=$('response');node.hidden=false;node.className='apply-message'+(error?' error':'');node.textContent=message;node.scrollIntoView({block:'nearest',behavior:'smooth'});}
function vehicleChanged(){
  const bike=$('vehicle').value==='bicycle';
  $('insuranceField').hidden=bike;
  $('insuranceUntil').disabled=bike;
  $('licenseCategory').disabled=bike;
  $('licenseValid').disabled=bike;
  if(bike){$('licenseCategory').value='none';$('licenseValid').checked=false;}
  else{$('licenseCategory').disabled=false;$('licenseValid').disabled=false;}
}
$('vehicle').addEventListener('change',vehicleChanged);
vehicleChanged();
fetch('/api/courier-applications/config',{credentials:'same-origin'}).then(async response=>{
  if(!response.ok)throw Error('Δεν φορτώθηκαν οι ρυθμίσεις αιτήσεων.');
  const config=await response.json();
  applicationOpen=config.open===true;
  $('intakeClosed').hidden=applicationOpen;
  $('sendApplication').disabled=!applicationOpen;
}).catch(error=>{$('intakeClosed').hidden=false;$('intakeClosed').textContent=error.message;});
$('courierForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!applicationOpen)return showMessage('Η υποβολή πραγματικών στοιχείων δεν είναι ενεργή.',true);
  if(!$('courierForm').reportValidity())return;
  if(!$('privacyAcknowledged').checked)return showMessage('Διάβασε και επιβεβαίωσε την ενημέρωση.',true);
  const vehicle=$('vehicle').value,bike=vehicle==='bicycle';
  const body={
    fullName:$('fullName').value,email:$('email').value,phone:$('phone').value,
    region:$('region').value,vehicle,licenseCategory:bike?'none':$('licenseCategory').value,
    licenseValid:bike?false:$('licenseValid').checked,
    insuranceUntil:bike?null:($('insuranceUntil').value||null),
    businessActive:$('businessActive').checked,canInvoice:$('canInvoice').checked,
    equipmentReady:$('equipmentReady').checked,independentChoice:$('independentChoice').checked,
    privacyAcknowledged:$('privacyAcknowledged').checked
  };
  const button=$('sendApplication');button.disabled=true;button.textContent='Αποστολή…';
  try{
    const response=await fetch('/api/courier-applications',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.error||'Η υποβολή απέτυχε.');
    const issues=data.screening?.issues||[];
    showMessage('Η αίτηση καταχωρίστηκε για ανθρώπινο έλεγχο.\n'+
      (issues.length?'Εκκρεμότητες που εντόπισε ο προκαταρκτικός έλεγχος:\n• '+issues.join('\n• '):
      'Ο προέλεγχος δεν εντόπισε ελλείψεις στη δήλωσή σου. Ακολουθεί έλεγχος δικαιολογητικών από άνθρωπο.')+
      '\nΔεν αποτελεί έγκριση συνεργασίας.');
    $('courierForm').reset();vehicleChanged();
  }catch(error){showMessage(error.message,true);}
  finally{button.disabled=!applicationOpen;button.textContent='Αποστολή αίτησης';}
});