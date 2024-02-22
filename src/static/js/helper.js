
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


// ---------------------------------------
// check token on page load
verifyAccessToken();
// ---------------------------------------

