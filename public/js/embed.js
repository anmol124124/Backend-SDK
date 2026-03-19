(function () {
  const script = document.currentScript;
  const token  = script.getAttribute('data-token');
  const room   = script.getAttribute('data-room');

  // Derive backend base URL from this script's own src
  const baseUrl = script.src.replace('/public/js/embed.js', '');
  const wsUrl   = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');

  // Find the container element placed before this script tag
  const container = document.getElementById('webrtc-meeting');
  if (!container) { console.error('[embed] No #webrtc-meeting element found.'); return; }

  function showError() {
    container.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#0f1117;';
    container.innerHTML =
      '<div style="text-align:center;padding:40px;background:#1a1d27;border:1px solid #2e3348;border-radius:12px;max-width:380px;font-family:sans-serif">' +
        '<div style="font-size:48px;margin-bottom:16px">\uD83D\uDEAB</div>' +
        '<h2 style="color:#e2e8f0;font-size:18px;margin:0 0 8px">Access Denied</h2>' +
        '<p style="color:#718096;font-size:14px;margin:0">You are not authorized to access this meeting from this domain.</p>' +
      '</div>';
  }

  fetch(baseUrl + '/api/v1/projects/embed-check?token=' + encodeURIComponent(token))
    .then(function (res) {
      if (!res.ok) { showError(); return; }
      var s = document.createElement('script');
      s.src = baseUrl + '/public/js/app.js';
      s.onload = function () {
        new WebRTCMeetingAPI({
          serverUrl:  wsUrl,
          roomName:   room,
          token:      token,
          parentNode: container,
        });
      };
      document.head.appendChild(s);
    })
    .catch(showError);
})();
