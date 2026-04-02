  // ═══════════════════════════════════════════════════════════════════════════
// WebRTCMeetingAPI — embeddable WebRTC meeting SDK
// ═══════════════════════════════════════════════════════════════════════════
(function () {
if (window.WebRTCMeetingAPI) return; // already loaded — skip re-declaration
class WebRTCMeetingAPI {

  constructor({ serverUrl, roomName, token = "", hostToken = "", guestToken = "", shareUrl = "", embedToken = "", reconnect = false, parentNode, onLeave = null, logoUrl = "" }) {
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
    // Resolve relative logo paths against the backend origin (from script tag)
    if (logoUrl && logoUrl.startsWith('/')) {
      this._logoUrl = this._httpBase + logoUrl;
    } else {
      this._logoUrl = logoUrl || "";
    }
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
    this._isSharing       = false;
    this._shareStream     = null;
    this._presenterUserId = null; // user_id of whoever is currently sharing screen
    this._focusTileId     = null;

    // Recording
    this._isRecording   = false;
    this._mediaRecorder = null;
    this._recordChunks  = [];

    // Chat

    this._chatOpen       = false;
    this._unread         = 0;
    this._privateUnread  = 0;
    this._chatRestoredFromSession = false;
    this._bgFilter          = 'none';
    this._filterCanvas      = null;
    this._filterCtx         = null;
    this._filterStream      = null;
    this._filterAnimId      = null;
    this._filterSrcVid      = null;
    this._filterPanelOpen   = false;
    this._selfieSegmentation = null;
    this._blurCanvas        = null;
    this._blurCtx           = null;
    this._tmpCanvas         = null;
    this._tmpCtx            = null;
    this._maskCanvas        = null;
    this._maskCtx           = null;
    this._segCanvas         = null;
    this._segCtx            = null;
    this._hasMask           = false;
    this._segPending        = false;
    this._bgImageEl         = null;
    this._bgImages          = {};   // cache: bgName → HTMLImageElement
    this._segResults        = null;
    this._chatSubTab     = "public"; // "public" | "private"
    this._popupTimer     = null;
    this._privateReplyTo = null;    // { userId, name } — host's active reply target

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
    this._camStates     = {};   // userId → boolean (true=on, false=off)
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
    this.parentNode.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#13151c 0%,#1a1d26 100%);';
    this.parentNode.innerHTML = '<div style="width:36px;height:36px;border:3px solid rgba(255,255,255,.08);border-top-color:#4d94ff;border-radius:50%;animation:wrtc-spin .8s linear infinite"></div><style>@keyframes wrtc-spin{to{transform:rotate(360deg)}}</style>';

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
      .ep{position:fixed;inset:0;background:linear-gradient(135deg,#13151c 0%,#1a1d26 60%,#1c1f2e 100%);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e8eaed;display:flex;flex-direction:column;align-items:center;padding:40px 16px;overflow-y:auto}
      .ep-hdr{text-align:center;margin-bottom:32px}.ep-hdr h2{font-size:26px;font-weight:700}.ep-hdr p{color:#9aa0a6;font-size:14px;margin-top:6px}
      .ep-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:24px;width:100%;max-width:560px;margin-bottom:16px;box-shadow:0 8px 32px rgba(0,0,0,.3)}
      .ep-card h3{font-size:12px;font-weight:600;color:#9aa0a6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:16px}
      .ep-input{background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;color:#e8eaed;font-size:15px;width:100%;outline:none}
      .ep-input:focus{border-color:#1a73e8}.ep-input::placeholder{color:#5f6368}
      .ep-btn{background:linear-gradient(135deg,#1a73e8,#4d94ff);color:#fff;border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:600;cursor:pointer;width:100%;margin-top:12px;transition:opacity .15s;box-shadow:0 4px 20px rgba(26,115,232,.4)}
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
      self._embedTokenSaved = self._embedToken; // save for recording upload
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
      '<div style="position:fixed;inset:0;background:linear-gradient(135deg,#13151c 0%,#1a1d26 100%);display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">' +
      '<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:48px 56px;display:flex;flex-direction:column;align-items:center;gap:20px;box-shadow:0 24px 64px rgba(0,0,0,.5);">' +
      '<div style="width:52px;height:52px;border:3px solid rgba(255,255,255,.08);' +
      'border-top-color:#4d94ff;border-radius:50%;animation:wrtc-spin .9s linear infinite;"></div>' +
      '<div style="text-align:center;">' +
      '<p style="color:#e8eaed;font-size:17px;font-weight:600;margin:0 0 6px;">Reconnecting…</p>' +
      '<p style="color:rgba(255,255,255,.4);font-size:13px;margin:0;">Please wait</p>' +
      '</div></div>' +
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
      .catch(() => navigator.mediaDevices.getUserMedia({ video: true })
        // video-only fallback (mic was denied/unavailable)
        .then(stream => {
          this._localStream = stream;
          this._setupAudioAnalyser("local", stream);
          this._micEnabled = false;
          const savedCam = sessionStorage.getItem('wrtc_cam_' + this.roomName);
          if (savedCam === '0') {
            this._camEnabled = false;
            stream.getVideoTracks().forEach(t => { t.enabled = false; });
          }
        })
        .catch(() => {
          // audio-only fallback (camera was denied/unavailable)
          this._camEnabled = false;
          return navigator.mediaDevices.getUserMedia({ audio: true })
            .then(audioStream => {
              this._localStream = audioStream;
              this._setupAudioAnalyser("local", audioStream);
            })
            .catch(() => { this._localStream = null; this._micEnabled = false; });
        })
      )
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
        background:linear-gradient(135deg,#13151c 0%,#1a1d26 60%,#1c1f2e 100%);color:#e8eaed;
        height:100%;display:flex;align-items:center;justify-content:center;
        padding:24px;
      }
      .wrtc-lobby-card{
        display:flex;gap:0;border-radius:20px;overflow:hidden;
        background:#1e2130;
        border:1px solid rgba(255,255,255,.07);
        box-shadow:0 24px 64px rgba(0,0,0,.65),0 2px 8px rgba(0,0,0,.3);
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
        flex-direction:column;gap:12px;background:#0e1018;
        color:rgba(255,255,255,.4);font-size:14px;
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
        background:rgba(255,255,255,.02);
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
        background:linear-gradient(135deg,#1a73e8,#4d94ff);color:#fff;font-size:15px;font-weight:600;
        font-family:inherit;cursor:pointer;
        transition:opacity .15s,transform .1s,box-shadow .15s;
        box-shadow:0 4px 20px rgba(26,115,232,.45);
      }
      .wrtc-join-btn:hover{opacity:.9;transform:translateY(-1px);box-shadow:0 6px 24px rgba(26,115,232,.55)}
      .wrtc-join-btn:active{transform:translateY(0);opacity:1}
      .wrtc-join-btn:disabled{background:#2a2d38;box-shadow:none;cursor:not-allowed;transform:none;opacity:.6}
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
      const hasAudio = (this._localStream?.getAudioTracks().length ?? 0) > 0;
      if (!this._micEnabled && !hasAudio) {
        // No audio track yet — ask for mic permission on-demand
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(stream => {
            const track = stream.getAudioTracks()[0];
            if (!this._localStream) { this._localStream = stream; }
            else { this._localStream.addTrack(track); }
            this._micEnabled = true;
            document.getElementById("wrtc-lobby-mic").classList.remove("muted");
            document.getElementById("wrtc-lobby-mic-on").style.display  = "";
            document.getElementById("wrtc-lobby-mic-off").style.display = "none";
          })
          .catch(() => { /* permission denied — stay mic-off */ });
        return;
      }
      this._micEnabled = !this._micEnabled;
      this._localStream?.getAudioTracks().forEach(t => { t.enabled = this._micEnabled; });
      document.getElementById("wrtc-lobby-mic").classList.toggle("muted", !this._micEnabled);
      document.getElementById("wrtc-lobby-mic-on").style.display  = this._micEnabled ? "" : "none";
      document.getElementById("wrtc-lobby-mic-off").style.display = this._micEnabled ? "none" : "";
    });
    document.getElementById("wrtc-lobby-cam").addEventListener("click", () => {
      const hasVideo = (this._localStream?.getVideoTracks().length ?? 0) > 0;
      if (!this._camEnabled && !hasVideo) {
        // No video track yet — ask for camera permission now
        navigator.mediaDevices.getUserMedia({ video: true })
          .then(stream => {
            const track = stream.getVideoTracks()[0];
            if (!this._localStream) { this._localStream = stream; }
            else { this._localStream.addTrack(track); }
            document.getElementById("wrtc-lobby-video").srcObject        = this._localStream;
            this._camEnabled = true;
            document.getElementById("wrtc-lobby-cam").classList.remove("muted");
            document.getElementById("wrtc-lobby-cam-on").style.display       = "";
            document.getElementById("wrtc-lobby-cam-icon-off").style.display = "none";
            document.getElementById("wrtc-lobby-video").style.display        = "block";
            document.getElementById("wrtc-lobby-cam-off").style.display      = "none";
          })
          .catch(() => { /* permission denied — stay cam-off */ });
        return;
      }
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
    } catch (_) {
      // Try video-only (mic may be denied/unavailable)
      try {
        this._localStream = await navigator.mediaDevices.getUserMedia({ video: true });
        document.getElementById("wrtc-lobby-video").srcObject = this._localStream;
        this._micEnabled = false;
        document.getElementById("wrtc-lobby-mic").classList.add("muted");
        document.getElementById("wrtc-lobby-mic-on").style.display  = "none";
        document.getElementById("wrtc-lobby-mic-off").style.display = "";
      } catch (_2) {
        // Camera also unavailable — try audio-only
        document.getElementById("wrtc-lobby-cam-off").style.display = "flex";
        document.getElementById("wrtc-lobby-video").style.display   = "none";
        this._camEnabled = false;
        try {
          this._localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (_3) {
          this._localStream = null;
          this._micEnabled  = false;
        }
      }
    }
  }

  _joinMeeting(name) {
    this._myName = name;
    // NOTE: do NOT save wrtc_name_ here — only save after admission (user-list received).
    // Saving here would allow a pending guest to bypass knock-approval on refresh.
    // Show a lightweight waiting screen; full UI is built only after host admits us
    this.parentNode.innerHTML =
      '<style>@keyframes wrtc-csp{to{transform:rotate(360deg)}}</style>' +
      '<div style="position:fixed;inset:0;background:linear-gradient(135deg,#13151c 0%,#1a1d26 100%);display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">' +
      '<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:48px 56px;display:flex;flex-direction:column;align-items:center;gap:20px;box-shadow:0 24px 64px rgba(0,0,0,.5);">' +
      '<div style="width:52px;height:52px;border:3px solid rgba(255,255,255,.08);' +
      'border-top-color:#4d94ff;border-radius:50%;animation:wrtc-csp .9s linear infinite;"></div>' +
      '<div style="text-align:center;">' +
      '<p id="wrtc-approval-text" style="color:#e8eaed;font-size:17px;font-weight:600;margin:0 0 6px;">Connecting…</p>' +
      '<p style="color:rgba(255,255,255,.4);font-size:13px;margin:0;">Please wait</p>' +
      '</div></div>' +
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
    this._restoreChatHistory();
  }

  _restoreChatHistory() {
    try {
      const key = 'wrtc_chat_' + this.roomName;
      const stored = JSON.parse(sessionStorage.getItem(key) || '[]');
      if (stored.length > 0) {
        this._chatRestoredFromSession = true;
        stored.forEach(({ name, text, ts, isMine, container, isPrivate }) => {
          this._renderMessage(name, text, ts, isMine, container, isPrivate, null);
        });
      }
    } catch(_) {}
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

    // Screen share — hide menu item if disabled
    const shareMenuItem = document.getElementById("wrtc-more-share");
    if (!isHost && s.allow_screen_share === false) {
      if (shareMenuItem) shareMenuItem.style.display = "none";
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
        background:linear-gradient(160deg,#13151c 0%,#181b24 50%,#14161e 100%);color:#e8eaed;
        height:100%;display:flex;flex-direction:column;
        position:relative;overflow:hidden;user-select:none;
      }

      /* ── TOPBAR ── */
      .wrtc-top{
        position:absolute;top:0;left:0;right:0;z-index:30;
        display:flex;align-items:center;justify-content:space-between;
        padding:14px 20px;
        background:linear-gradient(to bottom,rgba(0,0,0,.5) 0%,transparent 100%);
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
        padding:68px 0 108px;overflow:hidden;transition:padding-right .25s;
      }

      /* ── BRANDING LOGO ── */
      .wrtc-logo{
        position:fixed;top:74px;left:16px;z-index:50;
        max-height:52px;max-width:160px;
        object-fit:contain;border-radius:6px;
        opacity:0.9;pointer-events:none;
        filter:drop-shadow(0 1px 4px rgba(0,0,0,.5));
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
        position:relative;border-radius:16px;overflow:hidden;
        background:#1a1d28;width:100%;height:100%;min-height:0;
        transition:box-shadow .3s,transform .3s;
        box-shadow:0 4px 24px rgba(0,0,0,.35);
      }
      .wrtc-tile video{
        width:100%;height:100%;object-fit:cover;display:block;background:#0d0f14;
      }
      #wrtc-local-video{transform:scaleX(-1)}
      .wrtc-tile.speaking{
        box-shadow:0 0 0 3px #4d94ff,0 0 0 7px rgba(77,148,255,.15),0 8px 40px rgba(77,148,255,.25);
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

      /* ── FOCUS MODE ── */
      .wrtc-focus-wrap{
        flex:1;display:none;flex-direction:row;gap:6px;padding:6px;overflow:hidden;
      }
      .wrtc-focus-main{
        flex:1;position:relative;border-radius:16px;overflow:hidden;min-width:0;
      }
      .wrtc-focus-main>.wrtc-tile{
        width:100% !important;height:100% !important;
        border-radius:16px;cursor:default;
      }
      .wrtc-focus-exit{
        position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:20;
        background:rgba(0,0,0,.65);backdrop-filter:blur(6px);
        border:1px solid rgba(255,255,255,.22);color:#fff;
        font-size:12px;font-weight:600;padding:5px 16px;border-radius:20px;
        cursor:pointer;display:flex;align-items:center;gap:6px;
        transition:background .15s;white-space:nowrap;letter-spacing:.2px;
      }
      .wrtc-focus-exit:hover{background:rgba(200,40,40,.85);}
      .wrtc-focus-panel{
        width:28%;display:flex;flex-direction:column;gap:6px;overflow:hidden;flex-shrink:0;
      }
      .wrtc-focus-tiles{
        display:flex;flex-direction:column;gap:6px;flex:1;overflow:hidden;
      }
      .wrtc-focus-tiles>.wrtc-tile{
        flex:1;min-height:0;cursor:pointer;border-radius:12px;
        transition:box-shadow .2s,transform .15s;
      }
      .wrtc-focus-tiles>.wrtc-tile:hover{
        transform:scale(1.025);
        box-shadow:0 4px 24px rgba(108,99,255,.45);
      }
      .wrtc-focus-more{
        background:rgba(108,99,255,.12);border:1px solid rgba(108,99,255,.3);
        border-radius:12px;color:#a09bff;font-size:13px;font-weight:600;
        text-align:center;padding:12px 8px;cursor:pointer;flex-shrink:0;
        transition:background .15s;
      }
      .wrtc-focus-more:hover{background:rgba(108,99,255,.22);}
      .wrtc-tile{cursor:pointer;}

      /* ── PRESENTATION MODE ── */
      .wrtc-stage.presenting{
        flex-direction:row;
      }
      .wrtc-stage.presenting .wrtc-grid{
        flex:1;position:relative;min-width:0;
      }
      .wrtc-tile.presenter{
        position:absolute;
        top:0;left:0;right:0;bottom:0;
        width:100% !important;height:100% !important;
        z-index:8;border-radius:14px;
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
      /* right-side participant strip during presentation */
      .wrtc-thumbs{
        display:none;flex-direction:column;
        gap:8px;width:220px;flex-shrink:0;
        overflow-y:auto;overflow-x:hidden;
        padding:8px 6px;
        background:rgba(0,0,0,.18);
        border-left:1px solid rgba(255,255,255,.06);
        scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent;
      }
      .wrtc-thumbs::-webkit-scrollbar{width:4px}
      .wrtc-thumbs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px}
      .wrtc-thumb-tile{
        width:100%;aspect-ratio:16/9;border-radius:10px;overflow:hidden;
        background:#1a1d28;position:relative;flex-shrink:0;
        border:1px solid rgba(255,255,255,.1);
        box-shadow:0 4px 16px rgba(0,0,0,.4);
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
        position:absolute;inset:0;z-index:20;background:transparent;
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
        background:#1a1d28;
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
        position:absolute;bottom:24px;left:50%;transform:translateX(-50%);z-index:30;
        display:flex;align-items:center;justify-content:center;gap:6px;
        padding:10px 16px;
        background:rgba(18,20,28,0.88);
        backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
        border-radius:56px;
        border:1px solid rgba(255,255,255,.09);
        box-shadow:0 8px 40px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.06);
        white-space:nowrap;
      }
      .wrtc-btn{
        width:46px;height:46px;border-radius:50%;border:none;
        background:rgba(255,255,255,.09);color:#e8eaed;cursor:pointer;
        display:flex;align-items:center;justify-content:center;position:relative;
        transition:background .15s,transform .12s,box-shadow .15s;flex-shrink:0;
        outline:none;
      }
      .wrtc-btn:hover{background:rgba(255,255,255,.17);transform:scale(1.07);box-shadow:0 4px 12px rgba(0,0,0,.3)}
      .wrtc-btn:active{transform:scale(.91)}
      .wrtc-btn.muted,.wrtc-btn.active-feature{background:rgba(234,67,53,.9);color:#fff;box-shadow:0 2px 12px rgba(234,67,53,.4)}
      .wrtc-btn.muted:hover,.wrtc-btn.active-feature:hover{background:#ea4335}
      .wrtc-btn.on-air{background:rgba(26,115,232,.9);color:#fff;box-shadow:0 2px 12px rgba(26,115,232,.4)}
      .wrtc-btn.on-air:hover{background:#1a73e8}
      .wrtc-btn-badge{
        position:absolute;top:1px;right:1px;
        width:16px;height:16px;border-radius:50%;
        background:#ea4335;color:#fff;font-size:9px;font-weight:700;
        display:none;align-items:center;justify-content:center;
        border:2px solid rgba(18,20,28,0.88);
      }
      .wrtc-btn-badge.show{display:flex}
      .wrtc-btn-label{
        position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);
        font-size:10px;color:rgba(255,255,255,.5);white-space:nowrap;
        pointer-events:none;
      }
      .wrtc-btn-leave{
        width:auto;border-radius:28px;padding:0 20px;gap:7px;
        background:rgba(234,67,53,.9);color:#fff;font-size:14px;font-weight:600;
        box-shadow:0 2px 12px rgba(234,67,53,.35);
      }
      .wrtc-btn-leave:hover{background:#ea4335;transform:scale(1.04)}
      .wrtc-divider{width:1px;height:28px;background:rgba(255,255,255,.12);flex-shrink:0;margin:0 2px}

      /* ── 3-DOT MORE MENU ── */
      .wrtc-more-menu{
        position:fixed;
        background:#1e2024;border:1px solid rgba(255,255,255,.13);border-radius:12px;
        padding:6px;z-index:40;min-width:200px;
        box-shadow:0 8px 32px rgba(0,0,0,.55);
        flex-direction:column;gap:2px;
      }
      .wrtc-more-item{
        display:flex;align-items:center;gap:12px;padding:10px 14px;
        border-radius:8px;cursor:pointer;color:#e8eaed;font-size:14px;
        transition:background .12s;
      }
      .wrtc-more-item:hover{background:rgba(255,255,255,.08)}
      .wrtc-more-item.on-air{color:#ea4335}
      .wrtc-more-item.on-air svg{opacity:1}
      .wrtc-more-item svg{flex-shrink:0;opacity:.8}
      .wrtc-more-divider{height:1px;background:rgba(255,255,255,.1);margin:4px 0}
      .wrtc-menu-badge{
        background:#ea4335;color:#fff;font-size:10px;font-weight:700;
        border-radius:10px;min-width:18px;height:18px;padding:0 5px;
        display:flex;align-items:center;justify-content:center;
      }

      /* ── SIDE PANEL (People + Chat) ── */
      .wrtc-side-panel{
        position:absolute;top:0;right:0;bottom:0;width:340px;z-index:32;
        background:rgba(18,20,28,0.95);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
        border-left:1px solid rgba(255,255,255,.07);
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

      /* ── CHAT SUB-TABS (host only) ── */
      .wrtc-chat-subtabs{
        display:flex;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;
      }
      .wrtc-chat-subtab{
        flex:1;background:none;border:none;color:rgba(255,255,255,.5);
        font-size:12px;font-weight:500;padding:8px 4px;cursor:pointer;
        position:relative;transition:color .15s;font-family:inherit;
        border-bottom:2px solid transparent;margin-bottom:-1px;
      }
      .wrtc-chat-subtab:hover{color:rgba(255,255,255,.8)}
      .wrtc-chat-subtab.active{color:#8ab4f8;border-bottom-color:#8ab4f8}
      .wrtc-subtab-badge{
        display:inline-flex;align-items:center;justify-content:center;
        background:#ea4335;color:#fff;font-size:9px;font-weight:700;
        border-radius:10px;min-width:16px;height:16px;padding:0 4px;
        margin-left:5px;vertical-align:middle;
        opacity:0;transition:opacity .15s;
      }
      .wrtc-subtab-badge.show{opacity:1}

      /* ── SEND MENU (guest) ── */
      .wrtc-chat-footer{position:relative}
      .wrtc-send-menu{
        position:absolute;bottom:calc(100% + 6px);right:0;
        background:#3c4043;border:1px solid rgba(255,255,255,.15);
        border-radius:10px;overflow:hidden;z-index:20;
        box-shadow:0 4px 16px rgba(0,0,0,.5);min-width:200px;
      }
      .wrtc-send-opt{
        display:flex;align-items:center;gap:10px;width:100%;
        background:none;border:none;color:#e8eaed;font-size:13px;
        padding:11px 16px;cursor:pointer;text-align:left;font-family:inherit;
        transition:background .12s;
      }
      .wrtc-send-opt:hover{background:rgba(255,255,255,.08)}
      .wrtc-send-opt svg{flex-shrink:0;opacity:.7}

      /* ── REPLY BUTTON on private messages ── */
      .wrtc-msg-reply{
        background:none;border:1px solid rgba(138,180,248,.35);border-radius:6px;
        color:#8ab4f8;font-size:11px;font-family:inherit;padding:2px 8px;
        cursor:pointer;margin-top:4px;transition:background .12s;
      }
      .wrtc-msg-reply:hover{background:rgba(138,180,248,.12)}
      /* ── Reply-to banner above footer ── */
      .wrtc-reply-banner{
        display:flex;align-items:center;gap:8px;
        padding:6px 14px;background:rgba(138,180,248,.1);
        border-top:1px solid rgba(138,180,248,.2);font-size:12px;color:#8ab4f8;
        flex-shrink:0;
      }
      .wrtc-reply-banner-text{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .wrtc-reply-cancel{
        background:none;border:none;color:rgba(255,255,255,.4);cursor:pointer;
        padding:0;font-size:14px;line-height:1;flex-shrink:0;
      }
      .wrtc-reply-cancel:hover{color:#e8eaed}

      /* ── PRIVATE "To:" recipient row (host only) ── */
      .wrtc-to-row{
        display:flex;align-items:center;gap:8px;
        padding:6px 14px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0;
      }
      .wrtc-to-label{font-size:11px;color:rgba(255,255,255,.4);flex-shrink:0}
      .wrtc-to-select{
        flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
        border-radius:8px;padding:5px 10px;color:#e8eaed;font-size:12px;
        font-family:inherit;outline:none;cursor:pointer;
        transition:border-color .15s;
      }
      .wrtc-to-select:focus{border-color:rgba(138,180,248,.5)}
      .wrtc-to-select option{background:#2d2e31;color:#e8eaed}

      /* ── HOST MSG POPUP ── */
      .wrtc-msg-popup{
        position:absolute;bottom:80px;right:16px;
        background:#292b2e;border:1px solid rgba(138,180,248,.3);
        border-left:3px solid #1a73e8;border-radius:10px;
        padding:12px 16px;max-width:280px;z-index:60;
        box-shadow:0 4px 20px rgba(0,0,0,.5);
        animation:wrtc-pop-in .2s ease;
      }
      @keyframes wrtc-pop-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .wrtc-msg-popup-from{font-size:10px;color:#fbbc05;font-weight:600;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px}
      .wrtc-msg-popup-name{font-size:12px;font-weight:600;color:#8ab4f8;margin-bottom:6px}
      .wrtc-msg-popup-text{font-size:13px;color:#e8eaed;word-break:break-word;line-height:1.4}
      .wrtc-msg-popup-close{
        position:absolute;top:8px;right:8px;background:none;border:none;
        color:rgba(255,255,255,.4);cursor:pointer;padding:2px;font-size:14px;line-height:1;
      }
      .wrtc-msg-popup-close:hover{color:#e8eaed}

      /* ── PRIVATE MSG LABEL ── */
      .wrtc-msg-private-label{
        font-size:10px;color:#fbbc05;font-weight:600;margin-bottom:2px;
        text-transform:uppercase;letter-spacing:.4px;
      }

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

      /* ── VIRTUAL BACKGROUND ── */
      .wrtc-btn.vbg-active{background:rgba(138,180,248,.18);color:#8ab4f8}
      .wrtc-vbg-overlay{
        position:absolute;inset:0;z-index:300;
        background:rgba(0,0,0,.55);backdrop-filter:blur(3px);
        display:flex;align-items:flex-end;justify-content:center;
      }
      .wrtc-vbg-panel{
        background:#2d2e31;border-radius:16px 16px 0 0;
        padding:20px 20px 24px;width:100%;max-width:560px;
        box-shadow:0 -8px 32px rgba(0,0,0,.6);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        animation:wrtc-vbg-up .22s cubic-bezier(.4,0,.2,1);
      }
      @keyframes wrtc-vbg-up{from{transform:translateY(100%)}to{transform:translateY(0)}}
      .wrtc-vbg-header{
        display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;
      }
      .wrtc-vbg-title{font-size:15px;font-weight:600;color:#e8eaed}
      .wrtc-vbg-close{
        background:none;border:none;color:rgba(255,255,255,.5);cursor:pointer;
        font-size:20px;line-height:1;padding:0 4px;border-radius:6px;
        transition:color .15s;
      }
      .wrtc-vbg-close:hover{color:#e8eaed}
      .wrtc-vbg-grid{
        display:grid;grid-template-columns:repeat(5,1fr);gap:10px;
      }
      .wrtc-vbg-opt{
        display:flex;flex-direction:column;align-items:center;gap:6px;
        cursor:pointer;
      }
      .wrtc-vbg-thumb{
        width:100%;aspect-ratio:16/9;border-radius:10px;
        border:2px solid transparent;
        transition:border-color .15s,transform .12s;
        object-fit:cover;display:block;
      }
      img.wrtc-vbg-thumb{background:#3c4043}
      .wrtc-vbg-thumb:hover,.wrtc-vbg-none-icon:hover{transform:scale(1.05)}
      .wrtc-vbg-opt.active .wrtc-vbg-thumb,
      .wrtc-vbg-opt.active .wrtc-vbg-none-icon{border-color:#8ab4f8}
      .wrtc-vbg-label{font-size:11px;color:rgba(255,255,255,.55);text-align:center}
      .wrtc-vbg-opt.active .wrtc-vbg-label{color:#8ab4f8;font-weight:600}
      .wrtc-vbg-none-icon{
        width:100%;aspect-ratio:16/9;border-radius:10px;
        border:2px solid rgba(255,255,255,.15);background:#1e1f22;
        display:flex;align-items:center;justify-content:center;
        font-size:22px;color:rgba(255,255,255,.3);
        transition:border-color .15s,transform .12s;box-sizing:border-box;
      }
      .wrtc-vbg-blur-thumb{
        width:100%;aspect-ratio:16/9;border-radius:10px;
        border:2px solid transparent;
        background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
        display:flex;align-items:center;justify-content:center;
        transition:border-color .15s,transform .12s;box-sizing:border-box;
      }
      .wrtc-vbg-opt.active .wrtc-vbg-blur-thumb{border-color:#8ab4f8}
      .wrtc-vbg-blur-thumb:hover{transform:scale(1.05)}
      .wrtc-vbg-status{
        margin-top:14px;font-size:12px;color:rgba(255,255,255,.4);
        text-align:center;min-height:16px;
      }
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
        <!-- Focus mode layout — shown instead of grid when a tile is focused -->
        <div class="wrtc-focus-wrap" id="wrtc-focus-wrap" style="display:none">
          <div class="wrtc-focus-main" id="wrtc-focus-main">
            <div class="wrtc-focus-exit" id="wrtc-focus-exit">&#x2715; Exit focus</div>
          </div>
          <div class="wrtc-focus-panel" id="wrtc-focus-panel">
            <div class="wrtc-focus-tiles" id="wrtc-focus-tiles"></div>
            <div class="wrtc-focus-more" id="wrtc-focus-more" style="display:none"></div>
          </div>
        </div>
        <!-- Waiting overlay — full-screen, shown when alone in room -->
        <div class="wrtc-waiting" id="wrtc-waiting">
          <div class="wrtc-waiting-ring"></div>
          <p>Waiting for others to join…</p>
          <small>Share the room link to invite participants</small>
          <small style="opacity:.35;font-size:11px">Room: <strong id="wrtc-room-hint"></strong></small>
        </div>
      <!-- Participant strip — right-side panel, visible during presentation -->
      <div class="wrtc-thumbs" id="wrtc-thumbs"></div>
      </div>

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
            <!-- Sub-tabs: Everyone / Private (host only, hidden until isHost known) -->
            <div class="wrtc-chat-subtabs" id="wrtc-chat-subtabs" style="display:none">
              <button class="wrtc-chat-subtab active" id="wrtc-subtab-public">Everyone</button>
              <button class="wrtc-chat-subtab" id="wrtc-subtab-private">
                Private<span class="wrtc-subtab-badge" id="wrtc-private-badge"></span>
              </button>
            </div>
            <!-- Public messages -->
            <div class="wrtc-chat-msgs" id="wrtc-chat-msgs">
              <div class="wrtc-chat-empty" id="wrtc-chat-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="rgba(255,255,255,.2)">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
                </svg>
                <p>Messages are visible only to people in this call</p>
              </div>
            </div>
            <!-- Private messages (host receives from guests) -->
            <div class="wrtc-chat-msgs" id="wrtc-chat-msgs-private" style="display:none">
              <div class="wrtc-chat-empty" id="wrtc-chat-private-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="rgba(255,255,255,.2)">
                  <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                </svg>
                <p>No private messages yet</p>
              </div>
            </div>
            <!-- "To:" recipient picker (host only, shown on Private tab) -->
            <div class="wrtc-to-row" id="wrtc-to-row" style="display:none">
              <span class="wrtc-to-label">To:</span>
              <select class="wrtc-to-select" id="wrtc-to-select">
                <option value="">Select recipient…</option>
              </select>
            </div>
            <!-- Reply-to banner (host only, shown when replying privately to a guest) -->
            <div class="wrtc-reply-banner" id="wrtc-reply-banner" style="display:none">
              <span class="wrtc-reply-banner-text" id="wrtc-reply-banner-text">Replying privately to …</span>
              <button class="wrtc-reply-cancel" id="wrtc-reply-cancel" title="Cancel reply">✕</button>
            </div>
            <div class="wrtc-chat-footer">
              <input class="wrtc-chat-input" id="wrtc-chat-input" placeholder="Send a message…" maxlength="500">
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

        <!-- Chat (visible toolbar button) -->
        <button class="wrtc-btn" id="wrtc-btn-chat" title="Chat" style="position:relative">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
          </svg>
          <div class="wrtc-btn-badge" id="wrtc-chat-badge-btn" style="display:none"></div>
        </button>

        <!-- Raise Hand -->
        <button class="wrtc-btn" id="wrtc-btn-hand" title="Raise hand">
          <span style="font-size:20px;line-height:1">✋</span>
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

        <!-- 3-dot More menu -->
        <button class="wrtc-btn" id="wrtc-btn-more" title="More options" style="position:relative">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5"  r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
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

      <!-- Hidden legacy buttons kept for JS compatibility -->
      <button id="wrtc-btn-share"  style="display:none"></button>
      <button id="wrtc-btn-rec"    style="display:none"></button>
      <button id="wrtc-btn-people" style="display:none"></button>
      <button id="wrtc-btn-filter" style="display:none"></button>
      <button id="wrtc-btn-invite" style="display:none"></button>

      <!-- 3-dot dropdown menu -->
      <div class="wrtc-more-menu" id="wrtc-more-menu" style="display:none">
        <div class="wrtc-more-item" id="wrtc-more-share">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
            <path d="M10 13l2-2 2 2 1-1-3-3-3 3z" transform="translate(0 -1)"/>
          </svg>
          <span id="wrtc-more-share-label">Share Screen</span>
        </div>
        <div class="wrtc-more-item" id="wrtc-more-rec">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="6" id="wrtc-rec-circle"/>
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span id="wrtc-more-rec-label">Record</span>
        </div>
        <div class="wrtc-more-divider"></div>
        <div class="wrtc-more-item" id="wrtc-more-people">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
          </svg>
          <span>Participants</span>
        </div>
        <div class="wrtc-more-divider"></div>
        <div class="wrtc-more-item" id="wrtc-more-vbg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
          </svg>
          <span id="wrtc-more-vbg-label">Virtual Background</span>
        </div>
        <div class="wrtc-more-divider"></div>
        <div class="wrtc-more-item" id="wrtc-more-invite">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
          </svg>
          <span>Invite People</span>
        </div>
      </div>

      <div class="wrtc-toast" id="wrtc-toast"></div>

      <!-- Virtual Background Panel -->
      <div class="wrtc-vbg-overlay" id="wrtc-vbg-overlay" style="display:none">
        <div class="wrtc-vbg-panel" id="wrtc-vbg-panel">
          <div class="wrtc-vbg-header">
            <span class="wrtc-vbg-title">Virtual Background</span>
            <button class="wrtc-vbg-close" id="wrtc-vbg-close">&times;</button>
          </div>
          <div class="wrtc-vbg-grid">
            <div class="wrtc-vbg-opt active" data-bg="none">
              <div class="wrtc-vbg-none-icon">&#10005;</div>
              <span class="wrtc-vbg-label">None</span>
            </div>
            <div class="wrtc-vbg-opt" data-bg="blur">
              <div class="wrtc-vbg-blur-thumb">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="rgba(255,255,255,.85)">
                  <path d="M6 13c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0-8c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm-3 6.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zM12 13c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm6 0c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm3 2.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zM9 13.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm6 0c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5z"/>
                </svg>
              </div>
              <span class="wrtc-vbg-label">Blur</span>
            </div>
            <div class="wrtc-vbg-opt" data-bg="office">
              <img class="wrtc-vbg-thumb" src="${this._httpBase}/api/v1/bg/office.jpg?v=2" alt="Office" crossorigin="anonymous">
              <span class="wrtc-vbg-label">Office</span>
            </div>
            <div class="wrtc-vbg-opt" data-bg="nature">
              <img class="wrtc-vbg-thumb" src="${this._httpBase}/api/v1/bg/nature.jpg?v=2" alt="Nature" crossorigin="anonymous">
              <span class="wrtc-vbg-label">Nature</span>
            </div>
            <div class="wrtc-vbg-opt" data-bg="library">
              <img class="wrtc-vbg-thumb" src="${this._httpBase}/api/v1/bg/library.jpg?v=2" alt="Library" crossorigin="anonymous">
              <span class="wrtc-vbg-label">Library</span>
            </div>
          </div>
          <div class="wrtc-vbg-status" id="wrtc-vbg-status"></div>
        </div>
      </div>
    </div>`;

    // Inject branding logo (embed-only — only present when logoUrl was passed)
    if (this._logoUrl) {
      const logo = document.createElement("img");
      logo.className = "wrtc-logo";
      logo.src = this._logoUrl;
      logo.alt = "";
      logo.onerror = () => { logo.style.display = "none"; };
      this.parentNode.appendChild(logo);
    }

    // Wire up static elements
    document.getElementById("wrtc-room-name").textContent      = this.roomName;
    document.getElementById("wrtc-room-hint").textContent      = this.roomName;
    document.getElementById("wrtc-pip-label").textContent      = this._myName || "You";
    document.getElementById("wrtc-pip-avatar-text").textContent = this._getInitials(this._myName || "You");
    // Block browser's native video right-click context menu ("Show controls" etc.)
    this.parentNode.addEventListener("contextmenu", (e) => {
      if (e.target.tagName === "VIDEO") e.preventDefault();
    });

    // Local tile — focus on click
    const localTile = document.getElementById("wrtc-local-tile");
    localTile.addEventListener("click", () => {
      if (this._focusTileId === "wrtc-local-tile") return; // already main
      if (this._focusTileId) { this._switchFocusTile("wrtc-local-tile"); return; }
      if (Object.keys(this._peerConnections).length > 0) this._enterFocusMode("wrtc-local-tile");
    });
    document.getElementById("wrtc-focus-exit").addEventListener("click", () => this._exitFocusMode());
    document.getElementById("wrtc-focus-more").addEventListener("click", () => this._exitFocusMode());

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
    document.getElementById("wrtc-btn-chat").addEventListener("click",  () => this._togglePanel("chat"));
    document.getElementById("wrtc-btn-hand").addEventListener("click",  () => this._toggleHand());
    document.getElementById("wrtc-vbg-close").addEventListener("click", () => this._closeVBGPanel());
    document.getElementById("wrtc-vbg-overlay").addEventListener("click", () => this._closeVBGPanel());
    document.getElementById("wrtc-vbg-panel").addEventListener("click", e => e.stopPropagation());
    document.querySelectorAll(".wrtc-vbg-opt").forEach(el => {
      el.addEventListener("click", () => this._selectVBG(el.dataset.bg));
    });
    // 3-dot more menu
    document.getElementById("wrtc-btn-more").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("wrtc-more-menu");
      const open = menu.style.display === "flex";
      if (open) { menu.style.display = "none"; return; }
      menu.style.display = "flex";
      // Position above the button, centered on it
      const btn  = document.getElementById("wrtc-btn-more");
      const rect = btn.getBoundingClientRect();
      const menuW = menu.offsetWidth || 180;
      let left = rect.left + rect.width / 2 - menuW / 2;
      // Clamp so it doesn't go off-screen
      left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
      menu.style.left   = left + "px";
      menu.style.bottom = (window.innerHeight - rect.top + 8) + "px";
      menu.style.top    = "";
    });
    document.getElementById("wrtc-more-share").addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
      this._toggleScreenShare();
    });
    document.getElementById("wrtc-more-rec").addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
      this._toggleRecording();
    });
    document.getElementById("wrtc-more-people").addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
      this._togglePanel("people");
    });
    document.getElementById("wrtc-more-invite").addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
      this._showInvite();
    });
    document.getElementById("wrtc-more-vbg").addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
      this._toggleVBGPanel();
    });
    // Close more menu on outside click
    document.addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
    });
    document.getElementById("wrtc-user-count").closest(".wrtc-peer-chip").addEventListener("click", () => this._togglePanel("people"));
    document.getElementById("wrtc-tab-people").addEventListener("click", () => this._switchTab("people"));
    document.getElementById("wrtc-tab-chat").addEventListener("click",   () => this._switchTab("chat"));
    document.getElementById("wrtc-panel-close").addEventListener("click",() => this._closePanel());
    document.getElementById("wrtc-chat-send").addEventListener("click", () => this._sendChatByTab());
    document.getElementById("wrtc-chat-input").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._sendChatByTab(); }
    });
    // Sub-tab clicks
    document.getElementById("wrtc-subtab-public").addEventListener("click",  () => this._switchChatSubTab("public"));
    document.getElementById("wrtc-subtab-private").addEventListener("click", () => this._switchChatSubTab("private"));
    // Cancel private reply (host)
    document.getElementById("wrtc-reply-cancel").addEventListener("click", () => this._clearReplyTarget());
    // "To:" recipient picker (host — Private tab)
    document.getElementById("wrtc-to-select").addEventListener("change", (e) => {
      const userId = e.target.value;
      if (!userId) { this._clearReplyTarget(); return; }
      const name = this._displayName(userId);
      this._setReplyTarget(userId, name);
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

    // No audio track at all — request mic permission on first enable
    if (!this._micEnabled && !(this._localStream?.getAudioTracks().length)) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(async micStream => {
          const track = micStream.getAudioTracks()[0];
          if (!this._localStream) { this._localStream = micStream; }
          else { this._localStream.addTrack(track); }
          // Add track to all active peer connections
          for (const [peerId, pc] of Object.entries(this._peerConnections)) {
            const audioSender = pc.getSenders().find(s => s.track?.kind === "audio");
            if (audioSender) {
              await audioSender.replaceTrack(track);
            } else {
              pc.addTrack(track, this._localStream);
              await this._initiateOffer(peerId);
            }
          }
          this._micEnabled = true;
          sessionStorage.setItem('wrtc_mic_' + this.roomName, '1');
          document.getElementById("wrtc-btn-mic").classList.remove("muted");
          document.getElementById("wrtc-ico-mic").style.display     = "";
          document.getElementById("wrtc-ico-mic-off").style.display = "none";
          this._setupAudioAnalyser("local", this._localStream);
          this._toast("Microphone on");
        })
        .catch(err => {
          this._toast(err.name === "NotAllowedError" ? "Microphone permission denied" : "No microphone available");
        });
      return;
    }

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

    // No video track at all — request camera permission on first enable
    if (!this._camEnabled && !(this._localStream?.getVideoTracks().length)) {
      navigator.mediaDevices.getUserMedia({ video: true })
        .then(async camStream => {
          const track = camStream.getVideoTracks()[0];
          if (!this._localStream) { this._localStream = camStream; }
          else { this._localStream.addTrack(track); }
          // Add track to all peer connections (renegotiate if no video sender yet)
          for (const [peerId, pc] of Object.entries(this._peerConnections)) {
            const videoSender = pc.getSenders().find(s => s.track?.kind === "video");
            if (videoSender) {
              await videoSender.replaceTrack(track);
            } else {
              pc.addTrack(track, this._localStream);
              await this._initiateOffer(peerId);
            }
          }
          this._camEnabled = true;
          sessionStorage.setItem('wrtc_cam_' + this.roomName, '1');
          document.getElementById("wrtc-btn-cam").classList.remove("muted");
          document.getElementById("wrtc-ico-cam").style.display     = "";
          document.getElementById("wrtc-ico-cam-off").style.display = "none";
          document.getElementById("wrtc-local-video").srcObject     = this._activeVideoStream();
          document.getElementById("wrtc-local-video").style.display = "block";
          document.getElementById("wrtc-pip-avatar").style.display  = "none";
          this._sendWS({ type: "cam-state", payload: { enabled: true } });
          this._toast("Camera on");
        })
        .catch(err => {
          this._toast(err.name === "NotAllowedError" ? "Camera permission denied" : "No camera available");
        });
      return;
    }

    this._camEnabled = !this._camEnabled;
    this._localStream?.getVideoTracks().forEach(t => { t.enabled = this._camEnabled; });
    sessionStorage.setItem('wrtc_cam_' + this.roomName, this._camEnabled ? '1' : '0');
    document.getElementById("wrtc-btn-cam").classList.toggle("muted", !this._camEnabled);
    document.getElementById("wrtc-ico-cam").style.display     = this._camEnabled ? "" : "none";
    document.getElementById("wrtc-ico-cam-off").style.display = this._camEnabled ? "none" : "";
    document.getElementById("wrtc-local-video").style.display = this._camEnabled ? "block" : "none";
    document.getElementById("wrtc-pip-avatar").style.display  = this._camEnabled ? "none"  : "flex";
    this._sendWS({ type: "cam-state", payload: { enabled: this._camEnabled } });
    this._toast(this._camEnabled ? "Camera on" : "Camera off");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCREEN SHARE
  // ═══════════════════════════════════════════════════════════════════════
  async _toggleScreenShare() {
    // Block if someone else is already presenting
    if (!this._isSharing && this._presenterUserId) {
      const presenterName = this._displayName(this._presenterUserId);
      this._showBlockedShareModal(presenterName);
      return;
    }
    if (this._isSharing) {
      this._shareStream?.getTracks().forEach(t => t.stop());
      this._shareStream = null;
      this._isSharing   = false;
      sessionStorage.removeItem('wrtc_sharing_' + this.roomName);
      await this._restoreCameraTrack();
      this._renegotiateAll(); // renegotiate so peers get updated SDP for camera track
      document.getElementById("wrtc-more-share").classList.remove("on-air");
      document.getElementById("wrtc-more-share-label").textContent = "Share Screen";
      // Restore cam button and VBG menu item — hidden during screen share
      document.getElementById("wrtc-btn-cam").style.display = "";
      document.getElementById("wrtc-more-vbg").style.display = "";
      // Restore camera to the state it was in before sharing started
      const wasOn = this._camEnabledBeforeShare !== false;
      this._camEnabledBeforeShare = undefined;
      if (wasOn && !this._camEnabled) {
        this._localStream?.getVideoTracks().forEach(t => { t.enabled = true; });
        this._camEnabled = true;
        document.getElementById("wrtc-btn-cam").classList.remove("muted");
        document.getElementById("wrtc-ico-cam").style.display     = "";
        document.getElementById("wrtc-ico-cam-off").style.display = "none";
        document.getElementById("wrtc-pip-avatar").style.display  = "none";
        this._sendWS({ type: "cam-state", payload: { enabled: true } });
      }
      document.getElementById("wrtc-local-video").srcObject = this._activeVideoStream();
      document.getElementById("wrtc-local-video").style.display = this._camEnabled ? "block" : "none";
      this._presenterUserId = null;
      this._clearPresenter();
      this._sendWS({ type: "presenting", payload: { active: false } });
      this._toast("Screen sharing stopped");
    } else {
      try {
        this._shareStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        this._isSharing   = true;
        this._exitFocusMode(); // clear focus mode before entering presentation mode
        sessionStorage.setItem('wrtc_sharing_' + this.roomName, '1');
        const screenTrack = this._shareStream.getVideoTracks()[0];
        screenTrack.onended = () => { if (this._isSharing) this._toggleScreenShare(); };
        await this._replaceVideoTrack(screenTrack);
        this._renegotiateAll(); // renegotiate so peers get updated SDP for screen track
        document.getElementById("wrtc-more-share").classList.add("on-air");
        document.getElementById("wrtc-more-share-label").textContent = "Stop Sharing";
        // Hide cam button and VBG option — not relevant while screen sharing
        document.getElementById("wrtc-btn-cam").style.display = "none";
        document.getElementById("wrtc-more-vbg").style.display = "none";
        // Disable camera so participants only see the shared screen, not the webcam.
        // Save current cam state so we can restore it when sharing stops.
        this._camEnabledBeforeShare = this._camEnabled;
        if (this._camEnabled) {
          this._localStream?.getVideoTracks().forEach(t => { t.enabled = false; });
          this._camEnabled = false;
          document.getElementById("wrtc-btn-cam").classList.add("muted");
          document.getElementById("wrtc-ico-cam").style.display     = "none";
          document.getElementById("wrtc-ico-cam-off").style.display = "";
          document.getElementById("wrtc-pip-avatar").style.display  = "flex";
          this._sendWS({ type: "cam-state", payload: { enabled: false } });
        }
        this._setLocalPresenter();
        // Delay the "presenting" signal so remote peers receive the first
        // screen keyframe before they expand the tile (avoids blank/camera flash)
        setTimeout(() => {
          if (this._isSharing) this._sendWS({ type: "presenting", payload: { active: true } });
        }, 800);
        this._toast("You are now presenting");
      } catch (err) {
        if (err.name !== "NotAllowedError") this._toast("Screen share failed");
        this._log("Screen share error: " + err.message, undefined, "error");
      }
    }
  }

  _waitForPresenterVideo(userId) {
    const _trySet = () => {
      if (this._presenterUserId !== userId) return; // share was cancelled
      this._setPresenter(userId);
    };

    const tile = document.getElementById(`wrtc-tile-${userId}`);
    if (!tile) {
      // Tile not in DOM yet (peer hasn't connected yet) — poll until it appears
      let elapsed = 0;
      const poll = setInterval(() => {
        elapsed += 100;
        if (document.getElementById(`wrtc-tile-${userId}`)) {
          clearInterval(poll);
          // Give the track a brief moment to arrive, then switch layout
          setTimeout(_trySet, 300);
        } else if (elapsed >= 5000) {
          clearInterval(poll);
          _trySet();
        }
      }, 100);
      return;
    }

    // Tile exists — switch layout immediately (video updates naturally as
    // the screen share track arrives via replaceTrack, no resize event needed)
    setTimeout(_trySet, 200);
  }

  _setPresenter(userId) {
    const stage  = document.getElementById("wrtc-stage");
    const thumbs = document.getElementById("wrtc-thumbs");
    stage?.classList.add("presenting");
    thumbs.innerHTML = "";

    // Sync local video to the active stream (filter or raw camera) before
    // building thumbs so _addThumb reads the correct srcObject for the local tile.
    const lv = document.getElementById("wrtc-local-video");
    if (lv) lv.srcObject = this._activeVideoStream();

    const presenterName = this._displayName(userId);

    document.querySelectorAll(".wrtc-tile").forEach(tile => {
      if (tile.id === `wrtc-tile-${userId}`) {
        const badge = tile.querySelector(".wrtc-presenter-badge");
        if (badge) badge.textContent = `${presenterName} is presenting`;
        tile.classList.add("presenter");
        // Hide the presenter's avatar — the screen share replaces their camera
        // track so the video element shows the shared screen, not a blank feed.
        const av = tile.querySelector(".wrtc-tile-avatar");
        if (av) av.classList.remove("visible");
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

    // Move only REMOTE tiles to the thumbnail strip — the presenter does not
    // need to see their own tile; only other participants appear on the right.
    document.querySelectorAll(".wrtc-tile:not(#wrtc-local-share-tile):not(#wrtc-local-tile)").forEach(t => {
      this._addThumb(t, thumbs);
      t.style.display = "none";
    });
    // Hide the local tile entirely during screen share
    document.getElementById("wrtc-local-tile").style.display = "none";
    thumbs.style.display = "flex";
  }

  _addThumb(tile, thumbs) {
    const vid = tile.querySelector("video");
    if (!vid) return;
    // For the local tile, always use the active stream (filter or raw camera)
    // so virtual backgrounds are visible in the thumbnail strip.
    const srcStream = (tile.id === "wrtc-local-tile")
      ? this._activeVideoStream()
      : vid.srcObject;
    if (!srcStream) return;
    const userId = tile.id.replace("wrtc-tile-", "") || "local";
    const wrap      = document.createElement("div");
    wrap.className  = "wrtc-thumb-tile";
    wrap.dataset.userId = userId;
    const tv        = document.createElement("video");
    tv.autoplay     = true;
    tv.playsInline  = true;
    tv.muted        = true;
    tv.srcObject    = srcStream;
    const lbl       = document.createElement("div");
    lbl.className   = "wrtc-thumb-label";
    lbl.textContent = tile.querySelector(".wrtc-tile-label")?.textContent || "";
    wrap.append(tv, lbl);
    thumbs.appendChild(wrap);
    // Canvas captureStreams require explicit play() — autoplay alone is not
    // reliable for programmatically created video elements.
    tv.play().catch(() => {});
  }

  // Same as _addThumb but tags the wrap with a specific userId for late-joiner detection.
  _addThumbTagged(tile, thumbs, userId) {
    const vid = tile.querySelector("video");
    if (!vid || !vid.srcObject) return null;
    const wrap     = document.createElement("div");
    wrap.className = "wrtc-thumb-tile";
    wrap.dataset.userId = userId;
    const tv       = document.createElement("video");
    tv.autoplay    = true;
    tv.playsInline = true;
    tv.muted       = true;
    tv.srcObject   = vid.srcObject;
    const lbl      = document.createElement("div");
    lbl.className  = "wrtc-thumb-label";
    lbl.textContent = tile.querySelector(".wrtc-tile-label")?.textContent || "";
    wrap.append(tv, lbl);
    thumbs.appendChild(wrap);
    tv.play().catch(() => {});
    return wrap;
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
    // Re-apply avatar visibility from known cam states so avatar is correct
    // after we hid it during the presentation (e.g. camera was off throughout).
    Object.entries(this._camStates).forEach(([uid, enabled]) => {
      const av = document.getElementById(`wrtc-avatar-${uid}`);
      if (av) av.classList.toggle("visible", !enabled);
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
      document.getElementById("wrtc-more-rec").classList.remove("on-air");
      document.getElementById("wrtc-more-rec-label").textContent = "Record";
      document.getElementById("wrtc-rec-badge").classList.remove("active");
      document.getElementById("wrtc-rec-circle").setAttribute("fill", "currentColor");
      this._toast("Recording saved");
    } else {
      try {
        const tabStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: true,
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
          const embedToken = this._embedTokenSaved || '';
          const roomName   = this.roomName || '';
          if (embedToken) {
            const form = new FormData();
            form.append('file', blob, `recording-${Date.now()}.webm`);
            fetch(
              this._httpBase + '/api/v1/projects/recordings/upload'
              + '?embed_token=' + encodeURIComponent(embedToken)
              + '&room_name='   + encodeURIComponent(roomName),
              { method: 'POST', body: form }
            )
              .then(r => r.ok ? this._toast('Recording saved to dashboard') : this._toast('Recording upload failed'))
              .catch(() => this._toast('Recording upload failed'));
          } else {
            const url = URL.createObjectURL(blob);
            Object.assign(document.createElement("a"), { href: url, download: `meeting-${Date.now()}.webm` }).click();
            URL.revokeObjectURL(url);
          }
        };
        tabStream.getVideoTracks()[0].onended = () => { if (this._isRecording) this._toggleRecording(); };
        this._mediaRecorder.start(1000);
        this._isRecording = true;
        document.getElementById("wrtc-more-rec").classList.add("on-air");
        document.getElementById("wrtc-more-rec-label").textContent = "Stop Recording";
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
      ["wrtc-chat-badge","wrtc-chat-badge-btn","wrtc-chat-badge-menu"].forEach(id => {
        document.getElementById(id)?.classList.remove("show");
      });
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

  // Determines send destination from the active sub-tab — no dropdown needed.
  _sendChatByTab() {
    if (this._chatSubTab === "private") {
      this._sendChat("private");
    } else {
      this._sendChat("everyone");
    }
  }

  _sendChat(target = "everyone") {
    const input = document.getElementById("wrtc-chat-input");
    const text  = input?.value.trim();
    if (!text) return;
    input.value = "";
    const ts = Date.now();

    if (target === "private") {
      if (this._isHost) {
        // Host on Private tab: must have a reply target selected
        if (!this._privateReplyTo) {
          this._toast("Click 'Reply privately' on a message first");
          return;
        }
        const { userId, name } = this._privateReplyTo;
        this._sendWS({ type: "chat-private", payload: { text, ts, to: userId } });
        this._renderMessage(`You → ${name}`, text, ts, true, "private");
      } else {
        // Guest on Private tab → goes to host only
        this._sendWS({ type: "chat-private", payload: { text, ts } });
        this._renderMessage("You (private)", text, ts, true, "private");
      }
    } else {
      // Everyone tab → broadcast; host messages show as popup on recipients
      const payload = this._isHost ? { text, ts, isHostMsg: true } : { text, ts };
      this._sendWS({ type: "chat", payload });
      this._renderMessage("You", text, ts, true, "public");
    }
  }

  _renderMessage(name, text, ts, isMine = false, container = "public", isPrivate = false, replyToUserId = null) {
    const msgsId = container === "private" ? "wrtc-chat-msgs-private" : "wrtc-chat-msgs";
    const emptyId = container === "private" ? "wrtc-chat-private-empty" : "wrtc-chat-empty";
    const empty = document.getElementById(emptyId);
    if (empty) empty.style.display = "none";

    const msgs = document.getElementById(msgsId);
    if (!msgs) return;
    const time  = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const safe  = text.replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const LIMIT = 120;
    const needsTrunc = safe.length > LIMIT;
    const preview    = needsTrunc ? safe.slice(0, LIMIT) + "…" : safe;

    const div = document.createElement("div");
    div.className = `wrtc-msg${isMine ? " mine" : ""}`;
    div.innerHTML = `
      ${isPrivate ? '<div class="wrtc-msg-private-label">🔒 Private</div>' : ""}
      <div class="wrtc-msg-header">
        <span class="wrtc-msg-name${isMine ? " mine" : ""}">${name}</span>
        <span class="wrtc-msg-time">${time}</span>
      </div>
      <span class="wrtc-msg-text" data-full="${safe.replace(/"/g,"&quot;")}" data-expanded="false">${preview}</span>
      ${needsTrunc ? '<span class="wrtc-msg-more">Show more</span>' : ""}
      ${replyToUserId ? '<button class="wrtc-msg-reply">Reply privately</button>' : ""}`;

    if (replyToUserId) {
      div.querySelector(".wrtc-msg-reply").addEventListener("click", () => {
        this._setReplyTarget(replyToUserId, name);
      });
    }
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

    // ── Persist message to sessionStorage ──────────────────────────────────
    try {
      const key = 'wrtc_chat_' + this.roomName;
      const stored = JSON.parse(sessionStorage.getItem(key) || '[]');
      stored.push({ name, text, ts, isMine, container, isPrivate });
      // Keep last 200 messages
      if (stored.length > 200) stored.splice(0, stored.length - 200);
      sessionStorage.setItem(key, JSON.stringify(stored));
    } catch(_) {}
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
  _showMeetingReadyCard() {
    // Don't show again if host already dismissed it this session
    if (sessionStorage.getItem("wrtc_ready_dismissed_" + this.roomName)) return;
    document.getElementById("wrtc-ready-card")?.remove();
    const url  = this._shareUrl || (window.location.origin + '/sdk/join/' + this.roomName);
    const card = document.createElement("div");
    card.id = "wrtc-ready-card";
    card.innerHTML = `
      <div style="font-size:15px;font-weight:600;color:#202124;margin-bottom:12px">Your meeting's ready</div>
      <div style="font-size:13px;color:#3c4043;margin-bottom:14px;line-height:1.5">
        Share this joining info with others you want in the meeting
      </div>
      <div style="background:#f1f3f4;border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:8px">
        <span style="font-size:12px;color:#202124;word-break:break-all;flex:1">${url}</span>
        <button id="wrtc-ready-copy" title="Copy link" style="background:none;border:none;cursor:pointer;padding:4px;flex-shrink:0;color:#1a73e8">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        </button>
      </div>
      <div style="font-size:12px;color:#3c4043;margin-bottom:4px">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#5f6368" style="vertical-align:middle;margin-right:6px"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
        Dial-in: +91 7206053500 (Anmol Madaan)
      </div>
      <div style="font-size:12px;color:#3c4043;margin-bottom:16px;padding-left:20px">PIN: 140301#</div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <button id="wrtc-ready-invite" style="background:#1a73e8;color:#fff;border:none;border-radius:20px;padding:8px 18px;font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          Add others
        </button>
        <button id="wrtc-ready-close" style="background:none;border:none;cursor:pointer;color:#5f6368;font-size:13px">✕</button>
      </div>`;

    Object.assign(card.style, {
      position: "absolute", bottom: "90px", left: "20px", zIndex: "35",
      background: "#fff", borderRadius: "12px", padding: "20px",
      boxShadow: "0 4px 24px rgba(0,0,0,.22)", width: "280px",
      fontFamily: "'Google Sans',Roboto,sans-serif", animation: "wrtcSlideIn .25s ease",
    });

    // Inject keyframe once
    if (!document.getElementById("wrtc-ready-style")) {
      const st = document.createElement("style");
      st.id = "wrtc-ready-style";
      st.textContent = "@keyframes wrtcSlideIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}";
      document.head.appendChild(st);
    }

    this.parentNode.appendChild(card);

    const close = () => {
      card.remove();
      sessionStorage.setItem("wrtc_ready_dismissed_" + this.roomName, "1");
    };
    document.getElementById("wrtc-ready-close").addEventListener("click", close);
    document.getElementById("wrtc-ready-invite").addEventListener("click", () => { close(); this._showInvite(); });
    document.getElementById("wrtc-ready-copy").addEventListener("click", () => {
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById("wrtc-ready-copy");
        if (btn) btn.style.color = "#34a853";
        this._toast("Link copied!");
        setTimeout(() => { if (btn) btn.style.color = "#1a73e8"; }, 2000);
      });
    });
  }

  _showBlockedShareModal(presenterName) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:999;";
    overlay.innerHTML = `
      <div style="background:#2d2e31;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:32px 36px;max-width:360px;width:90%;text-align:center;font-family:inherit;">
        <div style="font-size:36px;margin-bottom:14px;">🖥️</div>
        <h3 style="color:#e8eaed;font-size:16px;font-weight:600;margin:0 0 10px;">${presenterName} is presenting</h3>
        <p style="color:#9aa0a6;font-size:13px;margin:0 0 24px;line-height:1.5;">Please ask them to stop sharing before you can present.</p>
        <button id="wrtc-blocked-share-ok" style="background:#1a73e8;color:#fff;border:none;border-radius:10px;padding:10px 32px;font-size:14px;font-weight:500;cursor:pointer;">Got it</button>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById("wrtc-blocked-share-ok").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }

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
  // ─── Host message popup ────────────────────────────────────────────────────
  _showMsgPopup(name, text) {
    const existing = document.getElementById("wrtc-msg-popup");
    if (existing) existing.remove();
    clearTimeout(this._popupTimer);
    const safe = text.replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const el = document.createElement("div");
    el.className = "wrtc-msg-popup";
    el.id = "wrtc-msg-popup";
    el.innerHTML = `
      <button class="wrtc-msg-popup-close" title="Dismiss">✕</button>
      <div class="wrtc-msg-popup-from">Message from Host</div>
      <div class="wrtc-msg-popup-name">${name}</div>
      <div class="wrtc-msg-popup-text">${safe.slice(0, 120)}${safe.length > 120 ? "…" : ""}</div>`;
    el.querySelector(".wrtc-msg-popup-close").addEventListener("click", () => {
      el.remove(); clearTimeout(this._popupTimer);
    });
    const container = document.getElementById("wrtc-container") || document.querySelector(".wrtc-wrapper") || document.body;
    container.appendChild(el);
    this._popupTimer = setTimeout(() => el.remove(), 6000);
  }

  // ─── Private reply target (host) ───────────────────────────────────────────
  _refreshToSelect() {
    const toRow = document.getElementById("wrtc-to-row");
    const sel   = document.getElementById("wrtc-to-select");
    if (!toRow || !sel || !this._isHost) return;
    toRow.style.display = "flex";
    // Re-populate options from current participants (exclude self)
    const current = sel.value; // preserve selection if still valid
    sel.innerHTML = '<option value="">Select recipient…</option>';
    Object.entries(this._participants).forEach(([uid, name]) => {
      if (uid === this._myUserId) return;
      const opt = document.createElement("option");
      opt.value       = uid;
      opt.textContent = name || uid.slice(0, 8);
      sel.appendChild(opt);
    });
    // Restore previous selection if still in room
    if (current && sel.querySelector(`option[value="${current}"]`)) {
      sel.value = current;
    } else if (this._privateReplyTo) {
      sel.value = this._privateReplyTo.userId || "";
    }
  }

  _setReplyTarget(userId, name) {
    this._privateReplyTo = { userId, name };
    const banner = document.getElementById("wrtc-reply-banner");
    const text   = document.getElementById("wrtc-reply-banner-text");
    const input  = document.getElementById("wrtc-chat-input");
    const sel    = document.getElementById("wrtc-to-select");
    if (banner) banner.style.display = "flex";
    if (text)   text.textContent = `Replying privately to ${name}`;
    if (input)  { input.placeholder = `Reply to ${name}…`; input.focus(); }
    if (sel)    sel.value = userId;
    // Switch to private sub-tab so host can see context
    this._switchChatSubTab("private");
  }

  _clearReplyTarget() {
    this._privateReplyTo = null;
    const banner = document.getElementById("wrtc-reply-banner");
    const input  = document.getElementById("wrtc-chat-input");
    const sel    = document.getElementById("wrtc-to-select");
    if (banner) banner.style.display = "none";
    if (sel)    sel.value = "";
    // Restore placeholder based on current tab
    if (input)  input.placeholder = this._chatSubTab === "private" ? "Type a private message…" : "Send a message…";
  }

  // ─── Switch chat sub-tab (host only) ───────────────────────────────────────
  _switchChatSubTab(tab) {
    this._chatSubTab = tab;
    const pubMsgs  = document.getElementById("wrtc-chat-msgs");
    const privMsgs = document.getElementById("wrtc-chat-msgs-private");
    const pubTab   = document.getElementById("wrtc-subtab-public");
    const privTab  = document.getElementById("wrtc-subtab-private");
    const input    = document.getElementById("wrtc-chat-input");
    if (!pubMsgs || !privMsgs) return;

    if (tab === "private") {
      pubMsgs.style.display  = "none";
      privMsgs.style.display = "";
      pubTab?.classList.remove("active");
      privTab?.classList.add("active");
      // Update placeholder to reflect private context
      if (input) input.placeholder = this._isHost ? "Type a private message…" : "Private message to host…";
      // Show "To:" picker for host and populate with current participants
      if (this._isHost) this._refreshToSelect();
      // Clear private unread badge
      this._privateUnread = 0;
      const badge = document.getElementById("wrtc-private-badge");
      if (badge) { badge.textContent = ""; badge.classList.remove("show"); }
    } else {
      pubMsgs.style.display  = "";
      privMsgs.style.display = "none";
      pubTab?.classList.add("active");
      privTab?.classList.remove("active");
      if (input) input.placeholder = "Send a message…";
      // Hide "To:" picker and clear reply target
      const toRow = document.getElementById("wrtc-to-row");
      if (toRow) toRow.style.display = "none";
      this._clearReplyTarget();
    }
  }

  _toast(msg) {
    const el = document.getElementById("wrtc-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  _toastLong(msg) {
    const el = document.getElementById("wrtc-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("show"), 7000);
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
    if (this._focusTileId) { this._updateFocusPanel(); return; }
    const grid      = document.getElementById("wrtc-grid");
    const waiting   = document.getElementById("wrtc-waiting");
    const localTile = document.getElementById("wrtc-local-tile");
    const stage     = document.getElementById("wrtc-stage");
    if (!grid || !localTile || !stage) return;

    // Use whichever count is larger: active peer connections OR tiles already in the DOM.
    // This ensures the grid is visible as soon as _ensureRemoteTile creates a tile, even
    // before the WebRTC offer/answer cycle completes (e.g. right after a host refresh).
    const pcCount     = Object.keys(this._peerConnections).length;
    const tileCount   = grid.querySelectorAll(".wrtc-tile:not(#wrtc-local-tile)").length;
    const remoteCount = Math.max(pcCount, tileCount);

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
  // FOCUS MODE
  // ═══════════════════════════════════════════════════════════════════════
  _enterFocusMode(tileId) {
    if (this._isSharing || document.getElementById("wrtc-stage")?.classList.contains("presenting")) return;
    if (Object.keys(this._peerConnections).length === 0) return;

    this._focusTileId = tileId;
    const grid      = document.getElementById("wrtc-grid");
    const focusWrap = document.getElementById("wrtc-focus-wrap");
    const focusMain = document.getElementById("wrtc-focus-main");
    if (!grid || !focusWrap || !focusMain) return;

    // Move focused tile into main panel
    const tile = document.getElementById(tileId);
    if (!tile) return;
    focusMain.appendChild(tile);

    // Move all remaining grid tiles into the panel
    this._updateFocusPanel();

    grid.style.display      = "none";
    focusWrap.style.display = "flex";
  }

  _exitFocusMode() {
    if (!this._focusTileId) return;
    const grid       = document.getElementById("wrtc-grid");
    const focusWrap  = document.getElementById("wrtc-focus-wrap");
    const focusMain  = document.getElementById("wrtc-focus-main");
    const focusTiles = document.getElementById("wrtc-focus-tiles");
    if (!grid || !focusWrap) return;

    // Move main tile back to grid
    const mainTile = focusMain?.querySelector(".wrtc-tile");
    if (mainTile) {
      mainTile.style.cssText = "";
      if (mainTile.id === "wrtc-local-tile") grid.prepend(mainTile);
      else grid.appendChild(mainTile);
    }

    // Move all panel tiles back to grid (including hidden overflow ones)
    if (focusTiles) {
      [...focusTiles.querySelectorAll(".wrtc-tile")].forEach(t => {
        t.style.display = "";
        grid.appendChild(t);
      });
    }

    // Restore local tile to front
    const localTile = document.getElementById("wrtc-local-tile");
    if (localTile?.parentElement === grid) grid.prepend(localTile);

    this._focusTileId       = null;
    focusWrap.style.display = "none";
    grid.style.display      = "";
    this._updateGrid();
  }

  _switchFocusTile(tileId) {
    if (!this._focusTileId) return;
    const focusMain  = document.getElementById("wrtc-focus-main");
    const focusTiles = document.getElementById("wrtc-focus-tiles");
    if (!focusMain || !focusTiles) return;

    const newMain = document.getElementById(tileId);
    const oldMain = focusMain.querySelector(".wrtc-tile");
    if (!newMain || !oldMain || newMain === oldMain) return;

    // Swap: old main goes to panel where new main was, new main goes to focusMain
    focusTiles.insertBefore(oldMain, newMain);
    focusMain.appendChild(newMain);
    this._focusTileId = tileId;
    this._updateFocusPanel();
  }

  _updateFocusPanel() {
    const focusMain  = document.getElementById("wrtc-focus-main");
    const focusTiles = document.getElementById("wrtc-focus-tiles");
    const focusMore  = document.getElementById("wrtc-focus-more");
    const grid       = document.getElementById("wrtc-grid");
    if (!focusMain || !focusTiles || !focusMore) return;

    const focusedId = focusMain.querySelector(".wrtc-tile")?.id;

    // Collect all non-focused tiles from grid + existing panel
    const allOther = [
      ...document.querySelectorAll("#wrtc-grid .wrtc-tile"),
      ...document.querySelectorAll("#wrtc-focus-tiles .wrtc-tile"),
    ].filter(t => t.id !== focusedId);

    // Move them all into the panel
    allOther.forEach(t => focusTiles.appendChild(t));

    // Show max 4 tiles, hide the rest
    const MAX_PANEL = 4;
    const panelTiles = [...focusTiles.querySelectorAll(".wrtc-tile")];
    panelTiles.forEach((t, i) => { t.style.display = i < MAX_PANEL ? "" : "none"; });

    const overflow = Math.max(0, panelTiles.length - MAX_PANEL);
    if (overflow > 0) {
      focusMore.textContent  = `+${overflow} more`;
      focusMore.style.display = "";
    } else {
      focusMore.style.display = "none";
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
      document.getElementById("wrtc-local-video").srcObject = this._activeVideoStream();
      this._setupAudioAnalyser("local", this._localStream);
    } catch (err) {
      this._log("getUserMedia FAILED: " + err.message, undefined, "error");
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WebSocket
  // ═══════════════════════════════════════════════════════════════════════
  _getBrowserUID() {
    const key = 'wrtc_user_id';
    let uid = localStorage.getItem(key);
    if (!uid) {
      uid = 'uid_' + ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
      localStorage.setItem(key, uid);
    }
    return uid;
  }

  _setupWebSocket() {
    const nameParam = this._myName ? `&name=${encodeURIComponent(this._myName)}` : "";
    const reconnectParam = this._isReconnecting ? "&reconnect=1" : "";
    const uidParam = `&uid=${encodeURIComponent(this._getBrowserUID())}`;
    const url = `${this.serverUrl}/ws/meetings/${this.roomName}?token=${this.token}${nameParam}${reconnectParam}${uidParam}`;
    this._log("Connecting WebSocket: " + url);
    this._ws = new WebSocket(url);
    this._ws.onopen    = ()  => {
      console.log('[WRTC] WS opened  room=' + this.roomName + '  name=' + this._myName);
      this._log("WS connected", undefined, "ok");
      this._setStatus("ok");
      // Tell everyone in the room our name and current camera state
      this._sendWS({ type: "name", payload: { name: this._myName } });
      if (!this._camEnabled) {
        this._sendWS({ type: "cam-state", payload: { enabled: false } });
      }
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

    // Use the currently active video track (screen share > filter > camera) so
    // peers that connect after sharing started receive the correct stream
    // instead of the stale camera track from _localStream.
    const videoTrack = this._activeVideoTrack();
    const audioTrack = this._localStream?.getAudioTracks()[0] ?? null;
    if (videoTrack) pc.addTrack(videoTrack, this._localStream);
    if (audioTrack) pc.addTrack(audioTrack, this._localStream);

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
      // Ensure the grid is visible once a peer connects — critical for participants
      // who join with no tracks (camera/mic denied) since ontrack never fires for them,
      // meaning _updateGrid would otherwise never be called with remoteCount > 0.
      if (s === "connected") {
        this._updateGrid();
        // Re-trigger play() on the remote video in case it stalled before connection was ready.
        const videoEl = document.getElementById(`wrtc-vid-${remoteUserId}`);
        if (videoEl && videoEl.srcObject) videoEl.play().catch(() => {});
        // Re-broadcast presenting state so a rejoining peer learns the current
        // presentation is active (the initial signal was already consumed).
        if (this._isSharing) {
          this._sendWS({ type: "presenting", payload: { active: true } });
        }
      }
      // Only hard-cleanup on "failed" — "disconnected" is transient and can self-recover.
      // Intentional leaves (host refresh, tab close) are cleaned up by the WS "leave" message.
      if (s === "failed") this._cleanupPeer(remoteUserId);
    };

    this._peerConnections[remoteUserId] = pc;
    // Show grid immediately when any peer connection is created — don't wait for "connected"
    // state since ICE negotiation can take several seconds and the tile is already in the DOM.
    this._updateGrid();
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
        // Show sub-tabs for everyone — guests need the Private tab to receive host replies
        const subtabs = document.getElementById("wrtc-chat-subtabs");
        if (subtabs) subtabs.style.display = "flex";
        // Re-announce our name and camera state — messages sent in onopen are consumed
        // by the knock-wait drain loop and never reach the main relay, so we re-send
        // them here after admission when the main message loop is active.
        this._sendWS({ type: "name", payload: { name: this._myName } });
        if (!this._camEnabled) {
          this._sendWS({ type: "cam-state", payload: { enabled: false } });
        }
        // Populate participants for users already in room (names arrive via "name" messages)
        payload.users.forEach(uid => { this._participants[uid] = this._displayName(uid); });
        this._renderParticipants();
        // Pre-create tiles for existing participants so they appear immediately in the grid
        // even if they have no camera/mic tracks (ontrack would never fire for them).
        payload.users.forEach(uid => this._ensureRemoteTile(uid));
        this._updateGrid();  // set initial solo/grid state
        // Show host welcome card
        if (this._isHost) this._showMeetingReadyCard();
        break;

      case "join":
        if (payload.name) this._peerNames[payload.user_id] = payload.name;
        this._participants[payload.user_id] = this._displayName(payload.user_id);
        this._renderParticipants();
        // Pre-create the tile immediately so participant is visible in the grid
        // even if they join with no camera/mic tracks (ontrack would never fire).
        this._ensureRemoteTile(payload.user_id);
        // Tell the new joiner our name and camera state
        this._sendWS({ type: "name", payload: { name: this._myName } });
        if (!this._camEnabled) {
          this._sendWS({ type: "cam-state", payload: { enabled: false } });
        }
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
        sessionStorage.removeItem("wrtc_chat_" + this.roomName);
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
        if (presenterTile?.classList.contains("presenter")) {
          if (this._presenterUserId === payload.user_id) this._presenterUserId = null;
          this._clearPresenter();
        }
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

      case "chat:history": {
        if (this._chatRestoredFromSession) break; // already have local history
        const msgs = payload.messages || [];
        msgs.forEach(({ from: mFrom, payload: mPayload }) => {
          const mName = this._displayName(mFrom) || mFrom?.slice(0, 8) || '?';
          const isMine = mFrom === this._myUserId;
          this._renderMessage(mName, mPayload.text, mPayload.ts || Date.now(), isMine, "public", false, null);
        });
        break;
      }

      case "chat": {
        const name = this._displayName(from);
        this._renderMessage(name, payload.text, payload.ts || Date.now(), false, "public");
        if (this._panelTab !== "chat") {
          this._unread++;
          const n = this._unread > 9 ? "9+" : this._unread;
          ["wrtc-chat-badge","wrtc-chat-badge-btn","wrtc-chat-badge-menu"].forEach(id => {
            const b = document.getElementById(id);
            if (b) { b.textContent = n; b.classList.add("show"); }
          });
        }
        // Host messages show as popup; guest messages show as regular toast
        if (payload.isHostMsg) {
          this._showMsgPopup(name, payload.text);
        } else if (this._panelTab !== "chat") {
          this._toast(`${name}: ${payload.text.slice(0, 40)}${payload.text.length > 40 ? "…" : ""}`);
        }
        break;
      }

      case "chat-private": {
        const name = this._displayName(from);
        // Render in private tab for everyone (host receives from guests, guest receives from host)
        this._renderMessage(name, payload.text, payload.ts || Date.now(), false, "private", true, this._isHost ? from : null);
        // Badge the private tab if not currently viewing it
        if (this._chatSubTab !== "private") {
          this._privateUnread++;
          const badge = document.getElementById("wrtc-private-badge");
          if (badge) {
            badge.textContent = this._privateUnread > 9 ? "9+" : this._privateUnread;
            badge.classList.add("show");
          }
          if (this._panelTab !== "chat") {
            this._unread++;
            const n = this._unread > 9 ? "9+" : this._unread;
            ["wrtc-chat-badge","wrtc-chat-badge-btn","wrtc-chat-badge-menu"].forEach(id => {
              const b = document.getElementById(id);
              if (b) { b.textContent = n; b.classList.add("show"); }
            });
          }
          this._toast(`🔒 Private from ${name}: ${payload.text.slice(0, 30)}${payload.text.length > 30 ? "…" : ""}`);
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
          const alreadyPresenting = this._presenterUserId === from;
          this._presenterUserId = from;
          // Only toast on the first announcement — re-broadcasts (triggered when a
          // participant refreshes and reconnects) should not repeat the toast.
          if (!alreadyPresenting) this._toast(`${name} is presenting`);
          this._waitForPresenterVideo(from);
        } else {
          if (this._presenterUserId === from) this._presenterUserId = null;
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

      case "error":
        this._log("Server error: " + payload.detail, undefined, "error");
        if (payload.code === "mau_limit_reached") {
          this._localStream?.getTracks().forEach(t => t.stop());
          this._ws?.close();
          this.parentNode.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#202124;z-index:99999;';
          this.parentNode.innerHTML =
            '<div style="text-align:center;padding:40px;background:#2d2e31;border:1px solid #3c3f45;border-radius:16px;max-width:380px;font-family:sans-serif">' +
              '<div style="font-size:48px;margin-bottom:16px">\uD83D\uDEAB</div>' +
              '<h2 style="color:#e8eaed;font-size:18px;margin:0 0 8px;font-weight:500">Unable to join meeting</h2>' +
              '<p style="color:#9aa0a6;font-size:14px;margin:0">Please contact the admin to join this meeting.</p>' +
            '</div>';
        } else if (payload.code === "room_full") {
          this._localStream?.getTracks().forEach(t => t.stop());
          this._ws?.close();
          const limit   = payload.limit   || "?";
          const plan    = payload.plan    || "basic";
          this.parentNode.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#202124;z-index:99999;';
          this.parentNode.innerHTML =
            '<div style="text-align:center;padding:40px;background:#2d2e31;border:1px solid rgba(234,67,53,.35);border-radius:16px;max-width:420px;font-family:sans-serif">' +
              '<div style="font-size:52px;margin-bottom:16px">🚫</div>' +
              '<h2 style="color:#e8eaed;font-size:20px;margin:0 0 10px;font-weight:600">Meeting is Full</h2>' +
              '<p style="color:#9aa0a6;font-size:14px;line-height:1.6;margin:0 0 16px">' +
                'This meeting has reached its limit of <strong style="color:#e8eaed">' + limit + ' participant(s)</strong> ' +
                'on the <strong style="color:#8ab4f8">' + plan + '</strong> plan.<br>' +
                'Someone needs to leave before you can join.' +
              '</p>' +
              '<div style="background:rgba(138,180,248,.08);border:1px solid rgba(138,180,248,.2);border-radius:10px;padding:12px 16px;margin-bottom:20px">' +
                '<p style="color:#8ab4f8;font-size:13px;margin:0">Ask the meeting host to upgrade their plan to allow more participants.</p>' +
              '</div>' +
              '<button onclick="window.location.reload()" style="background:#1a73e8;color:#fff;border:none;border-radius:8px;padding:10px 28px;font-size:14px;font-weight:500;cursor:pointer;">Try Again</button>' +
            '</div>';
        }
        break;

      case "cam-state": {
        this._camStates[from] = payload.enabled;
        const avatarEl = document.getElementById(`wrtc-avatar-${from}`);
        if (avatarEl) avatarEl.classList.toggle("visible", !payload.enabled);
        break;
      }

      case "mau_warning":
        this._toastLong("⚠️ MAU limit reached — a participant was blocked. Upgrade your plan to allow more participants.");
        break;

      case "room_full_warning": {
        const name  = payload.name    || "A participant";
        const cur   = payload.current || "?";
        const lim   = payload.limit   || "?";
        const plan  = payload.plan    || "basic";
        this._toastLong(`🚫 ${name} couldn't join — meeting is full (${cur}/${lim} on ${plan} plan). Upgrade your plan to increase capacity.`);
        break;
      }

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
        sessionStorage.removeItem('wrtc_chat_' + this.roomName);
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

  // Re-send a fresh offer to every connected peer so the SDP reflects the
  // current track (screen share / filter / camera). Called after any track
  // swap to let the browser renegotiate codec settings and bandwidth — this
  // is what makes transitions smoother instead of relying on replaceTrack alone.
  async _renegotiateAll() {
    for (const [remoteUserId, pc] of Object.entries(this._peerConnections)) {
      if (!pc || ["closed", "failed"].includes(pc.connectionState)) continue;
      // Skip if a negotiation is already in flight — avoids SDP glare.
      if (pc.signalingState !== "stable") continue;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._sendWS({ type: "offer", to: remoteUserId, payload: { sdp: pc.localDescription } });
      } catch (e) {
        this._log(`renegotiate failed [${remoteUserId}]: ${e.message}`, undefined, "warn");
      }
    }
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
    // Handle focus mode when a user leaves
    const leavingTileId = `wrtc-tile-${userId}`;
    if (this._focusTileId === leavingTileId) {
      // Focused tile is leaving — exit focus cleanly without touching the tile
      this._focusTileId = null; // clear first so _updateGrid runs in grid mode
      const grid       = document.getElementById("wrtc-grid");
      const focusTiles = document.getElementById("wrtc-focus-tiles");
      const focusWrap  = document.getElementById("wrtc-focus-wrap");
      if (focusTiles && grid) {
        [...focusTiles.querySelectorAll(".wrtc-tile")].forEach(t => {
          t.style.display = "";
          grid.appendChild(t);
        });
      }
      const localTile = document.getElementById("wrtc-local-tile");
      if (localTile?.parentElement === grid) grid.prepend(localTile);
      if (focusWrap) focusWrap.style.display = "none";
      if (grid) grid.style.display = "";
    }
    document.getElementById(leavingTileId)?.remove();
    // Remove this user's thumb from the presentation strip (if active).
    document.querySelectorAll(`#wrtc-thumbs .wrtc-thumb-tile[data-user-id="${userId}"]`)
      .forEach(t => t.remove());
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

  // Creates the tile DOM for a remote participant if it doesn't exist yet.
  // Avatar is shown by default — it is hidden only when a live video track arrives
  // or when cam-state:true is received. This ensures participants with no tracks
  // (camera permanently denied) are always visible as an avatar tile.
  // Safe to call multiple times — idempotent.
  _ensureRemoteTile(userId) {
    if (document.getElementById(`wrtc-tile-${userId}`)) return;
    const grid = document.getElementById("wrtc-grid");
    if (!grid) return;

    const tile = document.createElement("div");
    tile.id        = `wrtc-tile-${userId}`;
    tile.className = "wrtc-tile";

    const video = document.createElement("video");
    video.id          = `wrtc-vid-${userId}`;
    video.autoplay    = true;
    video.playsInline = true;

    const avatarWrap = document.createElement("div");
    avatarWrap.className = "wrtc-tile-avatar";
    avatarWrap.id        = `wrtc-avatar-${userId}`;
    const avatar = document.createElement("span");
    avatar.style.background = this._colorFromId(userId);
    avatar.textContent      = this._getInitials(this._displayName(userId));
    avatarWrap.appendChild(avatar);

    // Show avatar by default. It is hidden when we know camera is on
    // (cam-state:true) or when a live video track is wired up in _addRemoteVideo.
    avatarWrap.classList.add("visible");

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

    tile.addEventListener("click", () => {
      if (this._focusTileId === tile.id) return;
      if (this._focusTileId) { this._switchFocusTile(tile.id); return; }
      this._enterFocusMode(tile.id);
    });

    tile.append(video, avatarWrap, badge, label, hand);
    grid.appendChild(tile);
    this._updateGrid();
  }

  // Called when a remote track arrives. Ensures the tile exists, then wires up the stream.
  _addRemoteVideo(userId, stream) {
    this._ensureRemoteTile(userId);

    const videoEl    = document.getElementById(`wrtc-vid-${userId}`);
    const avatarWrap = document.getElementById(`wrtc-avatar-${userId}`);

    if (videoEl) {
      // Only update srcObject if the stream actually changed — avoids resetting a
      // playing video when the second ontrack event (audio track) arrives.
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
      }
      // Explicitly call play() — Chrome may not honour autoplay on programmatically
      // created video elements after a page reconnect (autoplay policy).
      videoEl.play().catch(() => {});
    }

    // If presenting mode is active, the thumbs strip was already built.
    // A tile that arrives late (joiner after share started) won't be in it —
    // add it now that the stream is wired up and srcObject is non-null.
    const tile   = document.getElementById(`wrtc-tile-${userId}`);
    const thumbs = document.getElementById("wrtc-thumbs");
    if (tile && thumbs?.style.display === "flex") {
      // Only add if this tile isn't already represented in the strip.
      const alreadyInThumbs = [...thumbs.querySelectorAll(".wrtc-thumb-tile")]
        .some(t => t.dataset.userId === userId);
      if (!alreadyInThumbs) {
        this._addThumbTagged(tile, thumbs, userId);
        tile.style.display = "none";
      }
    }

    if (avatarWrap) {
      // A live video track is arriving — hide avatar unless cam-state says camera is off.
      if (stream.getVideoTracks().length > 0 && this._camStates[userId] !== false) {
        avatarWrap.classList.remove("visible");
      }
      // If cam-state explicitly says camera is off, keep avatar visible.
      if (this._camStates[userId] === false) {
        avatarWrap.classList.add("visible");
      }
      // Track mute events: "unmute" fires when black frames arrive (track.enabled=false
      // on sender), so only hide avatar if cam-state confirms camera is actually on.
      stream.getVideoTracks().forEach(track => {
        track.addEventListener("mute",   () => avatarWrap.classList.add("visible"));
        track.addEventListener("unmute", () => {
          if (this._camStates[userId] !== false) avatarWrap.classList.remove("visible");
        });
      });
    }
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

  _getInitials(name) {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

  // ═══════════════════════════════════════════════════════════════════════
  // VIRTUAL BACKGROUND
  // ═══════════════════════════════════════════════════════════════════════

  _toggleVBGPanel() {
    const overlay = document.getElementById("wrtc-vbg-overlay");
    if (!overlay) return;
    const open = overlay.style.display !== "none";
    if (open) { this._closeVBGPanel(); return; }
    overlay.style.display = "flex";
    this._refreshVBGPanel();
  }

  _closeVBGPanel() {
    const overlay = document.getElementById("wrtc-vbg-overlay");
    if (overlay) overlay.style.display = "none";
  }

  _refreshVBGPanel() {
    document.querySelectorAll(".wrtc-vbg-opt").forEach(el => {
      el.classList.toggle("active", el.dataset.bg === this._bgFilter);
    });
  }

  async _selectVBG(type) {
    if (type === this._bgFilter) return;
    this._bgFilter = type;
    this._refreshVBGPanel();
    sessionStorage.setItem("wrtc_bg_filter_" + this.roomName, type);
    const statusEl = document.getElementById("wrtc-vbg-status");
    const label    = document.getElementById("wrtc-more-vbg-label");

    if (type === "none") {
      await this._disableVirtualBg();
      if (statusEl) statusEl.textContent = "";
      if (label) label.textContent = "Virtual Background";
      return;
    }

    if (statusEl) statusEl.textContent = "Loading background model…";
    if (label) label.textContent = "Virtual Background ✓";
    try {
      await this._enableVirtualBg(type);
      if (statusEl) statusEl.textContent = "";
    } catch (e) {
      console.warn("[VBG] failed:", e);
      if (statusEl) statusEl.textContent = "Could not load background model — using normal video.";
      this._bgFilter = "none";
      this._refreshVBGPanel();
      if (label) label.textContent = "Virtual Background";
      await this._disableVirtualBg();
    }
  }

  async _enableVirtualBg(type) {
    // Pre-load background image (not needed for blur)
    if (type !== "blur" && !this._bgImages[type]) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error("bg image load failed"));
        img.src = `${this._httpBase}/api/v1/bg/${type}.jpg?v=2`;
      });
      this._bgImages[type] = img;
    }

    // Lazy-load MediaPipe Selfie Segmentation from CDN
    await this._loadMediaPipe();

    // Init the segmentation model once
    if (!this._selfieSegmentation) {
      const seg = new window.SelfieSegmentation({
        locateFile: f =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/${f}`
      });
      seg.setOptions({ modelSelection: 0, selfieMode: false });
      seg.onResults(r => this._onSegResults(r));
      await seg.initialize();
      this._selfieSegmentation = seg;
    }

    // Hidden source video — feeds raw camera into MediaPipe
    if (!this._filterSrcVid) {
      const vid = document.createElement("video");
      vid.autoplay = true; vid.muted = true; vid.playsInline = true;
      vid.style.cssText = "position:fixed;width:1px;height:1px;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(vid);
      this._filterSrcVid = vid;
    }
    this._filterSrcVid.srcObject = this._localStream;
    await this._filterSrcVid.play().catch(() => {});

    // Output canvas — 480×270 keeps quality acceptable while halving pixel count vs 640×360
    const W = 480, H = 270;
    if (!this._filterCanvas) {
      this._filterCanvas = document.createElement("canvas");
      this._filterCanvas.width  = W;
      this._filterCanvas.height = H;
      this._filterCtx = this._filterCanvas.getContext("2d");
    }

    // Capture the canvas as a MediaStream
    if (this._filterStream) this._filterStream.getTracks().forEach(t => t.stop());
    this._filterStream = this._filterCanvas.captureStream(25);

    // Replace video track in all active peer connections
    const newTrack = this._filterStream.getVideoTracks()[0];
    await this._replaceVideoTrackInPeers(newTrack);
    this._renegotiateAll(); // renegotiate so peers get updated SDP for filter track

    // Point the local preview at the filtered stream.
    // The canvas has no frames yet when srcObject is first set, so play() may
    // fail or stall. Retry at increasing intervals until the video is playing.
    const lv = document.getElementById("wrtc-local-video");
    if (lv) {
      lv.srcObject = this._filterStream;
      lv.style.display = "block";
      document.getElementById("wrtc-pip-avatar").style.display = "none";
      const _tryPlay = () => {
        if (this._bgFilter === "none" || !this._filterStream) return;
        if (lv.srcObject !== this._filterStream) lv.srcObject = this._filterStream;
        lv.play().catch(() => {});
      };
      _tryPlay();
      [100, 300, 700].forEach(ms => setTimeout(_tryPlay, ms));
    }

    // Update local thumb in the right-panel strip (visible when someone else is presenting).
    // The thumb srcObject was captured at presentation start — we must update it now
    // so the filter appears in the user's own thumbnail during screen share.
    const localThumb = document.querySelector(
      '#wrtc-thumbs .wrtc-thumb-tile[data-user-id="wrtc-local-tile"] video'
    );
    if (localThumb) {
      const _tryThumbPlay = () => {
        if (this._bgFilter === "none" || !this._filterStream) return;
        if (localThumb.srcObject !== this._filterStream) localThumb.srcObject = this._filterStream;
        localThumb.play().catch(() => {});
      };
      _tryThumbPlay();
      [100, 300, 700].forEach(ms => setTimeout(_tryThumbPlay, ms));
    }

    // Start the per-frame processing loop
    this._stopFilterLoop();
    this._filterTick();
  }

  async _disableVirtualBg() {
    this._stopFilterLoop();

    if (this._filterStream) {
      this._filterStream.getTracks().forEach(t => t.stop());
      this._filterStream = null;
    }

    // Restore original camera track in all peers
    const origTrack = this._localStream?.getVideoTracks()[0] ?? null;
    await this._replaceVideoTrackInPeers(origTrack);
    this._renegotiateAll(); // renegotiate so peers get updated SDP when filter removed

    // Restore local preview
    const lv = document.getElementById("wrtc-local-video");
    if (lv) lv.srcObject = this._localStream;

    // Restore local thumb in right-panel strip to raw camera stream
    const localThumb = document.querySelector(
      '#wrtc-thumbs .wrtc-thumb-tile[data-user-id="wrtc-local-tile"] video'
    );
    if (localThumb) {
      localThumb.srcObject = this._localStream;
      localThumb.play().catch(() => {});
    }
  }

  // Returns the video track that should be sent to peers right now.
  // Priority: screen share > virtual background filter > raw camera.
  // Used when wiring new peer connections so they receive the correct track
  // even if they connect after _replaceVideoTrack() was called for existing peers.
  _activeVideoTrack() {
    if (this._isSharing && this._shareStream) {
      return this._shareStream.getVideoTracks()[0] ?? null;
    }
    if (this._bgFilter !== "none" && this._filterStream) {
      return this._filterStream.getVideoTracks()[0] ?? null;
    }
    return this._localStream?.getVideoTracks()[0] ?? null;
  }

  // Returns the stream that should be shown in the local video preview.
  // When a filter is active use _filterStream, otherwise _localStream.
  _activeVideoStream() {
    return (this._bgFilter !== "none" && this._filterStream) ? this._filterStream : this._localStream;
  }

  _stopFilterLoop() {
    if (this._filterAnimId) {
      cancelAnimationFrame(this._filterAnimId);
      this._filterAnimId = null;
    }
  }

  async _filterTick() {
    if (this._bgFilter === "none" || !this._filterSrcVid || !this._selfieSegmentation) return;
    const now = performance.now();
    // Throttle to 20fps — avoids CPU saturation on mid/low-end devices
    if (this._filterSrcVid.readyState >= 2 &&
        (!this._lastFilterTime || now - this._lastFilterTime >= 50)) {
      this._lastFilterTime = now;
      try { await this._selfieSegmentation.send({ image: this._filterSrcVid }); }
      catch (_) { /* drop frame */ }
    }
    this._filterAnimId = requestAnimationFrame(() => this._filterTick());
  }

  _onSegResults(results) {
    const ctx = this._filterCtx;
    if (!ctx || !this._filterCanvas) return;
    const W = this._filterCanvas.width;
    const H = this._filterCanvas.height;

    ctx.clearRect(0, 0, W, H);

    // Step 1: draw raw camera frame — no mirroring here.
    // The local <video> already has CSS scaleX(-1) for the selfie flip;
    // the stream sent to remote peers must be in natural orientation.
    ctx.drawImage(results.image, 0, 0, W, H);

    // Step 2: mask keeps only person pixels (mask and image share same orientation).
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(results.segmentationMask, 0, 0, W, H);

    // Step 3: paint replacement background behind the person.
    ctx.globalCompositeOperation = "destination-over";
    if (this._bgFilter === "blur") {
      ctx.filter = "blur(14px)";
      ctx.drawImage(results.image, 0, 0, W, H);
      ctx.filter = "none";
    } else {
      const bgImg = this._bgImages[this._bgFilter];
      if (bgImg && bgImg.complete) {
        ctx.drawImage(bgImg, 0, 0, W, H);
      } else {
        ctx.fillStyle = "#202124";
        ctx.fillRect(0, 0, W, H);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  async _replaceVideoTrackInPeers(newTrack) {
    for (const pc of Object.values(this._peerConnections)) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) {
        try { await sender.replaceTrack(newTrack); } catch (_) {}
      }
    }
  }

  _loadMediaPipe() {
    return new Promise((resolve, reject) => {
      if (window.SelfieSegmentation) { resolve(); return; }
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/selfie_segmentation.js";
      s.crossOrigin = "anonymous";
      s.onload  = resolve;
      s.onerror = () => reject(new Error("Failed to load MediaPipe from CDN"));
      document.head.appendChild(s);
    });
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
    sessionStorage.removeItem('wrtc_chat_' + this.roomName);
    sessionStorage.removeItem('wrtc_ready_dismissed_' + this.roomName);
    sessionStorage.removeItem('wrtc_bg_filter_' + this.roomName);
    this._sendWS({ type: "leave", payload: {} });
    Object.keys(this._peerConnections).forEach(id => this._cleanupPeer(id));
    this._ws?.close();
    this._localStream?.getTracks().forEach(t => t.stop());
    this._filterStream?.getTracks().forEach(t => t.stop());
    this._stopFilterLoop();
    if (this._filterSrcVid) { this._filterSrcVid.srcObject = null; this._filterSrcVid.remove(); this._filterSrcVid = null; }
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
