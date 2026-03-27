  // ═══════════════════════════════════════════════════════════════════════════
// WebRTCMeetingAPI — embeddable WebRTC meeting SDK
// ═══════════════════════════════════════════════════════════════════════════
(function () {
if (window.WebRTCMeetingAPI) return; // already loaded — skip re-declaration
class WebRTCMeetingAPI {

  constructor({ serverUrl, roomName, token = "", hostToken = "", guestToken = "", shareUrl = "", embedToken = "", reconnect = false, parentNode, onLeave = null }) {
    // Derive backend URL from this script's own <script src> tag.
    // This makes the embed HTML portable — no hardcoded URLs needed.
    const scriptEl = Array.from(document.querySelectorAll('script[src]'))
      .find(s => s.src && s.src.includes('/public/js/app.js'));
    const scriptOrigin = scriptEl ? new URL(scriptEl.src).origin : null;

    // Priority: script tag origin → serverUrl param → page origin
    if (scriptOrigin) {
      this._httpBase = scriptOrigin;
    } else if (serverUrl) {
      this._httpBase = serverUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    } else {
      this._httpBase = window.location.origin;
    }
    this.serverUrl = this._httpBase.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

    this.roomName    = roomName;
    this.token       = token;
    this._hostToken  = hostToken;
    this._guestToken = guestToken;
    this._shareUrl   = shareUrl;
    this._embedToken = embedToken;
    this.parentNode  = parentNode;
    this._onLeave    = onLeave;

    // WebRTC state
    this._ws                = null;
    this._localStream       = null;
    this._peerConnections   = {};
    this._pendingCandidates = {};

    // Media toggles
    this._micEnabled  = true;
    this._camEnabled  = true;
    this._isSharing   = false;
    this._shareStream = null;

    // Recording
    this._isRecording   = false;
    this._mediaRecorder = null;
    this._recordChunks  = [];

    // Chat
    this._chatOpen    = false;
    this._unread      = 0;

    // Raise hand
    this._handRaised  = false;
    this._raisedHands = new Set();

    // Host tracking
    this._myUserId  = null;
    this._isHost    = false;

    // Active speaker
    this._audioCtx      = null;
    this._analysers     = {};   // userId → AnalyserNode
    this._speakerTimer  = null;
    this._currentSpeaker = null;

    // Names & participants
    this._myName        = "";
    this._peerNames     = {};   // userId → display name
    this._participants  = {};   // userId → name (everyone in room)
    this._panelTab      = null; // "people" | "chat" | null

    // Misc
    this._isLeaving     = false;
    this._uiBuilt       = false;
    this._isReconnecting = reconnect;
    this._meetingStart   = null;
    this._settings       = {}; // meeting permissions from server

    // Host-mute tracking (participants)
    this._hostMutedMic  = false; // true = host muted my mic
    this._hostMutedCam  = false; // true = host muted my cam
    // Host bulk-action state (host side)
    this._allMicsMuted  = false;
    this._allCamsMuted  = false;
    this._clockTimer  = null;
    this._toastTimer  = null;

    this._iceConfig = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        {
          urls: [
            "turn:openrelay.metered.ca:80",
            "turn:openrelay.metered.ca:443",
            "turns:openrelay.metered.ca:443",
          ],
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ],
    };

    this._init();
  }

  _init() {
    // Embed pre-screen mode — embedToken provided, no room yet
    if (this._embedToken) {
      this._showEmbedPrescreen();
      return;
    }

    // If both hostToken and guestToken are provided → show role selection first
    if (this._hostToken && this._guestToken) {
      this._showRoleSelection();
      return;
    }

    const savedName = sessionStorage.getItem('wrtc_name_' + this.roomName);

    // Public meeting tokens (RS256) don't belong to any project — skip embed-check
    try {
      const payload = JSON.parse(atob(this.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.type === 'public_host' || payload.type === 'public_guest') {
        if (savedName) { this._showReconnecting(savedName); } else { this._buildLobby(); }
        return;
      }
    } catch (_) { /* not a parseable JWT — fall through to embed-check */ }

    fetch(this._httpBase + '/api/v1/projects/embed-check?token=' + encodeURIComponent(this.token))
      .then(res => {
        console.log('[WRTC] embed-check status:', res.status, res.ok);
        if (!res.ok) { this._showAccessDenied(); return; }
        if (savedName) { this._showReconnecting(savedName); } else { this._buildLobby(); }
      })
      .catch((err) => { console.error('[WRTC] embed-check FAILED (catch):', err); this._showAccessDenied(); });
  }

  _showEmbedPrescreen() {
    const SESSION_KEY = 'wrtc_active_meeting_' + this._embedToken.slice(-8);

    // Override _onLeave before any early returns so all leave paths (normal, end-meeting,
    // transfer+leave, refresh+leave) always clear the session key and return to prescreen.
    const externalOnLeave = this._onLeave;
    this._onLeave = () => {
      sessionStorage.removeItem(SESSION_KEY);
      if (typeof externalOnLeave === 'function') externalOnLeave();
      else window.location.reload();
    };

    // Show a loading screen while the domain whitelist check runs asynchronously.
    this.parentNode.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#202124;';
    this.parentNode.innerHTML = '<div style="width:32px;height:32px;border:3px solid rgba(255,255,255,.1);border-top-color:#1a73e8;border-radius:50%;animation:wrtc-spin .8s linear infinite"></div><style>@keyframes wrtc-spin{to{transform:rotate(360deg)}}</style>';

    // Domain whitelist check — verify the embed token is allowed on this origin before
    // rendering anything. The browser automatically sends the correct Origin header.
    const _self = this;
    fetch(this._httpBase + '/api/v1/projects/embed-check?token=' + encodeURIComponent(this._embedToken))
      .then(res => { if (!res.ok) { _self._showAccessDenied(); } else { _self._renderEmbedPrescreen(SESSION_KEY); } })
      .catch(() => _self._showAccessDenied());
  }

  _renderEmbedPrescreen(SESSION_KEY) {
    const self = this;
    this.parentNode.style.cssText = 'position:fixed;inset:0';
    this.parentNode.innerHTML = `<style>
      .ep*{box-sizing:border-box;margin:0;padding:0}
      .ep{position:fixed;inset:0;background:#1a1c22;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e8eaed;display:flex;flex-direction:column;align-items:center;padding:40px 16px;overflow-y:auto}
      .ep-hdr{text-align:center;margin-bottom:32px}.ep-hdr h2{font-size:26px;font-weight:700}.ep-hdr p{color:#9aa0a6;font-size:14px;margin-top:6px}
      .ep-card{background:#25262b;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;width:100%;max-width:560px;margin-bottom:16px}
      .ep-card h3{font-size:12px;font-weight:600;color:#9aa0a6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:16px}
      .ep-input{background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;color:#e8eaed;font-size:15px;width:100%;outline:none}
      .ep-input:focus{border-color:#1a73e8}.ep-input::placeholder{color:#5f6368}
      .ep-btn{background:linear-gradient(90deg,#1a73e8,#4d94ff);color:#fff;border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:600;cursor:pointer;width:100%;margin-top:12px;transition:opacity .15s}
      .ep-btn:disabled{opacity:.5;cursor:not-allowed}
      .ep-err{color:#ea4335;font-size:13px;margin-top:8px;display:none}
      .ep-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)}
      .ep-row:last-child{border-bottom:none}
      .ep-row-title{font-size:15px;font-weight:500}.ep-row-date{font-size:12px;color:#9aa0a6;margin-top:2px}
      .ep-join{background:#1a73e8;color:#fff;border:none;border-radius:8px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
      .ep-empty{color:#9aa0a6;font-size:14px;text-align:center;padding:8px 0}
      .ep-spin{width:28px;height:28px;border:3px solid rgba(255,255,255,.1);border-top-color:#1a73e8;border-radius:50%;animation:ep-s .8s linear infinite;margin:8px auto}
      @keyframes ep-s{to{transform:rotate(360deg)}}
    </style>
    <div class="ep">
      <div class="ep-hdr"><h2 id="ep-title">Meeting Room</h2><p>Create a new meeting or join a previous one</p></div>
      <div class="ep-card"><h3>New Meeting</h3>
        <input id="ep-inp" class="ep-input" type="text" placeholder="Enter meeting title…" maxlength="255"/>
        <div id="ep-err" class="ep-err"></div>
        <button id="ep-create" class="ep-btn">Create &amp; Start</button>
      </div>
      <div class="ep-card"><h3>Previous Meetings</h3><div id="ep-list"><div class="ep-spin"></div></div></div>
    </div>`;

    function startMeeting(roomName, hostToken, shareUrl) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({roomName, hostToken, shareUrl}));
      self.parentNode.innerHTML = '';
      self.parentNode.style.cssText = 'position:fixed;inset:0';
      self.roomName    = roomName;
      self.token       = hostToken;
      self._shareUrl   = shareUrl;
      self._embedToken = '';  // prevent _init() from looping back to prescreen
      // If the admin was already in this meeting (name saved), skip lobby and reconnect directly
      const savedName = sessionStorage.getItem('wrtc_name_' + roomName);
      if (savedName) {
        self._showReconnecting(savedName);
      } else {
        self._buildLobby();
      }
    }

    // Auto-rejoin on refresh
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      try { const s = JSON.parse(saved); startMeeting(s.roomName, s.hostToken, s.shareUrl); return; }
      catch(_) { sessionStorage.removeItem(SESSION_KEY); }
    }

    // Load past meetings
    fetch(this._httpBase + '/api/v1/projects/my-meetings?embed_token=' + encodeURIComponent(this._embedToken))
      .then(r => r.json())
      .then(list => {
        const el = document.getElementById('ep-list');
        if (!list || !list.length) { el.innerHTML = '<p class="ep-empty">No meetings yet.</p>'; return; }
        el.innerHTML = list.map(m => `<div class="ep-row">
          <div><div class="ep-row-title">${m.title}</div>
          <div class="ep-row-date">${new Date(m.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div></div>
          <button class="ep-join" data-room="${m.room_name}" data-token="${m.host_token}" data-share="${m.share_url}">Join</button>
        </div>`).join('');
        el.querySelectorAll('.ep-join').forEach(btn => {
          btn.addEventListener('click', function() { startMeeting(this.dataset.room, this.dataset.token, this.dataset.share); });
        });
      })
      .catch(() => { const el = document.getElementById('ep-list'); if(el) el.innerHTML = '<p class="ep-empty">Could not load meetings.</p>'; });

    // Create new meeting
    const createBtn = document.getElementById('ep-create');
    const inp = document.getElementById('ep-inp');
    const errEl = document.getElementById('ep-err');
    createBtn.onclick = () => {
      const title = inp.value.trim();
      if (!title) { inp.focus(); return; }
      createBtn.disabled = true; createBtn.textContent = 'Creating…'; errEl.style.display = 'none';
      fetch(this._httpBase + '/api/v1/projects/create-meeting', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({embed_token: this._embedToken, title})
      })
      .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.detail||'Failed'); }))
      .then(data => startMeeting(data.room_name, data.host_token, data.share_url))
      .catch(e => { errEl.textContent = e.message; errEl.style.display = 'block'; createBtn.disabled = false; createBtn.textContent = 'Create & Start'; });
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });

  }

  _showRoleSelection() {
    this.parentNode.innerHTML = `
      <style>
        .wrtc-rs*{box-sizing:border-box;margin:0;padding:0}
        .wrtc-rs{
          position:fixed;inset:0;
          background:linear-gradient(160deg,#1a1c22 0%,#202124 100%);
          display:flex;flex-direction:column;align-items:center;justify-content:center;
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:32px;
        }
        .wrtc-rs-title{font-size:22px;font-weight:700;color:#e8eaed;text-align:center}
        .wrtc-rs-sub{font-size:14px;color:#9aa0a6;text-align:center;margin-top:8px}
        .wrtc-rs-cards{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
        .wrtc-rs-card{
          background:#25262b;border:1px solid rgba(255,255,255,.08);
          border-radius:16px;padding:28px 32px;
          display:flex;flex-direction:column;align-items:center;gap:12px;
          cursor:pointer;transition:all .2s;width:200px;color:#e8eaed;
        }
        .wrtc-rs-card:hover{transform:translateY(-4px);border-color:rgba(26,115,232,.5);box-shadow:0 12px 32px rgba(0,0,0,.4)}
        .wrtc-rs-host{border-color:rgba(26,115,232,.35);background:linear-gradient(160deg,#1c2e4a,#1a2438)}
        .wrtc-rs-icon{font-size:32px}
        .wrtc-rs-name{font-size:16px;font-weight:600}
        .wrtc-rs-desc{font-size:12px;color:#9aa0a6;text-align:center;line-height:1.5}
      </style>
      <div class="wrtc-rs">
        <div>
          <div class="wrtc-rs-title">${this.roomName}</div>
          <div class="wrtc-rs-sub">How would you like to join?</div>
        </div>
        <div class="wrtc-rs-cards">
          <div class="wrtc-rs-card wrtc-rs-host" id="wrtc-pick-host">
            <div class="wrtc-rs-icon">🎙️</div>
            <div class="wrtc-rs-name">Create Meeting</div>
            <div class="wrtc-rs-desc">Start as host and admit participants</div>
          </div>
          <div class="wrtc-rs-card" id="wrtc-pick-guest">
            <div class="wrtc-rs-icon">👋</div>
            <div class="wrtc-rs-name">Join Meeting</div>
            <div class="wrtc-rs-desc">Join as participant, wait for host approval</div>
          </div>
        </div>
      </div>`;

    document.getElementById('wrtc-pick-host').addEventListener('click', () => {
      this.token = this._hostToken;
      this._proceedToLobby();
    });
    document.getElementById('wrtc-pick-guest').addEventListener('click', () => {
      this.token = this._guestToken;
      this._proceedToLobby();
    });
  }

  _proceedToLobby() {
    const savedName = sessionStorage.getItem('wrtc_name_' + this.roomName);
    fetch(this._httpBase + '/api/v1/projects/embed-check?token=' + encodeURIComponent(this.token))
      .then(res => {
        if (!res.ok) { this._showAccessDenied(); return; }
        if (savedName) { this._showReconnecting(savedName); } else { this._buildLobby(); }
      })
      .catch(() => this._showAccessDenied());
  }

  _showReconnecting(name) {
    this._myName         = name;
    this._isReconnecting = true;   // tells WS to pass reconnect=1 → backend skips knock
    this.parentNode.innerHTML =
      '<style>@keyframes wrtc-spin{to{transform:rotate(360deg)}}</style>' +
      '<div style="position:fixed;inset:0;background:#202124;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:16px;font-family:sans-serif;">' +
      '<div style="width:48px;height:48px;border:4px solid rgba(255,255,255,.1);' +
      'border-top:4px solid #1a73e8;border-radius:50%;animation:wrtc-spin 1s linear infinite;"></div>' +
      '<p style="color:#e8eaed;font-size:16px;font-weight:500;margin:0;">Reconnecting…</p>' +
      '<p style="color:rgba(255,255,255,.45);font-size:13px;margin:0;">Please wait</p>' +
      '</div>';
    // Get camera, then connect — do NOT call _joinMeeting (it would overwrite this screen)
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        this._localStream = stream;
        this._setupAudioAnalyser("local", stream);
        // Restore cam/mic state from before the refresh
        const savedMic = sessionStorage.getItem('wrtc_mic_' + this.roomName);
        const savedCam = sessionStorage.getItem('wrtc_cam_' + this.roomName);
        if (savedMic === '0') {
          this._micEnabled = false;
          stream.getAudioTracks().forEach(t => { t.enabled = false; });
        }
        if (savedCam === '0') {
          this._camEnabled = false;
          stream.getVideoTracks().forEach(t => { t.enabled = false; });
        }
      })
      .catch(() => {})
      .finally(() => {
        sessionStorage.setItem('wrtc_name_' + this.roomName, name);
        this._setupWebSocket();
      });
  }

  _showAccessDenied() {
    this.parentNode.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#202124;z-index:99999;';
    this.parentNode.innerHTML =
      '<div style="text-align:center;padding:40px;background:#2d2e31;border:1px solid #3c3f45;border-radius:16px;max-width:380px;font-family:sans-serif">' +
        '<div style="font-size:48px;margin-bottom:16px">\uD83D\uDEAB</div>' +
        '<h2 style="color:#e8eaed;font-size:18px;margin:0 0 8px;font-weight:500">Access Denied</h2>' +
        '<p style="color:#9aa0a6;font-size:14px;margin:0">You are not authorized to access this meeting from this domain.</p>' +
      '</div>';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOBBY (pre-join screen)
  // ═══════════════════════════════════════════════════════════════════════
  _buildLobby() {
    this.parentNode.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600&display=swap');
      .wrtc-lobby*{box-sizing:border-box;margin:0;padding:0}
      .wrtc-lobby{
        font-family:'Google Sans',Roboto,-apple-system,sans-serif;
        background:#202124;color:#e8eaed;
        height:100%;display:flex;align-items:center;justify-content:center;
        padding:24px;
      }
      .wrtc-lobby-card{
        display:flex;gap:0;border-radius:16px;overflow:hidden;
        background:#2d2e31;
        box-shadow:0 8px 40px rgba(0,0,0,.5);
        max-width:860px;width:100%;
      }
      /* LEFT — preview */
      .wrtc-lobby-left{
        flex:1;min-height:360px;position:relative;background:#000;
      }
      .wrtc-lobby-preview{
        width:100%;height:100%;object-fit:cover;display:block;
        transform:scaleX(-1);
      }
      .wrtc-lobby-cam-off{
        position:absolute;inset:0;
        display:none;align-items:center;justify-content:center;
        flex-direction:column;gap:12px;background:#3c4043;
        color:rgba(255,255,255,.5);font-size:14px;
      }
      .wrtc-lobby-cam-off svg{opacity:.4}
      .wrtc-lobby-preview-btns{
        position:absolute;bottom:16px;left:50%;transform:translateX(-50%);
        display:flex;gap:10px;
      }
      .wrtc-lbtn{
        width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        background:rgba(255,255,255,.15);color:#e8eaed;
        backdrop-filter:blur(6px);transition:background .15s,transform .1s;
      }
      .wrtc-lbtn:hover{background:rgba(255,255,255,.25);transform:scale(1.07)}
      .wrtc-lbtn.muted{background:#ea4335;color:#fff}
      .wrtc-lbtn.muted:hover{background:#d33828}
      /* RIGHT — form */
      .wrtc-lobby-right{
        width:320px;flex-shrink:0;padding:40px 32px;
        display:flex;flex-direction:column;justify-content:center;gap:24px;
      }
      .wrtc-lobby-brand{
        display:flex;align-items:center;gap:10px;
        font-size:13px;color:rgba(255,255,255,.45);letter-spacing:.3px;
      }
      .wrtc-lobby-brand svg{opacity:.4}
      .wrtc-lobby-title{font-size:22px;font-weight:600;color:#e8eaed;line-height:1.3}
      .wrtc-lobby-room{
        font-size:13px;color:rgba(255,255,255,.45);
        display:flex;align-items:center;gap:6px;
      }
      .wrtc-lobby-room strong{
        color:rgba(255,255,255,.75);
        max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      }
      .wrtc-lobby-input{
        width:100%;background:rgba(255,255,255,.07);
        border:1.5px solid rgba(255,255,255,.15);border-radius:10px;
        padding:13px 16px;color:#e8eaed;font-size:15px;font-family:inherit;
        outline:none;transition:border-color .2s;
      }
      .wrtc-lobby-input::placeholder{color:rgba(255,255,255,.3)}
      .wrtc-lobby-input:focus{border-color:rgba(138,180,248,.7)}
      .wrtc-join-btn{
        width:100%;padding:13px;border-radius:10px;border:none;
        background:#1a73e8;color:#fff;font-size:15px;font-weight:500;
        font-family:inherit;cursor:pointer;
        transition:background .15s,transform .1s,box-shadow .15s;
        box-shadow:0 2px 8px rgba(26,115,232,.4);
      }
      .wrtc-join-btn:hover{background:#1557b0;transform:translateY(-1px);box-shadow:0 4px 16px rgba(26,115,232,.5)}
      .wrtc-join-btn:active{transform:translateY(0)}
      .wrtc-join-btn:disabled{background:#4a4e52;box-shadow:none;cursor:not-allowed;transform:none}
      /* responsive */
      @media(max-width:600px){
        .wrtc-lobby-card{flex-direction:column}
        .wrtc-lobby-left{min-height:220px}
        .wrtc-lobby-right{width:100%;padding:28px 24px}
      }
    </style>
    <div class="wrtc-lobby">
      <div class="wrtc-lobby-card">
        <!-- Camera preview -->
        <div class="wrtc-lobby-left">
          <video class="wrtc-lobby-preview" id="wrtc-lobby-video" autoplay muted playsinline></video>
          <div class="wrtc-lobby-cam-off" id="wrtc-lobby-cam-off">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 6.5l-4-4-9.27 9.27-.73-.73-1.41 1.41.73.73-3 3H3v2h2.27L2 21l1.41 1.41L21 4.91 21 6.5zm-7 7l-5.5-5.5H16v3.5l4-4v9l-1.17-1.17L14 13.5zM3 7h2.27L7 8.73V7H3zm14 10H7.27l-2-2H17v2z"/>
            </svg>
            <span>Camera is off</span>
          </div>
          <div class="wrtc-lobby-preview-btns">
            <button class="wrtc-lbtn" id="wrtc-lobby-mic" title="Toggle mic">
              <svg id="wrtc-lobby-mic-on" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              </svg>
              <svg id="wrtc-lobby-mic-off" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="display:none">
                <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
              </svg>
            </button>
            <button class="wrtc-lbtn" id="wrtc-lobby-cam" title="Toggle camera">
              <svg id="wrtc-lobby-cam-on" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
              </svg>
              <svg id="wrtc-lobby-cam-icon-off" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="display:none">
                <path d="M21 6.5l-4-4-9.27 9.27-.73-.73-1.41 1.41.73.73-3 3H3v2h2.27L2 21l1.41 1.41L21 4.91 21 6.5zm-7 7l-5.5-5.5H16v3.5l4-4v9l-1.17-1.17L14 13.5zM3 7h2.27L7 8.73V7H3zm14 10H7.27l-2-2H17v2z"/>
              </svg>
            </button>
          </div>
        </div>
        <!-- Join form -->
        <div class="wrtc-lobby-right">
          <div class="wrtc-lobby-brand">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            </svg>
            WebRTC Meeting
          </div>
          <div>
            <div class="wrtc-lobby-title">Ready to join?</div>
          </div>
          <div class="wrtc-lobby-room">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity=".6">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
            <strong id="wrtc-lobby-room-name"></strong>
          </div>
          <input
            class="wrtc-lobby-input"
            id="wrtc-name-input"
            type="text"
            placeholder="Enter your name"
            maxlength="40"
            autocomplete="given-name"
            autofocus
          />
          <button class="wrtc-join-btn" id="wrtc-join-btn" disabled>Join now</button>
        </div>
      </div>
    </div>`;

    document.getElementById("wrtc-lobby-room-name").textContent = this.roomName;

    // Enable Join only when name is non-empty AND camera preview is ready
    const nameInput = document.getElementById("wrtc-name-input");
    const joinBtn   = document.getElementById("wrtc-join-btn");
    let previewReady = false;
    const refreshJoinBtn = () => {
      joinBtn.disabled = nameInput.value.trim().length === 0 || !previewReady;
    };
    nameInput.addEventListener("input", refreshJoinBtn);
    nameInput.addEventListener("keydown", e => {
      if (e.key === "Enter" && !joinBtn.disabled) joinBtn.click();
    });
    joinBtn.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (name) this._joinMeeting(name);
    });

    // Lobby mic/cam toggles (use same state vars)
    document.getElementById("wrtc-lobby-mic").addEventListener("click", () => {
      this._micEnabled = !this._micEnabled;
      this._localStream?.getAudioTracks().forEach(t => { t.enabled = this._micEnabled; });
      document.getElementById("wrtc-lobby-mic").classList.toggle("muted", !this._micEnabled);
      document.getElementById("wrtc-lobby-mic-on").style.display  = this._micEnabled ? "" : "none";
      document.getElementById("wrtc-lobby-mic-off").style.display = this._micEnabled ? "none" : "";
    });
    document.getElementById("wrtc-lobby-cam").addEventListener("click", () => {
      this._camEnabled = !this._camEnabled;
      this._localStream?.getVideoTracks().forEach(t => { t.enabled = this._camEnabled; });
      document.getElementById("wrtc-lobby-cam").classList.toggle("muted", !this._camEnabled);
      document.getElementById("wrtc-lobby-cam-on").style.display       = this._camEnabled ? "" : "none";
      document.getElementById("wrtc-lobby-cam-icon-off").style.display = this._camEnabled ? "none" : "";
      document.getElementById("wrtc-lobby-video").style.display        = this._camEnabled ? "block" : "none";
      document.getElementById("wrtc-lobby-cam-off").style.display      = this._camEnabled ? "none"  : "flex";
    });

    // Start camera preview, then auto-rejoin if session name exists
    this._initPreview().then(() => {
      previewReady = true;
      refreshJoinBtn();
      const savedName = sessionStorage.getItem('wrtc_name_' + this.roomName);
      if (savedName) {
        nameInput.value = savedName;
        refreshJoinBtn();
        joinBtn.click();
        if (sessionStorage.getItem('wrtc_sharing_' + this.roomName)) {
          setTimeout(() => this._toast("Screen sharing stopped — click Share to resume"), 1500);
          sessionStorage.removeItem('wrtc_sharing_' + this.roomName);
        }
      }
    });
  }

  async _initPreview() {
    try {
      this._localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      document.getElementById("wrtc-lobby-video").srcObject = this._localStream;
    } catch (err) {
      this._log("Preview camera failed: " + err.message, undefined, "warn");
      document.getElementById("wrtc-lobby-cam-off").style.display = "flex";
      document.getElementById("wrtc-lobby-video").style.display   = "none";
    }
  }

  _joinMeeting(name) {
    this._myName = name;
    // NOTE: do NOT save wrtc_name_ here — only save after admission (user-list received).
    // Saving here would allow a pending guest to bypass knock-approval on refresh.
    // Show a lightweight waiting screen; full UI is built only after host admits us
    this.parentNode.innerHTML =
      '<style>@keyframes wrtc-csp{to{transform:rotate(360deg)}}</style>' +
      '<div style="position:fixed;inset:0;background:#202124;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:16px;font-family:sans-serif;">' +
      '<div style="width:48px;height:48px;border:4px solid rgba(255,255,255,.1);' +
      'border-top:4px solid #1a73e8;border-radius:50%;animation:wrtc-csp 1s linear infinite;"></div>' +
      '<p id="wrtc-approval-text" style="color:#e8eaed;font-size:17px;font-weight:500;margin:0;">Connecting…</p>' +
      '<p style="color:rgba(255,255,255,.45);font-size:13px;margin:0;">Please wait</p>' +
      '</div>';
    this._setupAudioAnalyser("local", this._localStream);
    this._setupWebSocket();
  }

  // Called once host admits the guest (or for host/direct-join on first user-list)
  _buildUIAfterAdmit() {
    if (this._uiBuilt) return;
    this._uiBuilt = true;
    const startKey = 'wrtc_start_' + this.roomName;
    const saved = sessionStorage.getItem(startKey);
    this._meetingStart = saved ? parseInt(saved, 10) : Date.now();
    if (!saved) sessionStorage.setItem(startKey, String(this._meetingStart));
    // Re-apply saved cam/mic state (handles cases where it may have been reset before UI builds)
    if (sessionStorage.getItem('wrtc_mic_' + this.roomName) === '0') {
      this._micEnabled = false;
      this._localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
    }
    if (sessionStorage.getItem('wrtc_cam_' + this.roomName) === '0') {
      this._camEnabled = false;
      this._localStream?.getVideoTracks().forEach(t => { t.enabled = false; });
    }
    this._buildUI();
    const localVid = document.getElementById("wrtc-local-video");
    if (localVid) {
      localVid.srcObject = this._localStream;
      localVid.style.transform = "scaleX(-1)";
    }
    if (!this._camEnabled) {
      document.getElementById("wrtc-local-video").style.display = "none";
      document.getElementById("wrtc-pip-avatar").style.display  = "flex";
      document.getElementById("wrtc-btn-cam").classList.add("muted");
      document.getElementById("wrtc-ico-cam").style.display     = "none";
      document.getElementById("wrtc-ico-cam-off").style.display = "";
    }
    if (!this._micEnabled) {
      document.getElementById("wrtc-btn-mic").classList.add("muted");
      document.getElementById("wrtc-ico-mic").style.display     = "none";
      document.getElementById("wrtc-ico-mic-off").style.display = "";
    }
    this._startSpeakerDetection();
  }

  _applySettings() {
    const s = this._settings;
    const isHost = this._isHost;

    // Host-only controls
    ["wrtc-btn-muteall", "wrtc-btn-mutecams"].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = isHost ? "" : "none";
    });

    // Chat — hide button and panel tab if disabled
    const chatBtn = document.getElementById("wrtc-btn-chat");
    const chatTab = document.getElementById("wrtc-tab-chat");
    const chatContent = document.getElementById("wrtc-chat-content");
    if (!isHost && s.allow_chat === false) {
      if (chatBtn) chatBtn.style.display = "none";
      if (chatTab) chatTab.style.display = "none";
      if (chatContent) chatContent.style.display = "none";
    }

    // Screen share — hide button if disabled
    const shareBtn = document.getElementById("wrtc-btn-share");
    if (!isHost && s.allow_screen_share === false) {
      if (shareBtn) shareBtn.style.display = "none";
    }

    // Participants list — hide people panel tab if disabled
    const peopleBtn = document.getElementById("wrtc-btn-people");
    const peopleTab = document.getElementById("wrtc-tab-people");
    const peopleContent = document.getElementById("wrtc-people-content");
    if (!isHost && s.allow_participants_see_others === false) {
      if (peopleBtn) peopleBtn.style.display = "none";
      if (peopleTab) peopleTab.style.display = "none";
      if (peopleContent) peopleContent.style.display = "none";
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BUILD UI
  // ═══════════════════════════════════════════════════════════════════════
  _buildUI() {
    this.parentNode.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600&display=swap');
      .wrtc *,.wrtc *::before,.wrtc *::after{box-sizing:border-box;margin:0;padding:0}
      .wrtc{
        font-family:'Google Sans',Roboto,-apple-system,sans-serif;
        background:#202124;color:#e8eaed;
        height:100%;display:flex;flex-direction:column;
        position:relative;overflow:hidden;user-select:none;
      }

      /* ── TOPBAR ── */
      .wrtc-top{
        position:absolute;top:0;left:0;right:0;z-index:30;
        display:flex;align-items:center;justify-content:space-between;
        padding:14px 20px;
        background:linear-gradient(to bottom,rgba(0,0,0,.6) 0%,transparent 100%);
        pointer-events:none;
      }
      .wrtc-top>*{pointer-events:auto}
      .wrtc-top-left{display:flex;align-items:center;gap:14px}
      .wrtc-top-right{display:flex;align-items:center;gap:10px}
      .wrtc-room-name{font-size:15px;font-weight:500;color:#fff;letter-spacing:.2px}
      .wrtc-clock{font-size:14px;color:rgba(255,255,255,.65)}
      .wrtc-rec-badge{
        display:none;align-items:center;gap:6px;
        background:rgba(234,67,53,.9);color:#fff;
        font-size:12px;font-weight:500;padding:4px 10px;border-radius:20px;
      }
      .wrtc-rec-badge.active{display:flex}
      .wrtc-rec-dot{
        width:8px;height:8px;border-radius:50%;background:#fff;
        animation:wrtc-blink 1s ease-in-out infinite;
      }
      @keyframes wrtc-blink{0%,100%{opacity:1}50%{opacity:.3}}
      .wrtc-peer-chip{
        display:flex;align-items:center;gap:5px;
        background:rgba(255,255,255,.12);border-radius:20px;
        padding:4px 12px 4px 8px;font-size:13px;color:#e8eaed;
        backdrop-filter:blur(4px);cursor:pointer;
        transition:background .15s;
      }
      .wrtc-peer-chip:hover{background:rgba(255,255,255,.22);}
      .wrtc-status-dot{
        width:8px;height:8px;border-radius:50%;background:#5f6368;
        transition:background .3s;
      }
      .wrtc-status-dot.ok {background:#34a853}
      .wrtc-status-dot.err{background:#ea4335}

      /* ── STAGE ── */
      @keyframes wrtc-slide-in{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
      .wrtc-stage{
        flex:1;display:flex;align-items:stretch;
        padding:68px 0 88px;overflow:hidden;transition:padding-right .25s;
      }
      .wrtc-stage.panel-open{padding-right:340px}

      /* ── GRID ── */
      .wrtc-grid{
        flex:1;display:grid;gap:6px;
        padding:6px;overflow:hidden;
        align-items:stretch;justify-items:stretch;
      }

      /* ── TILE ── */
      .wrtc-tile{
        position:relative;border-radius:12px;overflow:hidden;
        background:#3c4043;width:100%;height:100%;min-height:0;
        transition:box-shadow .25s;
      }
      .wrtc-tile video{
        width:100%;height:100%;object-fit:cover;display:block;background:#000;
      }
      #wrtc-local-video{transform:scaleX(-1)}
      .wrtc-tile.speaking{
        box-shadow:0 0 0 3px #1a73e8,0 0 20px rgba(26,115,232,.4);
      }
      .wrtc-tile-avatar{
        position:absolute;inset:0;
        display:none;align-items:center;justify-content:center;
        z-index:0;
      }
      .wrtc-tile-avatar.visible{ display:flex; }
      .wrtc-tile-avatar span{
        width:clamp(48px,9vw,96px);height:clamp(48px,9vw,96px);
        border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-size:clamp(18px,3.5vw,36px);font-weight:500;color:#fff;
      }
      .wrtc-tile-label{
        position:absolute;bottom:10px;left:10px;z-index:2;
        background:rgba(0,0,0,.55);backdrop-filter:blur(4px);
        color:#fff;font-size:12px;font-weight:500;
        padding:3px 8px;border-radius:6px;
        max-width:calc(100% - 56px);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      }
      .wrtc-tile-hand{
        position:absolute;top:10px;right:10px;z-index:2;
        font-size:22px;display:none;
        animation:wrtc-bounce .6s ease-in-out infinite alternate;
      }
      @keyframes wrtc-bounce{from{transform:translateY(0)}to{transform:translateY(-4px)}}
      .wrtc-tile-hand.raised{display:block}

      /* ── PRESENTATION MODE ── */
      .wrtc-stage.presenting .wrtc-grid{
        position:relative;
      }
      .wrtc-tile.presenter{
        position:absolute;
        top:0;left:0;right:0;bottom:0;
        width:100% !important;height:100% !important;
        z-index:8;border-radius:10px;
      }
      .wrtc-tile.presenter .wrtc-tile-label{
        font-size:13px;padding:5px 12px;
      }
      .wrtc-presenter-badge{
        position:absolute;top:10px;left:10px;z-index:9;
        background:rgba(26,115,232,.9);color:#fff;
        font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;
        display:none;letter-spacing:.3px;
      }
      .wrtc-tile.presenter .wrtc-presenter-badge{ display:block; }
      /* thumbnails strip while presenter is active */
      .wrtc-thumbs{
        position:absolute;bottom:96px;left:12px;
        display:none;flex-direction:row;gap:6px;z-index:25;
      }
      .wrtc-thumb-tile{
        width:140px;height:79px;border-radius:8px;overflow:hidden;
        background:#3c4043;position:relative;flex-shrink:0;
        border:1px solid rgba(255,255,255,.15);
      }
      .wrtc-thumb-tile video{
        width:100%;height:100%;object-fit:cover;display:block;
      }
      .wrtc-thumb-label{
        position:absolute;bottom:4px;left:6px;
        font-size:10px;color:#fff;font-weight:500;
        background:rgba(0,0,0,.55);padding:2px 5px;border-radius:4px;
      }

      /* ── WAITING (full-screen, shown when alone) ── */
      .wrtc-waiting{
        position:absolute;inset:0;z-index:20;background:#202124;
        display:none;flex-direction:column;align-items:center;justify-content:center;
        gap:16px;color:rgba(255,255,255,.75);text-align:center;padding:40px;
      }
      .wrtc-waiting-ring{
        width:60px;height:60px;border-radius:50%;
        border:3px solid rgba(255,255,255,.12);border-top-color:#1a73e8;
        animation:wrtc-spin 1s linear infinite;
      }
      @keyframes wrtc-spin{to{transform:rotate(360deg)}}
      .wrtc-waiting p  {font-size:16px;font-weight:500;margin-top:4px}
      .wrtc-waiting small{font-size:13px;opacity:.55}

      /* ── PiP (hidden — local video is now a grid tile) ── */
      .wrtc-pip{ display:none; }
      .wrtc-pip-avatar{
        position:absolute;inset:0;display:none;z-index:2;
        align-items:center;justify-content:center;
        background:#3c4043;
      }
      .wrtc-pip-avatar span{
        width:clamp(48px,8vw,88px);height:clamp(48px,8vw,88px);border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        font-size:clamp(18px,3vw,34px);font-weight:500;color:#fff;background:#1a73e8;
      }
      .wrtc-pip-hand{
        position:absolute;top:10px;right:10px;z-index:3;font-size:22px;
        display:none;animation:wrtc-bounce .6s ease-in-out infinite alternate;
      }
      .wrtc-pip-hand.raised{display:block}

      /* ── CONTROLS ── */
      .wrtc-controls{
        position:absolute;bottom:0;left:0;right:0;z-index:30;
        display:flex;align-items:center;justify-content:center;gap:8px;
        padding:14px 20px 18px;
        background:linear-gradient(to top,rgba(0,0,0,.7) 0%,transparent 100%);
      }
      .wrtc-btn{
        width:50px;height:50px;border-radius:50%;border:none;
        background:rgba(255,255,255,.12);color:#e8eaed;cursor:pointer;
        display:flex;align-items:center;justify-content:center;position:relative;
        transition:background .15s,transform .1s;flex-shrink:0;
        outline:none;backdrop-filter:blur(4px);
      }
      .wrtc-btn:hover{background:rgba(255,255,255,.2);transform:scale(1.06)}
      .wrtc-btn:active{transform:scale(.93)}
      .wrtc-btn.muted,.wrtc-btn.active-feature{background:#ea4335;color:#fff}
      .wrtc-btn.muted:hover,.wrtc-btn.active-feature:hover{background:#d33828}
      .wrtc-btn.on-air{background:#1a73e8;color:#fff}
      .wrtc-btn.on-air:hover{background:#1557b0}
      .wrtc-btn-badge{
        position:absolute;top:2px;right:2px;
        width:16px;height:16px;border-radius:50%;
        background:#ea4335;color:#fff;font-size:9px;font-weight:700;
        display:none;align-items:center;justify-content:center;
        border:2px solid #202124;
      }
      .wrtc-btn-badge.show{display:flex}
      .wrtc-btn-label{
        position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);
        font-size:10px;color:rgba(255,255,255,.5);white-space:nowrap;
        pointer-events:none;
      }
      .wrtc-btn-leave{
        width:auto;border-radius:28px;padding:0 24px;gap:8px;
        background:#ea4335;color:#fff;font-size:14px;font-weight:500;
      }
      .wrtc-btn-leave:hover{background:#d33828;transform:scale(1.03)}
      .wrtc-divider{width:1px;height:32px;background:rgba(255,255,255,.15);flex-shrink:0;margin:0 2px}

      /* ── SIDE PANEL (People + Chat) ── */
      .wrtc-side-panel{
        position:absolute;top:0;right:0;bottom:0;width:340px;z-index:32;
        background:#202124;border-left:1px solid rgba(255,255,255,.08);
        display:flex;flex-direction:column;
        transform:translateX(100%);transition:transform .25s cubic-bezier(.4,0,.2,1);
        pointer-events:none;
      }
      .wrtc-side-panel.open{transform:translateX(0);pointer-events:auto}
      /* tabs */
      .wrtc-panel-tabs{
        display:flex;align-items:center;
        border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;
      }
      .wrtc-panel-tab{
        flex:1;padding:14px 0;font-size:13px;font-weight:500;color:rgba(255,255,255,.5);
        background:none;border:none;cursor:pointer;position:relative;
        font-family:inherit;transition:color .15s;display:flex;align-items:center;justify-content:center;gap:6px;
      }
      .wrtc-panel-tab:hover{color:#e8eaed}
      .wrtc-panel-tab.active{color:#e8eaed}
      .wrtc-panel-tab.active::after{
        content:'';position:absolute;bottom:0;left:16px;right:16px;
        height:2px;background:#8ab4f8;border-radius:1px;
      }
      .wrtc-panel-close{
        width:40px;height:40px;border-radius:50%;border:none;
        background:transparent;color:#9aa0a6;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        transition:background .15s;margin-right:4px;flex-shrink:0;
      }
      .wrtc-panel-close:hover{background:rgba(255,255,255,.1);color:#e8eaed}
      .wrtc-tab-badge{
        background:#ea4335;color:#fff;font-size:10px;font-weight:700;
        min-width:16px;height:16px;border-radius:8px;
        display:none;align-items:center;justify-content:center;padding:0 4px;
      }
      .wrtc-tab-badge.show{display:flex}
      /* panel content areas */
      .wrtc-panel-body{flex:1;display:flex;flex-direction:column;overflow:hidden}
      .wrtc-panel-content{flex:1;display:flex;flex-direction:column;overflow:hidden}
      /* ── PEOPLE TAB ── */
      .wrtc-knock-header{
        display:flex;align-items:center;justify-content:space-between;
        padding:8px 16px 6px;border-bottom:1px solid rgba(255,255,255,.08);
      }
      .wrtc-knock-header-label{font-size:11px;color:rgba(255,255,255,.4);font-weight:500;text-transform:uppercase;letter-spacing:.5px}
      .wrtc-knock-bulk{display:flex;gap:6px}
      .wrtc-knock-bulk-admit,.wrtc-knock-bulk-deny{
        padding:3px 10px;border:none;border-radius:6px;font-size:11px;
        font-weight:500;cursor:pointer;
      }
      .wrtc-knock-bulk-admit{background:#1a73e8;color:#fff}
      .wrtc-knock-bulk-deny{background:rgba(234,67,53,.15);color:#ea4335;border:1px solid rgba(234,67,53,.3)}
      .wrtc-knock-entry{
        display:flex;align-items:center;gap:12px;
        padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.06);
      }
        display:flex;align-items:center;gap:12px;
        padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.06);
      }
      .wrtc-knock-actions{display:flex;gap:6px;margin-left:auto;flex-shrink:0}
      .wrtc-knock-admit,.wrtc-knock-deny{
        padding:4px 10px;border:none;border-radius:6px;font-size:12px;
        font-weight:500;cursor:pointer;
      }
      .wrtc-knock-admit{background:#1a73e8;color:#fff}
      .wrtc-knock-deny{background:rgba(234,67,53,.15);color:#ea4335;border:1px solid rgba(234,67,53,.3)}
      .wrtc-knock-waiting{font-size:11px;color:rgba(255,255,255,.4);margin-top:2px}
      .wrtc-people-list{
        flex:1;overflow-y:auto;padding:8px 0;
      }
      .wrtc-people-list::-webkit-scrollbar{width:4px}
      .wrtc-people-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:2px}
      .wrtc-person{
        display:flex;align-items:center;gap:12px;
        padding:10px 16px;transition:background .15s;
      }
      .wrtc-person:hover{background:rgba(255,255,255,.05)}
      .wrtc-person-avatar{
        width:36px;height:36px;border-radius:50%;flex-shrink:0;
        display:flex;align-items:center;justify-content:center;
        font-size:14px;font-weight:500;color:#fff;
      }
      .wrtc-person-info{flex:1;min-width:0}
      .wrtc-person-name{
        font-size:14px;color:#e8eaed;font-weight:400;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      }
      .wrtc-you-tag{
        font-size:11px;color:rgba(255,255,255,.4);margin-left:4px;
      }
      .wrtc-person-icons{display:flex;gap:6px;align-items:center}
      .wrtc-person-icon{color:rgba(255,255,255,.35);display:flex}
      .wrtc-person-icon.muted{color:#ea4335}
      /* ── CHAT TAB ── */
      .wrtc-chat-msgs{
        flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:4px;
        scroll-behavior:smooth;
      }
      .wrtc-chat-msgs::-webkit-scrollbar{width:4px}
      .wrtc-chat-msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:2px}
      .wrtc-chat-empty{
        flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:10px;color:rgba(255,255,255,.4);text-align:center;padding:24px;
      }
      .wrtc-chat-empty p{font-size:13px}
      .wrtc-msg{display:flex;flex-direction:column;gap:2px;padding:6px 0}
      .wrtc-msg-header{display:flex;align-items:baseline;gap:8px}
      .wrtc-msg-name{font-size:12px;font-weight:600;color:#8ab4f8}
      .wrtc-msg-name.mine{color:#81c995}
      .wrtc-msg-time{font-size:10px;color:rgba(255,255,255,.35)}
      .wrtc-msg-text{
        font-size:13px;color:#e8eaed;line-height:1.5;
        padding:8px 10px;border-radius:0 10px 10px 10px;
        background:rgba(255,255,255,.08);max-width:100%;word-break:break-word;
        display:inline-block;
      }
      .wrtc-msg.mine .wrtc-msg-text{
        border-radius:10px 0 10px 10px;background:rgba(138,180,248,.18);
        align-self:flex-end;
      }
      .wrtc-msg.mine{align-items:flex-end}
      .wrtc-msg-system{
        font-size:11px;color:rgba(255,255,255,.35);text-align:center;
        padding:4px 0;font-style:italic;
      }
      .wrtc-msg-more{
        font-size:11px;color:#8ab4f8;cursor:pointer;margin-top:3px;display:inline-block;
      }
      .wrtc-msg-more:hover{text-decoration:underline}
      .wrtc-chat-footer{
        display:flex;align-items:center;gap:8px;
        padding:12px 14px;border-top:1px solid rgba(255,255,255,.08);flex-shrink:0;
      }
      .wrtc-chat-input{
        flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
        border-radius:24px;padding:9px 16px;color:#e8eaed;font-size:13px;
        outline:none;font-family:inherit;transition:border-color .15s;
      }
      .wrtc-chat-input::placeholder{color:rgba(255,255,255,.3)}
      .wrtc-chat-input:focus{border-color:rgba(138,180,248,.5)}
      .wrtc-chat-send{
        width:38px;height:38px;border-radius:50%;border:none;
        background:#1a73e8;color:#fff;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        transition:background .15s,transform .1s;flex-shrink:0;
      }
      .wrtc-chat-send:hover{background:#1557b0;transform:scale(1.06)}

      /* ── TOAST ── */
      .wrtc-toast{
        position:absolute;top:68px;left:50%;
        transform:translateX(-50%) translateY(-8px);
        background:#3c4043;color:#e8eaed;
        font-size:13px;padding:8px 18px;border-radius:8px;
        box-shadow:0 4px 16px rgba(0,0,0,.4);
        z-index:50;opacity:0;transition:opacity .2s,transform .2s;
        pointer-events:none;white-space:nowrap;
      }
      .wrtc-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

      /* ── INVITE MODAL ── */
      .wrtc-invite-overlay{
        position:fixed;inset:0;z-index:200;
        background:rgba(0,0,0,.6);backdrop-filter:blur(4px);
        display:flex;align-items:center;justify-content:center;
      }
      .wrtc-invite-box{
        background:#2d2e31;border-radius:16px;padding:32px;
        width:90%;max-width:440px;
        box-shadow:0 16px 48px rgba(0,0,0,.6);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      }
      .wrtc-invite-title{
        font-size:18px;font-weight:700;color:#e8eaed;margin-bottom:6px;
      }
      .wrtc-invite-sub{
        font-size:13px;color:#9aa0a6;margin-bottom:20px;
      }
      .wrtc-invite-url{
        background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.12);
        border-radius:10px;padding:12px 14px;
        font-size:13px;font-family:monospace;color:#4d94ff;
        word-break:break-all;line-height:1.5;margin-bottom:16px;
      }
      .wrtc-invite-actions{display:flex;gap:10px;}
      .wrtc-invite-copy{
        flex:1;background:#1a73e8;color:#fff;border:none;
        border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;
        transition:background .15s;
      }
      .wrtc-invite-copy:hover{background:#1557b0}
      .wrtc-invite-close{
        background:rgba(255,255,255,.08);color:#e8eaed;border:none;
        border-radius:10px;padding:11px 18px;font-size:14px;cursor:pointer;
        transition:background .15s;
      }
      .wrtc-invite-close:hover{background:rgba(255,255,255,.14)}
    </style>

    <div class="wrtc" id="wrtc-root">

      <!-- TOP BAR -->
      <div class="wrtc-top">
        <div class="wrtc-top-left">
          <span class="wrtc-room-name" id="wrtc-room-name"></span>
          <span class="wrtc-clock" id="wrtc-clock"></span>
          <div class="wrtc-rec-badge" id="wrtc-rec-badge">
            <div class="wrtc-rec-dot"></div> REC
          </div>
        </div>
        <div class="wrtc-top-right">
          <div class="wrtc-peer-chip">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" opacity=".7">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
            <span id="wrtc-user-count">1</span>
          </div>
          <div class="wrtc-status-dot" id="wrtc-status"></div>
        </div>
      </div>

      <!-- STAGE -->
      <div class="wrtc-stage" id="wrtc-stage">
        <div class="wrtc-grid" id="wrtc-grid">
          <!-- LOCAL TILE — always in the grid -->
          <div class="wrtc-tile wrtc-local-tile" id="wrtc-local-tile">
            <video id="wrtc-local-video" autoplay muted playsinline style="transform:scaleX(-1)"></video>
            <div class="wrtc-pip-avatar" id="wrtc-pip-avatar">
              <span id="wrtc-pip-avatar-text"></span>
            </div>
            <div class="wrtc-pip-hand" id="wrtc-pip-hand">✋</div>
            <div class="wrtc-tile-label" id="wrtc-pip-label"></div>
          </div>
        </div>
        <!-- Waiting overlay — full-screen, shown when alone in room -->
        <div class="wrtc-waiting" id="wrtc-waiting">
          <div class="wrtc-waiting-ring"></div>
          <p>Waiting for others to join…</p>
          <small>Share the room link to invite participants</small>
          <small style="opacity:.35;font-size:11px">Room: <strong id="wrtc-room-hint"></strong></small>
        </div>
      </div>

      <!-- Thumbnail strip (shown during presentation) -->
      <div class="wrtc-thumbs" id="wrtc-thumbs"></div>

      <!-- PiP hidden — local video is now in the grid -->
      <div class="wrtc-pip" id="wrtc-pip" style="display:none"></div>

      <!-- SIDE PANEL (People + Chat) -->
      <div class="wrtc-side-panel" id="wrtc-side-panel">
        <!-- Tab bar -->
        <div class="wrtc-panel-tabs">
          <button class="wrtc-panel-tab active" id="wrtc-tab-people">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
            People (<span id="wrtc-people-count">1</span>)
          </button>
          <button class="wrtc-panel-tab" id="wrtc-tab-chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
            </svg>
            Chat
            <span class="wrtc-tab-badge" id="wrtc-chat-badge"></span>
          </button>
          <button class="wrtc-panel-close" id="wrtc-panel-close" title="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div class="wrtc-panel-body">
          <!-- People tab content -->
          <div class="wrtc-panel-content" id="wrtc-people-content">
            <div id="wrtc-knock-list"></div>
            <div class="wrtc-people-list" id="wrtc-people-list"></div>
          </div>

          <!-- Chat tab content -->
          <div class="wrtc-panel-content" id="wrtc-chat-content" style="display:none;flex:1">
            <div class="wrtc-chat-msgs" id="wrtc-chat-msgs">
              <div class="wrtc-chat-empty" id="wrtc-chat-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="rgba(255,255,255,.2)">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
                </svg>
                <p>Messages are visible only to people in this call</p>
              </div>
            </div>
            <div class="wrtc-chat-footer">
              <input class="wrtc-chat-input" id="wrtc-chat-input" placeholder="Send a message to everyone" maxlength="500">
              <button class="wrtc-chat-send" id="wrtc-chat-send" title="Send">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- CONTROLS -->
      <div class="wrtc-controls" id="wrtc-controls">

        <!-- Mic -->
        <button class="wrtc-btn" id="wrtc-btn-mic" title="Mute / Unmute">
          <svg id="wrtc-ico-mic" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
          <svg id="wrtc-ico-mic-off" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none">
            <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
          </svg>
        </button>

        <!-- Camera -->
        <button class="wrtc-btn" id="wrtc-btn-cam" title="Stop / Start Video">
          <svg id="wrtc-ico-cam" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
          </svg>
          <svg id="wrtc-ico-cam-off" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none">
            <path d="M21 6.5l-4-4-9.27 9.27-.73-.73-1.41 1.41.73.73-3 3H3v2h2.27L2 21l1.41 1.41L21 4.91 21 6.5zm-7 7l-5.5-5.5H16v3.5l4-4v9l-1.17-1.17L14 13.5zM3 7h2.27L7 8.73V7H3zm14 10H7.27l-2-2H17v2z"/>
          </svg>
        </button>

        <div class="wrtc-divider"></div>

        <!-- Screen Share -->
        <button class="wrtc-btn" id="wrtc-btn-share" title="Share your screen">
          <svg id="wrtc-ico-share" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
            <path d="M10 13l2-2 2 2 1-1-3-3-3 3z" transform="translate(0 -1)"/>
          </svg>
          <svg id="wrtc-ico-share-stop" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none">
            <path d="M21.79 18l2 2H24v-2h-2.21zM20 18V6H6.21l2 2H20v8.79l-1.1-1.1L20 18zM0 2.81L1.81 4.6c-.01.13-.01.27-.01.4v12c0 1.1.89 2 2 2H0v2h24v-2h-2.21l2 2L22.21 22 1.79 1 0 2.81zM4 6.6L6 8.6V16h7.4l2 2H4c-1.1 0-2-.9-2-2V6c0-.14.01-.27.01-.4z"/>
          </svg>
        </button>

        <!-- Record -->
        <button class="wrtc-btn" id="wrtc-btn-rec" title="Record meeting">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="6" id="wrtc-rec-circle"/>
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
          </svg>
        </button>

        <div class="wrtc-divider"></div>

        <!-- Raise Hand -->
        <button class="wrtc-btn" id="wrtc-btn-hand" title="Raise hand">
          <span style="font-size:20px;line-height:1">✋</span>
        </button>

        <!-- People -->
        <button class="wrtc-btn" id="wrtc-btn-people" title="Show participants">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
          </svg>
        </button>

        <!-- Chat -->
        <button class="wrtc-btn" id="wrtc-btn-chat" title="Open chat">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
          </svg>
          <div class="wrtc-btn-badge" id="wrtc-chat-badge-btn"></div>
        </button>

        <div class="wrtc-divider"></div>

        <!-- Mute All Mics (host only, shown when mics not yet all muted) -->
        <button class="wrtc-btn" id="wrtc-btn-muteall" title="Mute all microphones" style="display:none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16.5 12c0 1.77-1.02 3.29-2.5 4.06V8l2.5-2.5V12zM5 9v6h4l5 5V4L9 9H5zm11.5 0l-1.5 1.5V9h1.5z"/>
            <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.2"/>
          </svg>
        </button>
        <!-- Unmute All Mics (host only, shown after muting all) -->
        <button class="wrtc-btn" id="wrtc-btn-unmuteall" title="Unmute all microphones" style="display:none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        </button>
        <!-- Mute All Cams (host only, shown when cams not yet all muted) -->
        <button class="wrtc-btn" id="wrtc-btn-mutecams" title="Mute all cameras" style="display:none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.2"/>
          </svg>
        </button>
        <!-- Unmute All Cams (host only, shown after muting all cams) -->
        <button class="wrtc-btn" id="wrtc-btn-unmutecams" title="Unmute all cameras" style="display:none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
          </svg>
        </button>

        <div class="wrtc-divider"></div>

        <!-- Invite -->
        <button class="wrtc-btn" id="wrtc-btn-invite" title="Invite people">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
          </svg>
        </button>

        <!-- Leave -->
        <button class="wrtc-btn wrtc-btn-leave" id="wrtc-btn-leave" title="Leave call">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.28-.28.67-.36 1.02-.25 1.12.37 2.33.57 3.58.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.26.2 2.46.57 3.58.1.35.02.74-.25 1.02L6.6 10.8z" transform="rotate(135,12,12)"/>
          </svg>
          Leave
        </button>
      </div>

      <div class="wrtc-toast" id="wrtc-toast"></div>
    </div>`;

    // Wire up static elements
    document.getElementById("wrtc-room-name").textContent      = this.roomName;
    document.getElementById("wrtc-room-hint").textContent      = this.roomName;
    document.getElementById("wrtc-pip-label").textContent      = this._myName || "You";
    document.getElementById("wrtc-pip-avatar-text").textContent = this._myName
      ? this._myName.slice(0, 2).toUpperCase() : "YO";
    document.getElementById("wrtc-btn-leave").addEventListener("click", () => this.hangup());
    document.getElementById("wrtc-btn-invite").addEventListener("click", () => this._showInvite());
    document.getElementById("wrtc-btn-muteall").addEventListener("click", () => {
      this._allMicsMuted = true;
      this._sendWS({ type: "mute-all", payload: {} });
      document.getElementById("wrtc-btn-muteall").style.display   = "none";
      document.getElementById("wrtc-btn-unmuteall").style.display = "";
      this._toast("All microphones muted");
    });
    document.getElementById("wrtc-btn-unmuteall").addEventListener("click", () => {
      this._allMicsMuted = false;
      this._sendWS({ type: "unmute-all", payload: {} });
      document.getElementById("wrtc-btn-unmuteall").style.display = "none";
      document.getElementById("wrtc-btn-muteall").style.display   = "";
      this._toast("All microphones unmuted");
    });
    document.getElementById("wrtc-btn-mutecams").addEventListener("click", () => {
      this._allCamsMuted = true;
      this._sendWS({ type: "cam-mute-all", payload: {} });
      document.getElementById("wrtc-btn-mutecams").style.display   = "none";
      document.getElementById("wrtc-btn-unmutecams").style.display = "";
      this._toast("All cameras muted");
    });
    document.getElementById("wrtc-btn-unmutecams").addEventListener("click", () => {
      this._allCamsMuted = false;
      this._sendWS({ type: "cam-unmute-all", payload: {} });
      document.getElementById("wrtc-btn-unmutecams").style.display = "none";
      document.getElementById("wrtc-btn-mutecams").style.display   = "";
      this._toast("All cameras unmuted");
    });
    document.getElementById("wrtc-btn-mic").addEventListener("click",   () => this._toggleMic());
    document.getElementById("wrtc-btn-cam").addEventListener("click",   () => this._toggleCam());
    document.getElementById("wrtc-btn-share").addEventListener("click", () => this._toggleScreenShare());
    document.getElementById("wrtc-btn-rec").addEventListener("click",   () => this._toggleRecording());
    document.getElementById("wrtc-btn-hand").addEventListener("click",  () => this._toggleHand());
    document.getElementById("wrtc-btn-people").addEventListener("click", () => this._togglePanel("people"));
    document.getElementById("wrtc-user-count").closest(".wrtc-peer-chip").addEventListener("click", () => this._togglePanel("people"));
    document.getElementById("wrtc-btn-chat").addEventListener("click",   () => this._togglePanel("chat"));
    document.getElementById("wrtc-tab-people").addEventListener("click", () => this._switchTab("people"));
    document.getElementById("wrtc-tab-chat").addEventListener("click",   () => this._switchTab("chat"));
    document.getElementById("wrtc-panel-close").addEventListener("click",() => this._closePanel());
    document.getElementById("wrtc-chat-send").addEventListener("click",  () => this._sendChat());
    document.getElementById("wrtc-chat-input").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._sendChat(); }
    });

    // When chat panel is open and user types anywhere in the meeting,
    // silently redirect focus + the keypress to the chat input
    document.addEventListener("keydown", e => {
      if (this._panelTab !== "chat") return;                // chat not open
      const input = document.getElementById("wrtc-chat-input");
      if (!input) return;
      if (document.activeElement === input) return;         // already focused
      // Ignore modifier-only keys, function keys, Escape, Tab, etc.
      const skip = e.ctrlKey || e.metaKey || e.altKey ||
                   e.key.startsWith("F") ||
                   ["Escape","Tab","CapsLock","Shift","Control","Alt","Meta",
                    "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
                    "Enter","Backspace","Delete","Home","End","PageUp","PageDown"].includes(e.key);
      if (skip) return;
      input.focus();
    });

    // Clicking anywhere on the chat input always gives it focus
    document.getElementById("wrtc-chat-input").addEventListener("mousedown", e => {
      e.stopPropagation();
    });
    document.getElementById("wrtc-chat-input").addEventListener("click", e => {
      e.currentTarget.focus();
    });

    this._startClock();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLOCK
  // ═══════════════════════════════════════════════════════════════════════
  _startClock() {
    const tick = () => {
      const el = document.getElementById("wrtc-clock");
      if (!el) return;
      const sec = Math.floor((Date.now() - (this._meetingStart || Date.now())) / 1000);
      const h   = Math.floor(sec / 3600);
      const m   = Math.floor((sec % 3600) / 60);
      const s   = sec % 60;
      el.textContent = h > 0
        ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
        : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    };
    tick();
    this._clockTimer = setInterval(tick, 1000);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MIC / CAM
  // ═══════════════════════════════════════════════════════════════════════
  _toggleMic() {
    if (!this._micEnabled && !this._isHost && this._settings.allow_unmute_self === false) {
      this._toast("The host has disabled self-unmuting");
      return;
    }
    // Clear host-muted flag when user manually unmutes themselves
    if (!this._micEnabled && this._hostMutedMic) this._hostMutedMic = false;
    this._micEnabled = !this._micEnabled;
    this._localStream?.getAudioTracks().forEach(t => { t.enabled = this._micEnabled; });
    sessionStorage.setItem('wrtc_mic_' + this.roomName, this._micEnabled ? '1' : '0');
    document.getElementById("wrtc-btn-mic").classList.toggle("muted", !this._micEnabled);
    document.getElementById("wrtc-ico-mic").style.display     = this._micEnabled ? "" : "none";
    document.getElementById("wrtc-ico-mic-off").style.display = this._micEnabled ? "none" : "";
    this._toast(this._micEnabled ? "Microphone on" : "Microphone muted");
  }

  _toggleCam() {
    if (!this._camEnabled && !this._isHost && this._settings.allow_unmute_self === false) {
      this._toast("The host has disabled self-unmuting");
      return;
    }
    if (!this._camEnabled && this._hostMutedCam) this._hostMutedCam = false;
    this._camEnabled = !this._camEnabled;
    this._localStream?.getVideoTracks().forEach(t => { t.enabled = this._camEnabled; });
    sessionStorage.setItem('wrtc_cam_' + this.roomName, this._camEnabled ? '1' : '0');
    document.getElementById("wrtc-btn-cam").classList.toggle("muted", !this._camEnabled);
    document.getElementById("wrtc-ico-cam").style.display     = this._camEnabled ? "" : "none";
    document.getElementById("wrtc-ico-cam-off").style.display = this._camEnabled ? "none" : "";
    document.getElementById("wrtc-local-video").style.display = this._camEnabled ? "block" : "none";
    document.getElementById("wrtc-pip-avatar").style.display  = this._camEnabled ? "none"  : "flex";
    this._toast(this._camEnabled ? "Camera on" : "Camera off");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCREEN SHARE
  // ═══════════════════════════════════════════════════════════════════════
  async _toggleScreenShare() {
    if (this._isSharing) {
      this._shareStream?.getTracks().forEach(t => t.stop());
      this._shareStream = null;
      this._isSharing   = false;
      sessionStorage.removeItem('wrtc_sharing_' + this.roomName);
      await this._restoreCameraTrack();
      document.getElementById("wrtc-btn-share").classList.remove("on-air");
      document.getElementById("wrtc-ico-share").style.display      = "";
      document.getElementById("wrtc-ico-share-stop").style.display  = "none";
      document.getElementById("wrtc-local-video").srcObject = this._localStream;
      this._clearPresenter();
      this._sendWS({ type: "presenting", payload: { active: false } });
      this._toast("Screen sharing stopped");
    } else {
      try {
        this._shareStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        this._isSharing   = true;
        sessionStorage.setItem('wrtc_sharing_' + this.roomName, '1');
        const screenTrack = this._shareStream.getVideoTracks()[0];
        screenTrack.onended = () => { if (this._isSharing) this._toggleScreenShare(); };
        await this._replaceVideoTrack(screenTrack);
        document.getElementById("wrtc-btn-share").classList.add("on-air");
        document.getElementById("wrtc-ico-share").style.display     = "none";
        document.getElementById("wrtc-ico-share-stop").style.display = "";
        this._setLocalPresenter();
        this._sendWS({ type: "presenting", payload: { active: true } });
        this._toast("You are now presenting");
      } catch (err) {
        if (err.name !== "NotAllowedError") this._toast("Screen share failed");
        this._log("Screen share error: " + err.message, undefined, "error");
      }
    }
  }

  _setPresenter(userId) {
    const stage  = document.getElementById("wrtc-stage");
    const thumbs = document.getElementById("wrtc-thumbs");
    stage?.classList.add("presenting");
    thumbs.innerHTML = "";

    document.querySelectorAll(".wrtc-tile").forEach(tile => {
      if (tile.id === `wrtc-tile-${userId}`) {
        tile.classList.add("presenter");
      } else {
        this._addThumb(tile, thumbs);
        tile.style.display = "none";
      }
    });

    thumbs.style.display = "flex";
  }

  _setLocalPresenter() {
    const stage  = document.getElementById("wrtc-stage");
    const thumbs = document.getElementById("wrtc-thumbs");
    const grid   = document.getElementById("wrtc-grid");
    stage?.classList.add("presenting");
    thumbs.innerHTML = "";

    // Full-screen tile showing your screen share
    const tile = document.createElement("div");
    tile.id        = "wrtc-local-share-tile";
    tile.className = "wrtc-tile presenter";

    const video        = document.createElement("video");
    video.autoplay     = true;
    video.playsInline  = true;
    video.muted        = true;
    video.srcObject    = this._shareStream;

    const badge        = document.createElement("div");
    badge.className    = "wrtc-presenter-badge";
    badge.textContent  = "You are presenting";

    const label        = document.createElement("div");
    label.className    = "wrtc-tile-label";
    label.textContent  = this._myName || "You";

    tile.append(video, badge, label);
    grid.appendChild(tile);

    // Move remote tiles to thumbnail strip
    document.querySelectorAll(".wrtc-tile:not(#wrtc-local-share-tile)").forEach(t => {
      this._addThumb(t, thumbs);
      t.style.display = "none";
    });
    thumbs.style.display = "flex";

    // PiP switches back to camera so you can see yourself
    document.getElementById("wrtc-local-video").srcObject = this._localStream;
  }

  _addThumb(tile, thumbs) {
    const vid = tile.querySelector("video");
    if (!vid) return;
    const wrap      = document.createElement("div");
    wrap.className  = "wrtc-thumb-tile";
    const tv        = document.createElement("video");
    tv.autoplay     = true;
    tv.playsInline  = true;
    tv.muted        = true;
    tv.srcObject    = vid.srcObject;
    const lbl       = document.createElement("div");
    lbl.className   = "wrtc-thumb-label";
    lbl.textContent = tile.querySelector(".wrtc-tile-label")?.textContent || "";
    wrap.append(tv, lbl);
    thumbs.appendChild(wrap);
  }

  _clearPresenter() {
    document.getElementById("wrtc-local-share-tile")?.remove();
    document.getElementById("wrtc-stage")?.classList.remove("presenting");
    const thumbs = document.getElementById("wrtc-thumbs");
    thumbs.innerHTML = "";
    thumbs.style.display = "none";
    document.querySelectorAll(".wrtc-tile").forEach(tile => {
      tile.classList.remove("presenter");
      tile.style.display = "";
    });
    this._updateGrid();
  }

  async _replaceVideoTrack(newTrack) {
    for (const pc of Object.values(this._peerConnections)) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
    }
  }

  async _restoreCameraTrack() {
    const camTrack = this._localStream?.getVideoTracks()[0];
    if (camTrack) await this._replaceVideoTrack(camTrack);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RECORDING
  // ═══════════════════════════════════════════════════════════════════════
  async _toggleRecording() {
    if (this._isRecording) {
      this._mediaRecorder?.stop();
      this._isRecording = false;
      this._recordTabStream?.getTracks().forEach(t => t.stop());
      this._recordTabStream = null;
      this._recordAudioCtx?.close();
      this._recordAudioCtx = null;
      document.getElementById("wrtc-btn-rec").classList.remove("active-feature");
      document.getElementById("wrtc-rec-badge").classList.remove("active");
      document.getElementById("wrtc-rec-circle").setAttribute("fill", "currentColor");
      this._toast("Recording saved");
    } else {
      try {
        const tabStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: true,
          preferCurrentTab: true,
        });
        this._recordTabStream = tabStream;
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = audioCtx.createMediaStreamDestination();
        if (tabStream.getAudioTracks().length)
          audioCtx.createMediaStreamSource(tabStream).connect(dest);
        if (this._localStream?.getAudioTracks().length)
          audioCtx.createMediaStreamSource(this._localStream).connect(dest);
        this._recordAudioCtx = audioCtx;
        const combined = new MediaStream([
          ...tabStream.getVideoTracks(),
          ...dest.stream.getAudioTracks(),
        ]);
        const mimeType = ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"]
          .find(t => MediaRecorder.isTypeSupported(t)) || "";
        this._recordChunks  = [];
        this._mediaRecorder = new MediaRecorder(combined, mimeType ? { mimeType } : {});
        this._mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this._recordChunks.push(e.data); };
        this._mediaRecorder.onstop = () => {
          const blob = new Blob(this._recordChunks, { type: mimeType || "video/webm" });
          const url  = URL.createObjectURL(blob);
          Object.assign(document.createElement("a"), { href: url, download: `meeting-${Date.now()}.webm` }).click();
          URL.revokeObjectURL(url);
        };
        tabStream.getVideoTracks()[0].onended = () => { if (this._isRecording) this._toggleRecording(); };
        this._mediaRecorder.start(1000);
        this._isRecording = true;
        document.getElementById("wrtc-btn-rec").classList.add("active-feature");
        document.getElementById("wrtc-rec-badge").classList.add("active");
        document.getElementById("wrtc-rec-circle").setAttribute("fill", "#fff");
        this._toast("Recording started — select this tab to capture everything");
      } catch (err) {
        if (err.name !== "NotAllowedError") this._toast("Recording failed: " + err.message);
        this._log("Recording error: " + err.message, undefined, "error");
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHAT
  // ═══════════════════════════════════════════════════════════════════════
  _togglePanel(tab) {
    if (this._panelTab === tab) { this._closePanel(); return; }
    this._panelTab = tab;
    document.getElementById("wrtc-side-panel").classList.add("open");
    document.getElementById("wrtc-stage").classList.add("panel-open");
    document.getElementById("wrtc-btn-people").classList.toggle("on-air", tab === "people");
    document.getElementById("wrtc-btn-chat").classList.toggle("on-air", tab === "chat");
    this._switchTab(tab);
  }

  _switchTab(tab) {
    this._panelTab = tab;
    document.getElementById("wrtc-tab-people").classList.toggle("active", tab === "people");
    document.getElementById("wrtc-tab-chat").classList.toggle("active", tab === "chat");
    document.getElementById("wrtc-people-content").style.display = tab === "people" ? "flex" : "none";
    document.getElementById("wrtc-chat-content").style.display   = tab === "chat"   ? "flex" : "none";
    if (tab === "chat") {
      this._unread = 0;
      document.getElementById("wrtc-chat-badge").classList.remove("show");
      document.getElementById("wrtc-chat-badge-btn").classList.remove("show");
      setTimeout(() => document.getElementById("wrtc-chat-input")?.focus(), 260);
    }
  }

  _closePanel() {
    this._panelTab = null;
    document.getElementById("wrtc-side-panel").classList.remove("open");
    document.getElementById("wrtc-stage").classList.remove("panel-open");
    document.getElementById("wrtc-btn-people").classList.remove("on-air");
    document.getElementById("wrtc-btn-chat").classList.remove("on-air");
  }

  // ── PARTICIPANTS ──────────────────────────────────────────────────────────
  _addParticipant(userId, name) {
    this._participants[userId] = name;
    this._renderParticipants();
  }

  _removeParticipant(userId) {
    delete this._participants[userId];
    this._renderParticipants();
  }

  _renderParticipants() {
    const list = document.getElementById("wrtc-people-list");
    if (!list) return;
    const total = Object.keys(this._participants).length + 1; // +1 for self
    const countEl = document.getElementById("wrtc-people-count");
    if (countEl) countEl.textContent = total;
    this._updateUserCount(total);

    list.innerHTML = "";

    // Local user first
    const selfEl = this._makePersonEl("local", this._myName || "You", true);
    list.appendChild(selfEl);

    // Remote participants
    Object.entries(this._participants).forEach(([uid, name]) => {
      list.appendChild(this._makePersonEl(uid, name, false));
    });
  }

  _makePersonEl(userId, name, isMe) {
    const div = document.createElement("div");
    div.className = "wrtc-person";

    const av = document.createElement("div");
    av.className = "wrtc-person-avatar";
    av.style.background = this._colorFromId(userId);
    av.textContent = name.slice(0, 2).toUpperCase();

    const info = document.createElement("div");
    info.className = "wrtc-person-info";
    const nameEl = document.createElement("div");
    nameEl.className = "wrtc-person-name";
    nameEl.textContent = name;
    if (isMe) {
      const tag = document.createElement("span");
      tag.className = "wrtc-you-tag";
      tag.textContent = "(you)";
      nameEl.appendChild(tag);
    }
    info.appendChild(nameEl);

    const icons = document.createElement("div");
    icons.className = "wrtc-person-icons";
    if (isMe) {
      // show local mic/cam state
      if (!this._micEnabled) {
        icons.innerHTML += `<span class="wrtc-person-icon muted" title="Muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
          </svg></span>`;
      }
    }

    // Remove button — only rendered for host, hidden for self
    // Use data-userid so the handler captures the correct ID at click time
    if (this._isHost && !isMe) {
      const removeBtn = document.createElement("button");
      removeBtn.title = "Remove from meeting";
      removeBtn.dataset.uid = userId;
      removeBtn.style.cssText =
        "background:rgba(234,67,53,.12);border:1px solid rgba(234,67,53,.35);cursor:pointer;"
        + "padding:3px 9px;border-radius:6px;color:#ea4335;font-size:11px;font-weight:500;"
        + "font-family:inherit;transition:background .15s;flex-shrink:0;";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("mouseenter", () => removeBtn.style.background = "rgba(234,67,53,.25)");
      removeBtn.addEventListener("mouseleave", () => removeBtn.style.background = "rgba(234,67,53,.12)");
      removeBtn.addEventListener("click", () => {
        const uid = removeBtn.dataset.uid;
        if (confirm("Remove " + name + " from the meeting?")) {
          this._sendWS({ type: "kick", payload: { userId: uid } });
        }
      });
      icons.appendChild(removeBtn);
    }

    div.append(av, info, icons);
    return div;
  }

  _sendChat() {
    const input = document.getElementById("wrtc-chat-input");
    const text  = input?.value.trim();
    if (!text) return;
    input.value = "";
    const ts = Date.now();
    this._sendWS({ type: "chat", payload: { text, ts } });
    this._renderMessage("You", text, ts, true);
  }

  _renderMessage(name, text, ts, isMine = false) {
    const empty = document.getElementById("wrtc-chat-empty");
    if (empty) empty.style.display = "none";

    const msgs = document.getElementById("wrtc-chat-msgs");
    const time  = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const safe  = text.replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const LIMIT = 120;
    const needsTrunc = safe.length > LIMIT;
    const preview    = needsTrunc ? safe.slice(0, LIMIT) + "…" : safe;

    const div = document.createElement("div");
    div.className = `wrtc-msg${isMine ? " mine" : ""}`;
    div.innerHTML = `
      <div class="wrtc-msg-header">
        <span class="wrtc-msg-name${isMine ? " mine" : ""}">${name}</span>
        <span class="wrtc-msg-time">${time}</span>
      </div>
      <span class="wrtc-msg-text" data-full="${safe.replace(/"/g,"&quot;")}" data-expanded="false">${preview}</span>
      ${needsTrunc ? '<span class="wrtc-msg-more">Show more</span>' : ""}`;

    if (needsTrunc) {
      div.querySelector(".wrtc-msg-more").addEventListener("click", function () {
        const span    = div.querySelector(".wrtc-msg-text");
        const expanded = span.dataset.expanded === "true";
        span.textContent      = expanded ? span.dataset.full.slice(0, LIMIT) + "…" : span.dataset.full;
        span.dataset.expanded = expanded ? "false" : "true";
        this.textContent      = expanded ? "Show more" : "Show less";
        msgs.scrollTop = msgs.scrollHeight;
      });
    }

    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  _renderSystemMsg(text) {
    const msgs = document.getElementById("wrtc-chat-msgs");
    if (!msgs) return;
    const d = document.createElement("div");
    d.className   = "wrtc-msg-system";
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RAISE HAND
  // ═══════════════════════════════════════════════════════════════════════
  _toggleHand() {
    this._handRaised = !this._handRaised;
    document.getElementById("wrtc-btn-hand").classList.toggle("active-feature", this._handRaised);
    document.getElementById("wrtc-pip-hand").classList.toggle("raised", this._handRaised);
    this._sendWS({ type: "raise-hand", payload: { raised: this._handRaised } });
    this._toast(this._handRaised ? "You raised your hand ✋" : "Hand lowered");
  }

  _updateHandUI(userId, raised) {
    const hand = document.getElementById(`wrtc-hand-${userId}`);
    if (hand) hand.classList.toggle("raised", raised);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ACTIVE SPEAKER DETECTION
  // ═══════════════════════════════════════════════════════════════════════
  _setupAudioAnalyser(userId, stream) {
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source   = this._audioCtx.createMediaStreamSource(stream);
      const analyser = this._audioCtx.createAnalyser();
      analyser.fftSize       = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      this._analysers[userId] = analyser;
    } catch (e) {
      this._log("AudioContext error: " + e.message, undefined, "warn");
    }
  }

  _getAudioLevel(analyser) {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);
    return buf.reduce((s, v) => s + v, 0) / buf.length;
  }

  _startSpeakerDetection() {
    this._speakerTimer = setInterval(() => {
      const THRESHOLD = 8;
      let maxLevel = THRESHOLD, activeSpeaker = null;
      for (const [uid, analyser] of Object.entries(this._analysers)) {
        const lvl = this._getAudioLevel(analyser);
        if (lvl > maxLevel) { maxLevel = lvl; activeSpeaker = uid; }
      }
      if (activeSpeaker !== this._currentSpeaker) {
        // Clear old highlight
        if (this._currentSpeaker) {
          const prev = this._currentSpeaker === "local"
            ? document.getElementById("wrtc-local-tile")
            : document.getElementById(`wrtc-tile-${this._currentSpeaker}`);
          prev?.classList.remove("speaking");
        }
        // Set new highlight
        if (activeSpeaker) {
          const el = activeSpeaker === "local"
            ? document.getElementById("wrtc-local-tile")
            : document.getElementById(`wrtc-tile-${activeSpeaker}`);
          el?.classList.add("speaking");
        }
        this._currentSpeaker = activeSpeaker;
      }
    }, 200);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOAST
  // ═══════════════════════════════════════════════════════════════════════
  _showInvite() {
    const url = this._shareUrl || (window.location.origin + '/sdk/join/' + this.roomName);
    const overlay = document.createElement('div');
    overlay.className = 'wrtc-invite-overlay';
    overlay.id = 'wrtc-invite-overlay';
    overlay.innerHTML = `
      <div class="wrtc-invite-box">
        <div class="wrtc-invite-title">Invite People</div>
        <div class="wrtc-invite-sub">Share this link — guests will knock to join</div>
        <div class="wrtc-invite-url" id="wrtc-invite-url-text">${url}</div>
        <div class="wrtc-invite-actions">
          <button class="wrtc-invite-copy" id="wrtc-invite-copy-btn">Copy Link</button>
          <button class="wrtc-invite-close" id="wrtc-invite-close-btn">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('wrtc-invite-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById('wrtc-invite-copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy Link'; }, 2000);
      });
    });
    const close = () => { const el = document.getElementById('wrtc-invite-overlay'); if (el) el.remove(); };
    document.getElementById('wrtc-invite-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  // ═══════════════════════════════════════════════════════════════════════
  _toast(msg) {
    const el = document.getElementById("wrtc-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GRID LAYOUT
  // ═══════════════════════════════════════════════════════════════════════
  _showKnockRequest(guestId, name) {
    // 1. Add / refresh entry in the people panel (persistent across panel opens)
    this._addKnockToPanel(guestId, name);

    // 2. Show a popup for 4 seconds then auto-dismiss (entry stays in panel)
    const popupId = "wrtc-knock-popup-" + guestId;
    if (document.getElementById(popupId)) return; // popup already showing

    // Stack popups vertically so multiple simultaneous requests are all visible
    const existingCount = document.querySelectorAll('[id^="wrtc-knock-popup-"]').length;
    const topPx = 20 + existingCount * 80;

    const popup = document.createElement("div");
    popup.id = popupId;
    popup.style.cssText =
      "position:fixed;top:" + topPx + "px;left:50%;transform:translateX(-50%);z-index:300;" +
      "background:#2d2e31;border:1px solid rgba(255,255,255,.12);border-radius:14px;" +
      "padding:14px 18px;display:flex;align-items:center;gap:14px;" +
      "box-shadow:0 4px 32px rgba(0,0,0,.7);font-family:sans-serif;min-width:300px;" +
      "animation:wrtc-slide-in .25s ease;";

    const av = document.createElement("div");
    av.style.cssText =
      "width:38px;height:38px;border-radius:50%;background:" + this._colorFromId(guestId) + ";" +
      "display:flex;align-items:center;justify-content:center;" +
      "color:#fff;font-size:15px;font-weight:600;flex-shrink:0;";
    av.textContent = (name || "?").slice(0, 2).toUpperCase();

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0;";
    info.innerHTML =
      '<p style="color:#e8eaed;font-size:13px;font-weight:500;margin:0 0 2px;">' +
      (name || "Someone") + " wants to join</p>" +
      '<p style="color:rgba(255,255,255,.45);font-size:12px;margin:0;">Check the People tab</p>';

    const makeBtn = (label, bg, action) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "padding:7px 14px;border:none;border-radius:8px;font-size:13px;font-weight:500;" +
        "cursor:pointer;background:" + bg + ";color:#fff;flex-shrink:0;";
      b.addEventListener("click", () => {
        this._knockAction(guestId, action);
        popup.remove();
      });
      return b;
    };

    const btnWrap = document.createElement("div");
    btnWrap.style.cssText = "display:flex;gap:8px;flex-shrink:0;";
    btnWrap.appendChild(makeBtn("Admit", "#1a73e8", "knock-approve"));
    btnWrap.appendChild(makeBtn("Deny",  "#ea4335", "knock-deny"));

    popup.append(av, info, btnWrap);
    document.body.appendChild(popup);
  }

  _addKnockToPanel(guestId, name) {
    const list = document.getElementById("wrtc-knock-list");
    if (!list) return;
    const entryId = "wrtc-knock-entry-" + guestId;
    if (document.getElementById(entryId)) return; // already in list

    // ── Bulk-action header (shown once, above all knock entries) ──────────────
    if (!document.getElementById("wrtc-knock-header")) {
      const header = document.createElement("div");
      header.id = "wrtc-knock-header";
      header.className = "wrtc-knock-header";
      header.innerHTML =
        '<span class="wrtc-knock-header-label">Waiting to join</span>' +
        '<div class="wrtc-knock-bulk">' +
          '<button class="wrtc-knock-bulk-admit" id="wrtc-knock-admit-all">Admit all</button>' +
          '<button class="wrtc-knock-bulk-deny"  id="wrtc-knock-deny-all">Deny all</button>' +
        '</div>';
      list.appendChild(header);

      document.getElementById("wrtc-knock-admit-all").addEventListener("click", () => {
        list.querySelectorAll(".wrtc-knock-entry").forEach(el => {
          const gid = el.id.replace("wrtc-knock-entry-", "");
          this._knockAction(gid, "knock-approve");
        });
        this._clearKnockHeader();
      });
      document.getElementById("wrtc-knock-deny-all").addEventListener("click", () => {
        list.querySelectorAll(".wrtc-knock-entry").forEach(el => {
          const gid = el.id.replace("wrtc-knock-entry-", "");
          this._knockAction(gid, "knock-deny");
        });
        this._clearKnockHeader();
      });
    }

    // ── Individual entry ──────────────────────────────────────────────────────
    const entry = document.createElement("div");
    entry.id = entryId;
    entry.className = "wrtc-knock-entry";

    const av = document.createElement("div");
    av.className = "wrtc-person-avatar";
    av.style.background = this._colorFromId(guestId);
    av.textContent = (name || "?").slice(0, 2).toUpperCase();

    const info = document.createElement("div");
    info.className = "wrtc-person-info";
    info.innerHTML =
      '<div class="wrtc-person-name">' + (name || "Guest") + "</div>" +
      '<div class="wrtc-knock-waiting">Waiting to join…</div>';

    const actions = document.createElement("div");
    actions.className = "wrtc-knock-actions";

    const admitBtn = document.createElement("button");
    admitBtn.className = "wrtc-knock-admit";
    admitBtn.textContent = "Admit";
    admitBtn.addEventListener("click", () => {
      this._knockAction(guestId, "knock-approve");
      entry.remove();
      if (!list.querySelectorAll(".wrtc-knock-entry").length) this._clearKnockHeader();
    });

    const denyBtn = document.createElement("button");
    denyBtn.className = "wrtc-knock-deny";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => {
      this._knockAction(guestId, "knock-deny");
      entry.remove();
      if (!list.querySelectorAll(".wrtc-knock-entry").length) this._clearKnockHeader();
    });

    actions.append(admitBtn, denyBtn);
    entry.append(av, info, actions);
    list.appendChild(entry);

    // Auto-open people panel so host sees it
    if (this._panelTab !== "people" && this._panelTab !== "chat") {
      this._togglePanel("people");
    }
  }

  _clearKnockHeader() {
    document.getElementById("wrtc-knock-header")?.remove();
  }

  _knockAction(guestId, action) {
    console.log('[WRTC] knock action sent  action=' + action + '  guestId=' + guestId);
    this._sendWS({ type: action, payload: { guestId } });
    document.getElementById("wrtc-knock-entry-" + guestId)?.remove();
    document.getElementById("wrtc-knock-popup-" + guestId)?.remove();
    const list = document.getElementById("wrtc-knock-list");
    if (list && !list.querySelectorAll(".wrtc-knock-entry").length) this._clearKnockHeader();
  }

  _updateGrid() {
    if (this._isLeaving) return;
    const grid      = document.getElementById("wrtc-grid");
    const waiting   = document.getElementById("wrtc-waiting");
    const localTile = document.getElementById("wrtc-local-tile");
    const stage     = document.getElementById("wrtc-stage");
    if (!grid || !localTile || !stage) return;

    const remoteCount = Object.keys(this._peerConnections).length;

    if (remoteCount === 0) {
      // Alone — move local tile OUT of the hidden grid directly into stage
      // (display:none on a parent hides fixed children too, so we must reparent)
      if (localTile.parentElement !== stage) stage.appendChild(localTile);
      localTile.style.position     = "fixed";
      localTile.style.bottom       = "96px";
      localTile.style.right        = "16px";
      localTile.style.width        = "200px";
      localTile.style.height       = "130px";
      localTile.style.zIndex       = "30";
      localTile.style.borderRadius = "12px";
      localTile.style.boxShadow    = "0 4px 24px rgba(0,0,0,.7)";
      localTile.style.border       = "2px solid rgba(255,255,255,.1)";
      grid.style.display           = "none";
      waiting.style.display        = "flex";
    } else {
      // Others present — move local tile back into the grid and reset styles
      if (localTile.parentElement !== grid) grid.prepend(localTile);
      localTile.style.cssText = "";
      grid.style.display      = "";
      waiting.style.display   = "none";
      // Make sure local tile is first in the grid
      if (grid.firstChild !== localTile) grid.prepend(localTile);

      const total = remoteCount + 1;
      let cols, rows;
      if (total === 2)      { cols = 2; rows = 1; }
      else if (total <= 4)  { cols = 2; rows = 2; }
      else if (total <= 6)  { cols = 3; rows = 2; }
      else if (total <= 9)  { cols = 3; rows = 3; }
      else                  { cols = 4; rows = Math.ceil(total / 4); }
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows    = `repeat(${rows}, minmax(0, 1fr))`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOGGER
  // ═══════════════════════════════════════════════════════════════════════
  _log(msg, data, level = "info") {
    const ts  = new Date().toTimeString().slice(0, 8);
    const out = data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[${ts}] ${out}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // getUserMedia
  // ═══════════════════════════════════════════════════════════════════════
  async _getUserMedia() {
    this._log("Requesting camera + microphone...");
    try {
      this._localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      this._log("getUserMedia OK", this._localStream.getTracks().map(t => `${t.kind}:${t.label}`), "ok");
      document.getElementById("wrtc-local-video").srcObject = this._localStream;
      this._setupAudioAnalyser("local", this._localStream);
    } catch (err) {
      this._log("getUserMedia FAILED: " + err.message, undefined, "error");
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WebSocket
  // ═══════════════════════════════════════════════════════════════════════
  _setupWebSocket() {
    const nameParam = this._myName ? `&name=${encodeURIComponent(this._myName)}` : "";
    const reconnectParam = this._isReconnecting ? "&reconnect=1" : "";
    const url = `${this.serverUrl}/ws/meetings/${this.roomName}?token=${this.token}${nameParam}${reconnectParam}`;
    this._log("Connecting WebSocket: " + url);
    this._ws = new WebSocket(url);
    this._ws.onopen    = ()  => {
      console.log('[WRTC] WS opened  room=' + this.roomName + '  name=' + this._myName);
      this._log("WS connected", undefined, "ok");
      this._setStatus("ok");
      // Tell everyone in the room our name
      this._sendWS({ type: "name", payload: { name: this._myName } });
    };
    this._ws.onclose   = (e) => {
      console.warn('[WRTC] WS closed  code=' + e.code + '  reason=' + e.reason);
      this._log(`WS closed — code=${e.code}`, undefined, "warn");
      this._setStatus("err");
    };
    this._ws.onerror   = (e) => {
      console.error('[WRTC] WS error', e);
      this._log("WS error", undefined, "error");
      this._setStatus("err");
    };
    this._ws.onmessage = (e) => this._handleMessages(e);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RTCPeerConnection factory
  // ═══════════════════════════════════════════════════════════════════════
  _setupPeerConnection(remoteUserId) {
    if (this._peerConnections[remoteUserId]) return this._peerConnections[remoteUserId];

    this._log(`Creating PeerConnection for ${remoteUserId}`);
    const pc = new RTCPeerConnection(this._iceConfig);

    this._localStream?.getTracks().forEach(track => pc.addTrack(track, this._localStream));

    pc.ontrack = (e) => {
      this._log(`Remote track from ${remoteUserId}: ${e.track.kind}`, undefined, "ok");
      this._addRemoteVideo(remoteUserId, e.streams[0]);
      if (e.track.kind === "audio") this._setupAudioAnalyser(remoteUserId, e.streams[0]);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) this._sendWS({ type: "ice-candidate", to: remoteUserId, payload: { candidate: e.candidate } });
    };

    pc.oniceconnectionstatechange = () => this._log(`ICE [${remoteUserId}]: ${pc.iceConnectionState}`);

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._log(`PC [${remoteUserId}]: ${s}`, undefined, s === "connected" ? "ok" : s === "failed" ? "error" : "info");
      if (s === "failed" || s === "disconnected") this._cleanupPeer(remoteUserId);
    };

    this._peerConnections[remoteUserId] = pc;
    return pc;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SIGNALING MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════════════
  async _handleMessages(event) {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { this._log("Non-JSON frame", undefined, "warn"); return; }

    const { type, from, payload } = msg;

    switch (type) {

      case "user-list":
        this._myUserId   = payload.myId || null;
        this._isHost     = payload.isHost || false;
        this._settings   = payload.settings || {};
        console.log('[WRTC] user-list received  room=' + this.roomName + '  myId=' + this._myUserId + '  isHost=' + this._isHost);
        // Only now is the user admitted — safe to persist name for reconnect
        sessionStorage.setItem('wrtc_name_' + this.roomName, this._myName || '');
        this._buildUIAfterAdmit(); // build full meeting UI now (first time only)
        this._applySettings();
        // Re-announce our name — the initial name message sent on WS open is discarded
        // during the knock-wait period, so existing participants wouldn't know it.
        this._sendWS({ type: "name", payload: { name: this._myName } });
        // Populate participants for users already in room (names arrive via "name" messages)
        payload.users.forEach(uid => { this._participants[uid] = this._displayName(uid); });
        this._renderParticipants();
        this._updateGrid();  // set initial solo/grid state
        break;

      case "join":
        if (payload.name) this._peerNames[payload.user_id] = payload.name;
        this._participants[payload.user_id] = this._displayName(payload.user_id);
        this._renderParticipants();
        // Tell the new joiner our name
        this._sendWS({ type: "name", payload: { name: this._myName } });
        // If we're presenting, re-announce so late joiner gets the layout
        if (this._isSharing) {
          setTimeout(() => this._sendWS({ type: "presenting", payload: { active: true } }), 800);
        }
        await this._initiateOffer(payload.user_id);
        break;

      case "host-changed": {
        const wasHost = this._isHost;
        this._isHost = (payload.hostId === this._myUserId);
        // Show/hide host controls; reset toggle state on role change
        ["wrtc-btn-muteall", "wrtc-btn-mutecams"].forEach(id => {
          const btn = document.getElementById(id);
          if (btn) btn.style.display = this._isHost ? "" : "none";
        });
        ["wrtc-btn-unmuteall", "wrtc-btn-unmutecams"].forEach(id => {
          const btn = document.getElementById(id);
          if (btn) btn.style.display = "none";
        });
        if (this._isHost) { this._allMicsMuted = false; this._allCamsMuted = false; }
        this._renderParticipants();
        if (!wasHost && this._isHost) this._toast("You are now the host");
        break;
      }

      case "meeting-ended":
        this._isLeaving = true;
        sessionStorage.removeItem("wrtc_name_" + this.roomName);
        sessionStorage.removeItem("meet_session_" + this.roomName);
        sessionStorage.removeItem("wrtc_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_cam_" + this.roomName);
        sessionStorage.removeItem("wrtc_start_" + this.roomName);
        this._ws?.close();
        this.parentNode.innerHTML =
          '<div style="position:fixed;inset:0;background:#202124;display:flex;flex-direction:column;' +
          'align-items:center;justify-content:center;gap:20px;font-family:sans-serif;">' +
          '<div style="font-size:56px;">📴</div>' +
          '<p style="color:#e8eaed;font-size:20px;font-weight:600;margin:0;">Meeting ended</p>' +
          '<p style="color:rgba(255,255,255,.5);font-size:14px;margin:0;">The host has ended this meeting.</p>' +
          '<button onclick="history.back()" style="padding:12px 32px;background:#1a73e8;color:#fff;' +
          'border:none;border-radius:10px;font-size:15px;font-weight:500;cursor:pointer;">Go Back</button>' +
          '</div>';
        break;

      case "leave": {
        const leaveName = this._displayName(payload.user_id);
        this._toast(`${leaveName} left the call`);
        this._renderSystemMsg(`${leaveName} left`);
        const presenterTile = document.getElementById(`wrtc-tile-${payload.user_id}`);
        if (presenterTile?.classList.contains("presenter")) this._clearPresenter();
        this._removeParticipant(payload.user_id);
        this._cleanupPeer(payload.user_id);
        break;
      }

      case "offer": {
        const pc = this._setupPeerConnection(from);
        if (pc.signalingState === "have-local-offer") {
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await this._flushCandidates(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._sendWS({ type: "answer", to: from, payload: { sdp: pc.localDescription } });
        break;
      }

      case "answer": {
        const pc = this._peerConnections[from];
        if (!pc || pc.signalingState !== "have-local-offer") break;
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await this._flushCandidates(from);
        break;
      }

      case "ice-candidate": {
        const pc = this._peerConnections[from];
        if (!pc || !payload.candidate) break;
        if (!pc.remoteDescription) {
          if (!this._pendingCandidates[from]) this._pendingCandidates[from] = [];
          this._pendingCandidates[from].push(new RTCIceCandidate(payload.candidate));
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        }
        break;
      }

      case "chat": {
        const name = this._displayName(from);
        this._renderMessage(name, payload.text, payload.ts || Date.now(), false);
        if (this._panelTab !== "chat") {
          this._unread++;
          const n = this._unread > 9 ? "9+" : this._unread;
          ["wrtc-chat-badge","wrtc-chat-badge-btn"].forEach(id => {
            const b = document.getElementById(id);
            if (b) { b.textContent = n; b.classList.add("show"); }
          });
          this._toast(`${name}: ${payload.text.slice(0, 40)}${payload.text.length > 40 ? "…" : ""}`);
        }
        break;
      }

      case "name": {
        this._peerNames[from] = payload.name;
        const tile = document.getElementById(`wrtc-tile-${from}`);
        if (tile) {
          const lbl = tile.querySelector(".wrtc-tile-label");
          if (lbl) lbl.textContent = payload.name;
          const av = document.querySelector(`#wrtc-avatar-${from} span`);
          if (av) av.textContent = payload.name.slice(0, 2).toUpperCase();
        }
        this._addParticipant(from, payload.name);
        this._renderSystemMsg(`${payload.name} joined`);
        break;
      }

      case "raise-hand": {
        const name   = this._displayName(from);
        const raised = payload.raised;
        if (raised) {
          this._raisedHands.add(from);
          this._toast(`${name} raised their hand ✋`);
          this._renderSystemMsg(`${name} raised their hand ✋`);
        } else {
          this._raisedHands.delete(from);
        }
        this._updateHandUI(from, raised);
        break;
      }

      case "presenting": {
        const name = this._displayName(from);
        if (payload.active) {
          this._toast(`${name} is presenting`);
          // Wait briefly for the tile to be ready, then expand it
          setTimeout(() => this._setPresenter(from), 300);
        } else {
          this._clearPresenter();
          this._toast(`${name} stopped presenting`);
        }
        break;
      }

      case "sfu:rtpCapabilities":
        console.log('[WRTC] sfu:rtpCapabilities received');
        this._log(`${type} (SFU stub)`);
        break;
      case "sfu:transportCreated":
        console.log('[WRTC] sfu:transportCreated  transportId=' + payload?.transportId);
        this._log(`${type} (SFU stub)`);
        break;
      case "sfu:transportConnected":
        console.log('[WRTC] sfu:transportConnected  transportId=' + payload?.transportId);
        this._log(`${type} (SFU stub)`);
        break;
      case "sfu:produced":
        console.log('[WRTC] sfu:produced  producerId=' + payload?.producerId);
        this._log(`${type} (SFU stub)`);
        break;
      case "sfu:newProducer":
        console.log('[WRTC] sfu:newProducer  producerId=' + payload?.producerId + '  peerId=' + payload?.peerId + '  kind=' + payload?.kind);
        this._log(`${type} (SFU stub)`);
        break;
      case "sfu:consumed":
        console.log('[WRTC] sfu:consumed  consumerId=' + payload?.consumerId + '  kind=' + payload?.kind);
        this._log(`${type} (SFU stub)`);
        break;
      case "sfu:consumerResumed":
        console.log('[WRTC] sfu:consumerResumed  consumerId=' + payload?.consumerId);
        this._log(`${type} (SFU stub)`);
        break;
      case "sfu:producers":
        console.log('[WRTC] sfu:producers  count=' + (payload?.producers?.length ?? 0));
        this._log(`${type} (SFU stub)`);
        break;

      case "error": this._log("Server error: " + payload.detail, undefined, "error"); break;

      case "mute-all":
        if (!this._micEnabled) break; // already off by participant — host mute doesn't own it
        this._hostMutedMic = true;
        this._micEnabled = false;
        this._localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
        document.getElementById("wrtc-btn-mic")?.classList.add("muted");
        if (document.getElementById("wrtc-ico-mic"))     document.getElementById("wrtc-ico-mic").style.display     = "none";
        if (document.getElementById("wrtc-ico-mic-off")) document.getElementById("wrtc-ico-mic-off").style.display = "";
        this._toast("Your microphone was muted by the host");
        break;

      case "unmute-all":
        if (!this._hostMutedMic) break; // host didn't mute me — don't force unmute
        this._hostMutedMic = false;
        if (this._micEnabled) break; // already on
        this._micEnabled = true;
        this._localStream?.getAudioTracks().forEach(t => { t.enabled = true; });
        document.getElementById("wrtc-btn-mic")?.classList.remove("muted");
        if (document.getElementById("wrtc-ico-mic"))     document.getElementById("wrtc-ico-mic").style.display     = "";
        if (document.getElementById("wrtc-ico-mic-off")) document.getElementById("wrtc-ico-mic-off").style.display = "none";
        this._toast("Your microphone was unmuted by the host");
        break;

      case "cam-mute-all":
        if (!this._camEnabled) break; // already off by participant — host mute doesn't own it
        this._hostMutedCam = true;
        this._camEnabled = false;
        this._localStream?.getVideoTracks().forEach(t => { t.enabled = false; });
        document.getElementById("wrtc-btn-cam")?.classList.add("muted");
        if (document.getElementById("wrtc-ico-cam"))     document.getElementById("wrtc-ico-cam").style.display     = "none";
        if (document.getElementById("wrtc-ico-cam-off")) document.getElementById("wrtc-ico-cam-off").style.display = "";
        if (document.getElementById("wrtc-local-video")) document.getElementById("wrtc-local-video").style.display = "none";
        if (document.getElementById("wrtc-pip-avatar"))  document.getElementById("wrtc-pip-avatar").style.display  = "flex";
        this._toast("Your camera was muted by the host");
        break;

      case "cam-unmute-all":
        if (!this._hostMutedCam) break;
        this._hostMutedCam = false;
        if (this._camEnabled) break;
        this._camEnabled = true;
        this._localStream?.getVideoTracks().forEach(t => { t.enabled = true; });
        document.getElementById("wrtc-btn-cam")?.classList.remove("muted");
        if (document.getElementById("wrtc-ico-cam"))     document.getElementById("wrtc-ico-cam").style.display     = "";
        if (document.getElementById("wrtc-ico-cam-off")) document.getElementById("wrtc-ico-cam-off").style.display = "none";
        if (document.getElementById("wrtc-local-video")) document.getElementById("wrtc-local-video").style.display = "block";
        if (document.getElementById("wrtc-pip-avatar"))  document.getElementById("wrtc-pip-avatar").style.display  = "none";
        this._toast("Your camera was unmuted by the host");
        break;

      case "you-were-kicked":
        this._isLeaving = true;
        this._ws?.close();
        // Clear session so rejoin goes through approval again, not reconnect bypass
        sessionStorage.removeItem('wrtc_name_' + this.roomName);
        sessionStorage.removeItem('meet_session_' + this.roomName);
        sessionStorage.removeItem('wrtc_mic_' + this.roomName);
        sessionStorage.removeItem('wrtc_cam_' + this.roomName);
        sessionStorage.removeItem('wrtc_start_' + this.roomName);
        this.parentNode.innerHTML =
          '<div style="position:fixed;inset:0;background:#202124;display:flex;flex-direction:column;'
          + 'align-items:center;justify-content:center;gap:20px;font-family:sans-serif;">'
          + '<div style="font-size:56px;">🚫</div>'
          + '<p style="color:#e8eaed;font-size:20px;font-weight:600;margin:0;">You were removed</p>'
          + '<p style="color:rgba(255,255,255,.5);font-size:14px;margin:0;">The host has removed you from this meeting.</p>'
          + '<button onclick="history.back()" style="padding:12px 32px;background:#1a73e8;color:#fff;'
          + 'border:none;border-radius:10px;font-size:15px;font-weight:500;cursor:pointer;">Go Back</button>'
          + '</div>';
        break;

      // ── Knock-to-join: guest is waiting for host approval ──────────────────
      case "knock-waiting": {
        console.log('[WRTC] knock-waiting received — host_present=' + payload.host_present);
        const el = document.getElementById("wrtc-approval-text");
        if (el) el.textContent = payload.host_present
          ? "Waiting for host to admit you…"
          : "Waiting for host to join the meeting…";
        break;
      }

      case "knock-denied": {
        this.parentNode.innerHTML =
          '<style>@keyframes wrtc-csp{to{transform:rotate(360deg)}}</style>' +
          '<div style="position:fixed;inset:0;background:#202124;display:flex;flex-direction:column;' +
          'align-items:center;justify-content:center;gap:20px;font-family:sans-serif;">' +
          '<div style="font-size:56px;">🚫</div>' +
          '<p style="color:#e8eaed;font-size:20px;font-weight:600;margin:0;">Request Rejected</p>' +
          '<p style="color:rgba(255,255,255,.5);font-size:14px;margin:0;text-align:center;max-width:320px;">' +
          (payload.reason || 'The admin has rejected your request to join this meeting.') + '</p>' +
          '<button onclick="history.back()" style="padding:12px 32px;background:#1a73e8;color:#fff;' +
          'border:none;border-radius:10px;font-size:15px;font-weight:500;cursor:pointer;">Go Back</button>' +
          '</div>';
        this._ws?.close();
        break;
      }

      // ── Knock-to-join: host sees approval request ──────────────────────────
      case "knock-request": {
        const { guestId, name: knockName } = payload;
        console.log('[WRTC] knock-request received  guestId=' + guestId + '  name=' + knockName);
        this._showKnockRequest(guestId, knockName);
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // P2P HELPERS
  // ═══════════════════════════════════════════════════════════════════════
  async _initiateOffer(remoteUserId) {
    const pc    = this._setupPeerConnection(remoteUserId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._sendWS({ type: "offer", to: remoteUserId, payload: { sdp: pc.localDescription } });
  }

  async _flushCandidates(userId) {
    const queued = this._pendingCandidates[userId];
    if (!queued?.length) return;
    for (const c of queued) await this._peerConnections[userId].addIceCandidate(c);
    delete this._pendingCandidates[userId];
  }

  _cleanupPeer(userId) {
    this._peerConnections[userId]?.close();
    delete this._peerConnections[userId];
    delete this._pendingCandidates[userId];
    delete this._analysers[userId];
    this._raisedHands.delete(userId);
    document.getElementById(`wrtc-tile-${userId}`)?.remove();
    this._updateUserCount(Object.keys(this._peerConnections).length + 1);
    this._updateGrid();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════
  _sendWS(msg) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      console.log('[WRTC] sendWS  type=' + msg.type + '  wsState=OPEN');
      this._ws.send(JSON.stringify(msg));
    } else {
      console.warn('[WRTC] sendWS DROPPED  type=' + msg.type + '  wsState=' + this._ws?.readyState);
      this._log("WS not open — dropped " + msg.type, undefined, "warn");
    }
  }

  _addRemoteVideo(userId, stream) {
    const existingVideo = document.getElementById(`wrtc-vid-${userId}`);
    if (existingVideo) { existingVideo.srcObject = stream; return; }

    const tile = document.createElement("div");
    tile.id        = `wrtc-tile-${userId}`;
    tile.className = "wrtc-tile";

    const video = document.createElement("video");
    video.id          = `wrtc-vid-${userId}`;
    video.autoplay    = true;
    video.playsInline = true;
    video.srcObject   = stream;

    // Avatar — hidden by default (camera is on). Shown only when video track is muted/disabled.
    const avatarWrap = document.createElement("div");
    avatarWrap.className = "wrtc-tile-avatar";
    avatarWrap.id        = `wrtc-avatar-${userId}`;
    const avatar = document.createElement("span");
    avatar.style.background = this._colorFromId(userId);
    avatar.textContent      = this._displayName(userId).slice(0, 2).toUpperCase() || "?";
    avatarWrap.appendChild(avatar);

    // Show avatar when remote video track goes silent (camera off)
    stream.getVideoTracks().forEach(track => {
      track.addEventListener("mute",   () => avatarWrap.classList.add("visible"));
      track.addEventListener("unmute", () => avatarWrap.classList.remove("visible"));
    });

    const label = document.createElement("div");
    label.className   = "wrtc-tile-label";
    label.textContent = this._displayName(userId);

    const badge = document.createElement("div");
    badge.className = "wrtc-presenter-badge";
    badge.textContent = "Presenting";

    const hand = document.createElement("div");
    hand.className = "wrtc-tile-hand";
    hand.id        = `wrtc-hand-${userId}`;
    hand.textContent = "✋";
    if (this._raisedHands.has(userId)) hand.classList.add("raised");

    tile.append(video, avatarWrap, badge, label, hand);
    document.getElementById("wrtc-grid").appendChild(tile);
    this._updateGrid();
  }

  _colorFromId(id) {
    const colors = ["#1a73e8","#0f9d58","#f4511e","#a142f4","#00897b","#e52592","#e37400","#1967d2"];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return colors[h % colors.length];
  }

  _displayName(userId) {
    if (!userId) return "Unknown";
    if (userId === "local") return this._myName || "You";
    return this._peerNames[userId] || ("User " + (userId.split("_").pop() || userId).slice(0, 6));
  }

  _updateUserCount(n) {
    const el = document.getElementById("wrtc-user-count");
    if (el) el.textContent = n;
  }

  _setStatus(cls) {
    const el = document.getElementById("wrtc-status");
    if (el) el.className = `wrtc-status-dot ${cls}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC: hangup
  // ═══════════════════════════════════════════════════════════════════════
  hangup() {
    // Host gets a leave modal to transfer host or end the meeting
    if (this._isHost && Object.keys(this._participants).length > 0) {
      this._showHostLeaveModal();
      return;
    }
    this._doLeave();
  }

  _showHostLeaveModal() {
    if (document.getElementById("wrtc-host-leave-modal")) return;
    const participants = Object.entries(this._participants);
    const opts = participants.map(([uid, name]) =>
      '<option value="' + uid + '">' + (name || "Guest") + "</option>"
    ).join("");

    const overlay = document.createElement("div");
    overlay.id = "wrtc-host-leave-modal";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.65);" +
      "display:flex;align-items:center;justify-content:center;font-family:sans-serif;";
    overlay.innerHTML =
      '<div style="background:#2d2e31;border-radius:16px;padding:32px;max-width:380px;width:90%;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.5);">' +
      '<h3 style="color:#e8eaed;font-size:18px;font-weight:600;margin:0 0 8px;">Leave meeting</h3>' +
      '<p style="color:#9aa0a6;font-size:13px;margin:0 0 20px;">You are the host. Choose what happens when you leave.</p>' +
      '<label style="color:#9aa0a6;font-size:12px;font-weight:500;display:block;margin-bottom:6px;">Transfer host to</label>' +
      '<select id="wrtc-transfer-select" style="width:100%;margin-bottom:20px;padding:10px 12px;' +
      'background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.15);border-radius:8px;' +
      'color:#e8eaed;font-size:14px;">' + opts + '</select>' +
      '<div style="display:flex;flex-direction:column;gap:10px;">' +
      '<button id="wrtc-transfer-btn" style="background:#1a73e8;color:#fff;border:none;border-radius:10px;' +
      'padding:12px;font-size:14px;font-weight:500;cursor:pointer;">Transfer &amp; Leave</button>' +
      '<button id="wrtc-end-meeting-btn" style="background:rgba(234,67,53,.12);color:#ea4335;' +
      'border:1px solid rgba(234,67,53,.35);border-radius:10px;padding:12px;font-size:14px;' +
      'font-weight:500;cursor:pointer;">End meeting for all</button>' +
      '<button id="wrtc-cancel-leave-btn" style="background:transparent;color:#9aa0a6;' +
      'border:1.5px solid rgba(255,255,255,.15);border-radius:10px;padding:12px;font-size:14px;' +
      'font-weight:500;cursor:pointer;">Cancel</button>' +
      '</div></div>';
    document.body.appendChild(overlay);

    document.getElementById("wrtc-transfer-btn").addEventListener("click", () => {
      const uid = document.getElementById("wrtc-transfer-select").value;
      if (uid) this._sendWS({ type: "transfer-host", payload: { userId: uid } });
      overlay.remove();
      this._doLeave();
    });
    document.getElementById("wrtc-end-meeting-btn").addEventListener("click", () => {
      this._sendWS({ type: "end-meeting", payload: {} });
      overlay.remove();
      this._doLeave();
    });
    document.getElementById("wrtc-cancel-leave-btn").addEventListener("click", () => overlay.remove());
  }

  _doLeave() {
    this._isLeaving = true;
    // Replace parentNode content with leaving overlay so it's removed when React navigates
    this.parentNode.innerHTML =
      '<style>@keyframes wrtc-spin2{to{transform:rotate(360deg)}}</style>' +
      '<div style="position:fixed;inset:0;background:#202124;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:16px;font-family:sans-serif;">' +
      '<div style="width:48px;height:48px;border:4px solid rgba(255,255,255,.1);' +
      'border-top:4px solid #ea4335;border-radius:50%;animation:wrtc-spin2 1s linear infinite;"></div>' +
      '<p style="color:#e8eaed;font-size:16px;font-weight:500;margin:0;">Leaving…</p>' +
      '</div>';
    sessionStorage.removeItem('wrtc_name_' + this.roomName);
    sessionStorage.removeItem('wrtc_mic_' + this.roomName);
    sessionStorage.removeItem('wrtc_cam_' + this.roomName);
    sessionStorage.removeItem('wrtc_start_' + this.roomName);
    this._sendWS({ type: "leave", payload: {} });
    Object.keys(this._peerConnections).forEach(id => this._cleanupPeer(id));
    this._ws?.close();
    this._localStream?.getTracks().forEach(t => t.stop());
    this._shareStream?.getTracks().forEach(t => t.stop());
    if (this._isRecording) this._mediaRecorder?.stop();
    clearInterval(this._clockTimer);
    clearInterval(this._speakerTimer);
    if (this._audioCtx) { this._audioCtx.close(); this._audioCtx = null; }
    const lv = document.getElementById("wrtc-local-video"); if (lv) lv.srcObject = null;
    this._setStatus("err");
    this._toast("You left the call");
    if (typeof this._onLeave === 'function') {
      setTimeout(() => this._onLeave(), 1200);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════
  // _init is not used directly — entry point is _buildLobby → _joinMeeting
}

// Expose to global scope so it can be used by dynamically loaded scripts
window.WebRTCMeetingAPI = WebRTCMeetingAPI;
})();
