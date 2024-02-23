
async function verifyAccessToken() {
   const accessToken = localStorage.getItem('accessToken');
   if (!accessToken) {
      window.location.href = '/login';
   }
   const response = await fetch('/api/auth/token/verify', {
      method: 'POST',
      headers: {
         'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: accessToken })
   });

   if (!response.ok) {
      window.location.href = '/login';
   }
}

function uniqueID() {
   return Math.random().toString(36).substr(2, 16);
}

function createToastAlert(msg, isFailure) {
   const toastId = uniqueID();
   const toastColorClass = isFailure ? 'bg-danger' : 'bg-primary';
   const toastHtml = `
       <div id="${toastId}" class="toast align-items-center text-white ${toastColorClass} border-0" role="alert" aria-live="assertive" aria-atomic="true">
           <div class="d-flex">
               <div class="toast-body">${msg}</div>
               <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
           </div>
       </div>
   `;

   const toastContainer = document.getElementById('toastContainer');
   toastContainer.insertAdjacentHTML('beforeend', toastHtml);

   const toastElement = $(`#${toastId}`);
   toastElement.toast('show');

   toastElement.on('hidden.bs.toast', function () {
      toastElement.remove();
   });

   setTimeout(() => {
      toastElement.toast('hide');
   }, 2000);
}

function isValidSSHKey(key) {
   const validKeyPrefixes = [
       "ssh-rsa", 
       "ssh-dss", 
       "ecdsa-sha2-nistp256", 
       "ecdsa-sha2-nistp384", 
       "ecdsa-sha2-nistp521", 
       "ssh-ed25519"
   ];
 
   // Check if the key starts with any of the valid prefixes
   const isValidKeyPrefix = validKeyPrefixes.some(prefix => key.startsWith(prefix));
   if (!isValidKeyPrefix) {
       return false;
   }
 
   // Basic pattern to check for base64 part of the key (simplified and may not cover all edge cases)
   // This regex checks for the base64 string and optionally a comment part.
   const base64Pattern = /^[A-Za-z0-9+\/]+={0,3}( [^\s]+)?$/;
   const keyParts = key.split(' ');
   // Expecting at least two parts: type and key, optionally followed by a comment
   if (keyParts.length < 2 || !base64Pattern.test(keyParts[1])) {
       return false;
   }
 
   return true;
 }

 
// ---------------------------------------
// check token on page load
verifyAccessToken();
// ---------------------------------------

