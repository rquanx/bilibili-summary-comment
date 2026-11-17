/* Runs before body parsing; the URL fragment stays entirely in the browser. */
(() => {
 const requested = new URLSearchParams(location.hash.split('&').slice(1).join('&')).get('view') === 'reader';
 if (!requested) return;
 document.documentElement.classList.add('reader-pending');
 // A failed script must leave the official error/retry interface accessible.
 addEventListener('error', event => {
  const file = event.target?.src || event.filename || '';
  if (/\/(reader|privatebin-reader-core)\.js(?:\?|$)/.test(file)) {
   document.documentElement.classList.remove('reader-pending');
  }
 }, true);
})();
