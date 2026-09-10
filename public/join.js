document.querySelector('#copy').addEventListener('click', async () => {
  const notice = document.querySelector('#notice');
  if (!location.hash) { notice.textContent = 'This URL is missing its invite secret. Ask the creator for the full invitation.'; return; }
  try { await navigator.clipboard.writeText(location.href); notice.textContent = 'Invitation copied.'; }
  catch { notice.textContent = 'Copy the complete URL from your address bar.'; }
});
