  // ═══════════════════════════════════════════════════════════════════════════
// WebRTCMeetingAPI — embeddable WebRTC meeting SDK
// ═══════════════════════════════════════════════════════════════════════════
(function () {
if (window.WebRTCMeetingAPI) return; // already loaded — skip re-declaration
class WebRTCMeetingAPI {

  constructor({ serverUrl, roomName, token = "", hostToken = "", guestToken = "", shareUrl = "", embedToken = "", reconnect = false, parentNode, onLeave = null, logoUrl = "", upgradePlanUrl = "", branding = null, theme = null, recordingEndpoint = "", recordingToken = "", recordingAddonEnabled = true }) {
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
    this._embedToken        = embedToken;
    this._recordingEndpoint     = recordingEndpoint;
    this._recordingToken        = recordingToken;
    this._recordingAddonEnabled = recordingAddonEnabled;
    this._branding          = branding || null;
    this._theme      = (branding && branding.theme) || theme || null;
    // Resolve relative logo paths against the backend origin (from script tag)
    if (logoUrl && logoUrl.startsWith('/')) {
      this._logoUrl = this._httpBase + logoUrl;
    } else {
      this._logoUrl = logoUrl || "";
    }
    this.parentNode      = parentNode;
    this._onLeave        = onLeave;
    this._upgradePlanUrl = upgradePlanUrl || "";

    // WebRTC state
    this._ws                = null;
    this._localStream       = null;
    this._peerConnections   = {};
    this._pendingCandidates = {};

    // ── SFU (mediasoup-client) ─────────────────────────────────────────────
    this._sfuAvailable      = false;  // server confirmed mediasoup is reachable
    this._sfuRtpCaps        = null;   // cached rtpCapabilities from sfu:rtpCapabilities
    this._sfuDevice         = null;   // mediasoup Device instance
    this._sfuSendTransport  = null;   // outgoing WebRTC transport
    this._sfuRecvTransport  = null;   // incoming WebRTC transport
    this._sfuAudioProducer  = null;   // local audio Producer
    this._sfuVideoProducer  = null;   // local video Producer
    this._sfuConsumers      = {};     // consumerId → { consumer, peerId, kind }
    this._sfuPeerStreams     = {};     // peerId → MediaStream (for remote video display)
    this._sfuResolvers      = {};     // pendingKey → { resolve, reject }
    this._sfuProduceCallback = null;  // { callback, errback } for produce event
    this._sfuInitDone       = false;  // guard: prevent duplicate init

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
    this._chatSubTab     = "public"; // "public" | "private"
    this._popupTimer     = null;
    this._privateReplyTo = null;    // { userId, name } — host's active reply target

    // Raise hand
    this._handRaised  = false;
    this._raisedHands = new Set();

    // Host tracking
    this._myUserId   = null;
    this._isHost     = false;
    this._hostUserId = null;  // userId of the current host (for labelling)

    // Active speaker
    this._audioCtx       = null;
    this._analysers      = {};   // userId → AnalyserNode
    this._speakerTimer   = null;
    this._speakerRafId   = null; // requestAnimationFrame handle for mic animation
    this._currentSpeaker = null;
    this._smoothedLevels = {};   // userId → smoothed audio level [0–1]

    // Names & participants
    this._myName        = "";
    this._peerNames     = {};   // userId → display name
    this._participants  = {};   // userId → name (everyone in room)
    this._camStates     = {};   // userId → boolean (true=on, false=off)
    this._micStates     = {};   // userId → boolean (true=on, false=off)
    this._leaveTimers    = {};      // baseUserId → setTimeout handle (deferred "X left" chat msg)
    this._announcedJoins = new Set(); // base user IDs that have already shown "X joined"
    // Host-side tracking: which participants were force-muted/cam-offed by admin
    this._hostForcedOffCam = new Set();
    this._hostForcedOffMic = new Set();
    this._panelTab      = null; // "people" | "chat" | null

    // Misc
    this._isLeaving          = false;
    this._uiBuilt            = false;
    this._isReconnecting          = reconnect;
    this._meetingStart            = null;
    this._serverMeetingStartedAt  = null; // epoch ms from server user-list payload
    this._settings                = {}; // meeting permissions from server
    this._ownerPlan          = null;   // plan of the project owner (null = free/basic)
    this._isPublicMeeting    = false;  // true for public-meet rooms
    this._allowRecording     = true;   // set by project owner in dashboard settings
    // WebSocket auto-reconnect state
    this._wsReconnectTimer    = null;
    this._wsReconnectAttempts = 0;

    // Host-mute tracking (participants)
    this._hostMutedMic  = false; // true = host muted my mic
    this._hostMutedCam  = false; // true = host muted my cam
    // Self-mute tracking — set only by participant's own toggle, never by host
    this._selfMutedMic  = false;
    this._selfMutedCam  = false;
    // Strict lock: when set by host, participant cannot re-enable until unlocked
    this._micLocked     = false;
    this._camLocked     = false;
    // Host bulk-action state (host side)
    this._allMicsMuted  = false;
    this._allCamsMuted  = false;
    this._clockTimer  = null;
    this._toastTimer  = null;
    this._currentMicId     = null;
    this._currentCamId     = null;
    this._currentSpeakerId = null;
    this._knownDeviceIds = new Set();
    this._devToastTimer  = null;
    this._pendingSwitch  = null;

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
        this._log('embed-check status: ' + res.status + ' ok=' + res.ok);
        if (!res.ok) { this._showAccessDenied(); return; }
        if (savedName) { this._showReconnecting(savedName); } else { this._buildLobby(); }
      })
      .catch((err) => { this._log('embed-check failed: ' + err, undefined, "error"); this._showAccessDenied(); });
  }

  _showEmbedPrescreen() {
    const SESSION_KEY = 'wrtc_active_meeting_' + this._embedToken.slice(-8);

    // Override _onLeave before any early returns so all leave paths (normal, end-meeting,
    // transfer+leave, refresh+leave) always clear the session key and return to prescreen.
    const externalOnLeave = this._onLeave;
    this._onLeave = (reason) => {
      sessionStorage.removeItem(SESSION_KEY);
      if (typeof externalOnLeave === 'function') externalOnLeave(reason);
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
      .ep-sched-btn{background:transparent;color:#9aa0a6;border:1.5px solid rgba(255,255,255,.12);border-radius:10px;padding:11px;font-size:14px;font-weight:500;cursor:pointer;width:100%;margin-top:8px;transition:all .15s}
      .ep-sched-btn:hover{color:#e8eaed;border-color:rgba(255,255,255,.28)}
      .ep-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}
      .ep-modal{background:#1e2230;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:28px 28px 24px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e8eaed}
      .ep-modal h3{font-size:17px;font-weight:700;margin:0 0 4px}
      .ep-modal-sub{font-size:13px;color:#9aa0a6;margin-bottom:20px}
      .ep-label{font-size:12px;color:#9aa0a6;font-weight:500;margin-bottom:6px;display:block;letter-spacing:.03em}
      .ep-field{margin-bottom:14px}
      .ep-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .ep-inp2{background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 12px;color:#e8eaed;font-size:14px;width:100%;outline:none;box-sizing:border-box}
      .ep-inp2:focus{border-color:#1a73e8}.ep-inp2::placeholder{color:#5f6368}
      .ep-inp2 option{background:#1e2230}
      .ep-tag-wrap{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      .ep-tag{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:3px 10px 3px 12px;font-size:12px;color:#e8eaed}
      .ep-tag button{background:none;border:none;cursor:pointer;color:#9aa0a6;padding:0;line-height:1;font-size:14px}
      .ep-add-row{display:flex;gap:8px}
      .ep-add-btn{background:rgba(255,255,255,.08);color:#e8eaed;border:1.5px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 16px;font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap}
      .ep-add-btn:hover{background:rgba(255,255,255,.13)}
      .ep-modal-err{color:#ea4335;font-size:13px;margin:0 0 10px;display:none}
      .ep-modal-ok{color:#34a853;font-size:13px;margin:0 0 10px;display:none}
      .ep-modal-foot{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}
      .ep-cancel{background:transparent;color:#9aa0a6;border:1.5px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 20px;font-size:14px;font-weight:500;cursor:pointer}
      .ep-cancel:hover{color:#e8eaed}
      .ep-send{background:linear-gradient(135deg,#1a73e8,#4d94ff);color:#fff;border:none;border-radius:10px;padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(26,115,232,.35)}
      .ep-send:disabled{opacity:.5;cursor:not-allowed}
    </style>
    <div class="ep">
      <div class="ep-hdr"><h2 id="ep-title">Meeting Room</h2><p>Create a new meeting or join a previous one</p></div>
      <div class="ep-card"><h3>New Meeting</h3>
        <input id="ep-inp" class="ep-input" type="text" placeholder="Enter meeting title…" maxlength="255"/>
        <div id="ep-err" class="ep-err"></div>
        <button id="ep-create" class="ep-btn">Create &amp; Start</button>
        <button id="ep-sched-open" class="ep-sched-btn">&#128197; Schedule Meeting</button>
      </div>
      <div class="ep-card" id="ep-card-instant"><h3>Instant Meetings</h3><div id="ep-list-instant"><div class="ep-spin"></div></div></div>
      <div class="ep-card" id="ep-card-sched-list"><h3>Scheduled Meetings</h3><div id="ep-list-sched"><div class="ep-spin"></div></div></div>
    </div>
    <div id="ep-sched-overlay" class="ep-overlay" style="display:none">
      <div class="ep-modal">
        <h3>Schedule Meeting</h3>
        <p class="ep-modal-sub">Send calendar invites to participants</p>
        <div class="ep-field">
          <label class="ep-label">Meeting Title</label>
          <input id="ep-s-title" class="ep-inp2" type="text" placeholder="e.g. Weekly Sync" maxlength="255"/>
        </div>
        <div class="ep-grid2">
          <div class="ep-field">
            <label class="ep-label">Date</label>
            <input id="ep-s-date" class="ep-inp2" type="date"/>
          </div>
          <div class="ep-field">
            <label class="ep-label">Time</label>
            <input id="ep-s-time" class="ep-inp2" type="time"/>
          </div>
        </div>
        <div class="ep-field">
          <label class="ep-label">Timezone</label>
          <select id="ep-s-tz" class="ep-inp2">
            <option value="UTC">UTC</option>
            <option value="America/New_York">US/Eastern (ET)</option>
            <option value="America/Chicago">US/Central (CT)</option>
            <option value="America/Denver">US/Mountain (MT)</option>
            <option value="America/Los_Angeles">US/Pacific (PT)</option>
            <option value="Europe/London">London (GMT/BST)</option>
            <option value="Europe/Paris">Paris/Berlin (CET)</option>
            <option value="Europe/Moscow">Moscow (MSK)</option>
            <option value="Asia/Dubai">Dubai (GST)</option>
            <option value="Asia/Kolkata">India (IST)</option>
            <option value="Asia/Dhaka">Bangladesh (BST)</option>
            <option value="Asia/Singapore">Singapore/KL (SGT)</option>
            <option value="Asia/Tokyo">Tokyo/Seoul (JST/KST)</option>
            <option value="Australia/Sydney">Sydney (AEST)</option>
            <option value="America/Sao_Paulo">São Paulo (BRT)</option>
          </select>
        </div>
        <div class="ep-field">
          <label class="ep-label">Invite Participants</label>
          <div class="ep-add-row">
            <input id="ep-s-email" class="ep-inp2" type="email" placeholder="email@example.com"/>
            <button id="ep-s-add" class="ep-add-btn">Add</button>
          </div>
          <div id="ep-s-tags" class="ep-tag-wrap"></div>
        </div>
        <p id="ep-s-err" class="ep-modal-err"></p>
        <p id="ep-s-ok" class="ep-modal-ok">&#10003; Invites sent successfully!</p>
        <div class="ep-modal-foot">
          <button id="ep-s-cancel" class="ep-cancel">Cancel</button>
          <button id="ep-s-send" class="ep-send">Send Invites</button>
        </div>
      </div>
    </div>`;

    // Apply project branding (color, logo) to prescreen UI
    this._applyBrandingToPrescreen();

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

    // Load past meetings — split into instant and scheduled
    fetch(this._httpBase + '/api/v1/projects/my-meetings?embed_token=' + encodeURIComponent(this._embedToken))
      .then(r => r.json())
      .then(list => {
        const elI = document.getElementById('ep-list-instant');
        const elS = document.getElementById('ep-list-sched');
        if (!list || !list.length) {
          elI.innerHTML = '<p class="ep-empty">No instant meetings yet.</p>';
          elS.innerHTML = '<p class="ep-empty">No scheduled meetings yet.</p>';
          return;
        }
        const instant   = list.filter(m => !m.scheduled_at);
        const scheduled = list.filter(m =>  m.scheduled_at);

        function renderRow(m, isScheduled) {
          const dateStr = isScheduled
            ? new Date(m.scheduled_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
            : new Date(m.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
          const calIcon = isScheduled ? '<span style="color:#34a853;margin-right:4px">&#128197;</span>' : '';
          return `<div class="ep-row">
            <div><div class="ep-row-title">${calIcon}${m.title}</div>
            <div class="ep-row-date">${isScheduled ? 'Scheduled: ' : ''}${dateStr}</div></div>
            <button class="ep-join" data-room="${m.room_name}" data-token="${m.host_token}" data-share="${m.share_url}">Join</button>
          </div>`;
        }

        elI.innerHTML = instant.length
          ? instant.map(m => renderRow(m, false)).join('')
          : '<p class="ep-empty">No instant meetings yet.</p>';
        elS.innerHTML = scheduled.length
          ? scheduled.map(m => renderRow(m, true)).join('')
          : '<p class="ep-empty">No scheduled meetings yet.</p>';

        document.querySelectorAll('.ep-join').forEach(btn => {
          btn.addEventListener('click', function() { startMeeting(this.dataset.room, this.dataset.token, this.dataset.share); });
        });
      })
      .catch(() => {
        const elI = document.getElementById('ep-list-instant');
        const elS = document.getElementById('ep-list-sched');
        if(elI) elI.innerHTML = '<p class="ep-empty">Could not load meetings.</p>';
        if(elS) elS.innerHTML = '';
      });

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

    // ── Schedule Meeting modal ──────────────────────────────────────────────
    const schedOverlay = document.getElementById('ep-sched-overlay');
    const schedErrEl   = document.getElementById('ep-s-err');
    const schedOkEl    = document.getElementById('ep-s-ok');
    const schedSend    = document.getElementById('ep-s-send');
    const schedTitle   = document.getElementById('ep-s-title');
    const schedDate    = document.getElementById('ep-s-date');
    const schedTime    = document.getElementById('ep-s-time');
    const schedTz      = document.getElementById('ep-s-tz');
    const schedEmail   = document.getElementById('ep-s-email');
    const schedTags    = document.getElementById('ep-s-tags');
    let schedInvitees  = [];

    // Set today as min date and default timezone
    schedDate.min = new Date().toISOString().split('T')[0];
    try {
      const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (schedTz.querySelector('option[value="' + userTz + '"]')) schedTz.value = userTz;
    } catch(_) {}

    // Pre-fill title from meeting title input
    document.getElementById('ep-sched-open').addEventListener('click', () => {
      schedTitle.value = inp.value.trim() || '';
      schedInvitees = [];
      schedTags.innerHTML = '';
      schedErrEl.style.display = 'none';
      schedOkEl.style.display = 'none';
      schedEmail.value = '';
      schedSend.disabled = false;
      schedSend.textContent = 'Send Invites';
      schedOverlay.style.display = 'flex';
    });

    document.getElementById('ep-s-cancel').addEventListener('click', () => { schedOverlay.style.display = 'none'; });
    schedOverlay.addEventListener('click', e => { if (e.target === schedOverlay) schedOverlay.style.display = 'none'; });

    function renderTags() {
      schedTags.innerHTML = schedInvitees.map(em =>
        `<span class="ep-tag">${em}<button data-em="${em}" title="Remove">&times;</button></span>`
      ).join('');
      schedTags.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        schedInvitees = schedInvitees.filter(x => x !== b.dataset.em);
        renderTags();
      }));
    }

    function addInvitee() {
      const email = schedEmail.value.trim().toLowerCase();
      if (!email) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { schedErrEl.textContent = 'Enter a valid email address'; schedErrEl.style.display = 'block'; return; }
      if (schedInvitees.includes(email)) { schedErrEl.textContent = 'Already added'; schedErrEl.style.display = 'block'; return; }
      schedInvitees.push(email);
      schedEmail.value = '';
      schedErrEl.style.display = 'none';
      renderTags();
    }

    document.getElementById('ep-s-add').addEventListener('click', addInvitee);
    schedEmail.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addInvitee(); } });

    schedSend.addEventListener('click', () => {
      schedErrEl.style.display = 'none';
      schedOkEl.style.display = 'none';
      const title = schedTitle.value.trim();
      if (!title) { schedErrEl.textContent = 'Meeting title is required'; schedErrEl.style.display = 'block'; return; }
      if (!schedDate.value || !schedTime.value) { schedErrEl.textContent = 'Please pick a date and time'; schedErrEl.style.display = 'block'; return; }
      // Auto-add pending email
      const pending = schedEmail.value.trim().toLowerCase();
      if (pending && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pending) && !schedInvitees.includes(pending)) {
        schedInvitees.push(pending); schedEmail.value = ''; renderTags();
      }
      if (schedInvitees.length === 0) { schedErrEl.textContent = 'Add at least one invitee'; schedErrEl.style.display = 'block'; return; }

      schedSend.disabled = true; schedSend.textContent = 'Sending…';
      fetch(self._httpBase + '/api/v1/projects/embed-schedule-invite', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          embed_token: self._embedToken,
          meeting_title: title,
          scheduled_at: schedDate.value + 'T' + schedTime.value + ':00',
          timezone: schedTz.value,
          invitees: schedInvitees,
        })
      })
      .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.detail || 'Failed'); }))
      .then(() => {
        schedOkEl.style.display = 'block';
        schedSend.textContent = 'Sent!';
        setTimeout(() => { schedOverlay.style.display = 'none'; }, 2000);
      })
      .catch(e => {
        schedErrEl.textContent = e.message;
        schedErrEl.style.display = 'block';
        schedSend.disabled = false;
        schedSend.textContent = 'Send Invites';
      });
    });

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
            <span id="wrtc-lobby-media-status">Camera is off</span>
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

    // Apply theme immediately if known
    if (this._theme) this._applyTheme(this._theme);
    // Apply branding: use inline data if available (guest flow), else fetch via embed token
    if (this._branding && (this._branding.primary_color || this._branding.button_label || this._branding.welcome_message || this._branding.logo_url)) {
      this._applyBrandingData(this._branding);
    } else {
      this._applyBranding();
    }

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
            this._updateLobbyMediaStatus();
          })
          .catch(() => { /* permission denied — stay mic-off */ });
        return;
      }
      this._micEnabled = !this._micEnabled;
      this._localStream?.getAudioTracks().forEach(t => { t.enabled = this._micEnabled; });
      sessionStorage.setItem('wrtc_mic_' + this.roomName, this._micEnabled ? '1' : '0');
      document.getElementById("wrtc-lobby-mic").classList.toggle("muted", !this._micEnabled);
      document.getElementById("wrtc-lobby-mic-on").style.display  = this._micEnabled ? "" : "none";
      document.getElementById("wrtc-lobby-mic-off").style.display = this._micEnabled ? "none" : "";
      this._updateLobbyMediaStatus();
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
      sessionStorage.setItem('wrtc_cam_' + this.roomName, this._camEnabled ? '1' : '0');
      document.getElementById("wrtc-lobby-cam").classList.toggle("muted", !this._camEnabled);
      document.getElementById("wrtc-lobby-cam-on").style.display       = this._camEnabled ? "" : "none";
      document.getElementById("wrtc-lobby-cam-icon-off").style.display = this._camEnabled ? "none" : "";
      document.getElementById("wrtc-lobby-video").style.display        = this._camEnabled ? "block" : "none";
      document.getElementById("wrtc-lobby-cam-off").style.display      = this._camEnabled ? "none"  : "flex";
    });

    // Start camera preview, then auto-rejoin if session name exists
    this._initPreview().then(() => {
      previewReady = true;
      this._updateLobbyMediaStatus();
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

  _updateLobbyMediaStatus() {
    const el = document.getElementById("wrtc-lobby-media-status");
    if (!el) return;
    if (!this._camEnabled && !this._micEnabled) { el.textContent = "Camera and microphone are off"; }
    else { el.textContent = "Camera is off"; }
  }

  _showPermissionHint() {
    // Show a brief card over the camera preview area before the browser prompt appears.
    // Only shown if permission hasn't been granted already.
    const existing = document.getElementById("wrtc-perm-hint");
    if (existing) return;
    const card = document.createElement("div");
    card.id = "wrtc-perm-hint";
    Object.assign(card.style, {
      position: "absolute", inset: "0", zIndex: "20",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(13,15,20,.82)", backdropFilter: "blur(6px)",
      borderRadius: "inherit", padding: "24px",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    });
    card.innerHTML =
      '<div style="text-align:center;max-width:240px;">' +
        '<div style="width:52px;height:52px;border-radius:50%;background:rgba(26,115,232,.18);' +
          'border:1.5px solid rgba(26,115,232,.5);display:flex;align-items:center;justify-content:center;' +
          'margin:0 auto 14px;">' +
          '<svg width="26" height="26" viewBox="0 0 24 24" fill="#4d94ff">' +
            '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>' +
          '</svg>' +
        '</div>' +
        '<p style="color:#e8eaed;font-size:14px;font-weight:600;margin:0 0 8px;line-height:1.4">' +
          'Allow camera &amp; microphone access' +
        '</p>' +
        '<p style="color:rgba(255,255,255,.5);font-size:12px;margin:0;line-height:1.6">' +
          'Please click <strong style="color:rgba(255,255,255,.75)">Allow</strong> in the browser prompt for a smoother meeting experience.' +
        '</p>' +
      '</div>';
    // Attach to the lobby-left panel (camera preview area)
    const lobbyLeft = document.querySelector(".wrtc-lobby-left");
    if (lobbyLeft) lobbyLeft.appendChild(card);
  }

  _hidePermissionHint() {
    document.getElementById("wrtc-perm-hint")?.remove();
  }

  _applyTheme(theme) {
    if (!theme) return;
    const p = this.parentNode;
    if (!p) return;
    // Mark the container so CSS rules can scope under it
    p.setAttribute('data-wrtc-theme', theme);
    const id = 'wrtc-theme-style';
    if (document.getElementById(id)) return; // already injected
    const s = document.createElement('style');
    s.id = id;
    if (theme === 'light') {
      s.textContent = `
        /* ── Light theme — video tiles stay dark, chrome goes light ── */

        /* Container background — neutral gray so dark tiles pop */
        [data-wrtc-theme="light"]{background:#e8eaed!important}
        [data-wrtc-theme="light"] .wrtc{background:#e8eaed!important;color:#202124!important}

        /* Top bar — white pill on light bg */
        [data-wrtc-theme="light"] .wrtc-top{background:linear-gradient(to bottom,rgba(232,234,237,.95) 0%,transparent 100%)!important}
        [data-wrtc-theme="light"] .wrtc-room-name{color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-clock{color:rgba(0,0,0,.55)!important}
        [data-wrtc-theme="light"] .wrtc-peer-chip{background:rgba(0,0,0,.1)!important;color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-peer-chip:hover{background:rgba(0,0,0,.16)!important}

        /* Video tiles — keep dark so video is visible */
        [data-wrtc-theme="light"] .wrtc-tile{background:#2d2f36!important}
        [data-wrtc-theme="light"] .wrtc-tile video{background:#1a1c22!important}

        /* Control bar — white frosted */
        [data-wrtc-theme="light"] .wrtc-controls{background:rgba(255,255,255,.92)!important;border-color:rgba(0,0,0,.1)!important;box-shadow:0 4px 24px rgba(0,0,0,.12),0 1px 4px rgba(0,0,0,.06)!important}
        [data-wrtc-theme="light"] .wrtc-reaction-picker{background:rgba(255,255,255,.96)!important;border-color:rgba(0,0,0,.1)!important}
        [data-wrtc-theme="light"] .wrtc-btn{background:rgba(0,0,0,.08)!important;color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-btn:hover{background:rgba(0,0,0,.14)!important}
        [data-wrtc-theme="light"] .wrtc-btn.muted,[data-wrtc-theme="light"] .wrtc-btn.active-feature{background:rgba(234,67,53,.9)!important;color:#fff!important}
        [data-wrtc-theme="light"] .wrtc-btn.on-air{background:rgba(26,115,232,.9)!important;color:#fff!important}
        [data-wrtc-theme="light"] .wrtc-btn-label{color:rgba(0,0,0,.5)!important}
        [data-wrtc-theme="light"] .wrtc-btn-badge{border-color:rgba(255,255,255,.92)!important}
        [data-wrtc-theme="light"] .wrtc-divider{background:rgba(0,0,0,.12)!important}

        /* 3-dot menu — white */
        [data-wrtc-theme="light"] .wrtc-more-menu{background:#fff!important;border-color:rgba(0,0,0,.1)!important;box-shadow:0 8px 32px rgba(0,0,0,.14)!important}
        [data-wrtc-theme="light"] .wrtc-more-item{color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-more-item:hover{background:rgba(0,0,0,.06)!important}
        [data-wrtc-theme="light"] .wrtc-more-divider{background:rgba(0,0,0,.08)!important}

        /* Side panel — white */
        [data-wrtc-theme="light"] .wrtc-side-panel{background:#ffffff!important;border-left-color:rgba(0,0,0,.1)!important}
        [data-wrtc-theme="light"] .wrtc-panel-tabs{border-bottom-color:rgba(0,0,0,.08)!important}
        [data-wrtc-theme="light"] .wrtc-panel-tab{color:rgba(0,0,0,.45)!important}
        [data-wrtc-theme="light"] .wrtc-panel-tab:hover,[data-wrtc-theme="light"] .wrtc-panel-tab.active{color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-panel-close{color:#5f6368!important}
        [data-wrtc-theme="light"] .wrtc-panel-close:hover{background:rgba(0,0,0,.06)!important;color:#202124!important}
        /* People list */
        [data-wrtc-theme="light"] .wrtc-person:hover{background:rgba(0,0,0,.04)!important}
        [data-wrtc-theme="light"] .wrtc-person-name{color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-you-tag{color:rgba(0,0,0,.4)!important}
        [data-wrtc-theme="light"] .wrtc-host-tag{color:#1a73e8!important}
        [data-wrtc-theme="light"] .wrtc-person-icon{color:rgba(0,0,0,.3)!important}
        [data-wrtc-theme="light"] .wrtc-person-icon.muted{color:#ea4335!important}
        [data-wrtc-theme="light"] .wrtc-person-icons button{background:rgba(0,0,0,.06)!important;border-color:rgba(0,0,0,.15)!important;color:#202124!important}
        /* Chat */
        [data-wrtc-theme="light"] .wrtc-chat-empty{color:rgba(0,0,0,.4)!important}
        [data-wrtc-theme="light"] .wrtc-msg-name{color:#1a73e8!important}
        [data-wrtc-theme="light"] .wrtc-msg-name.mine{color:#0d7a3e!important}
        [data-wrtc-theme="light"] .wrtc-msg-time{color:rgba(0,0,0,.35)!important}
        [data-wrtc-theme="light"] .wrtc-msg-text{color:#202124!important;background:rgba(0,0,0,.06)!important}
        [data-wrtc-theme="light"] .wrtc-msg.mine .wrtc-msg-text{background:rgba(26,115,232,.12)!important}
        [data-wrtc-theme="light"] .wrtc-msg-system{color:rgba(0,0,0,.35)!important}
        [data-wrtc-theme="light"] .wrtc-msg-more{color:#1a73e8!important}
        [data-wrtc-theme="light"] .wrtc-chat-footer{border-top-color:rgba(0,0,0,.08)!important}
        [data-wrtc-theme="light"] .wrtc-chat-input{background:rgba(0,0,0,.05)!important;border-color:rgba(0,0,0,.12)!important;color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-chat-input::placeholder{color:rgba(0,0,0,.35)!important}
        [data-wrtc-theme="light"] .wrtc-people-list::-webkit-scrollbar-thumb,[data-wrtc-theme="light"] .wrtc-chat-msgs::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15)!important}
        /* Waiting overlay */
        [data-wrtc-theme="light"] .wrtc-waiting{color:rgba(0,0,0,.65)!important}
        [data-wrtc-theme="light"] .wrtc-waiting-ring{border-color:rgba(0,0,0,.12)!important;border-top-color:#1a73e8!important}
        [data-wrtc-theme="light"] .wrtc-knock-waiting{color:rgba(0,0,0,.45)!important}

        /* Lobby — light card on neutral bg */
        [data-wrtc-theme="light"] .wrtc-lobby{background:#e8eaed!important;color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-lobby-card{background:#ffffff!important;border-color:rgba(0,0,0,.1)!important;box-shadow:0 24px 64px rgba(0,0,0,.12)!important}
        [data-wrtc-theme="light"] .wrtc-lobby-right{background:#fafafa!important}
        [data-wrtc-theme="light"] .wrtc-lobby-brand{color:rgba(0,0,0,.45)!important}
        [data-wrtc-theme="light"] .wrtc-lobby-brand svg{opacity:.6!important;filter:invert(1)!important}
        [data-wrtc-theme="light"] .wrtc-lobby-title{color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-lobby-room{color:rgba(0,0,0,.45)!important}
        [data-wrtc-theme="light"] .wrtc-lobby-room strong{color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-lobby-input{background:rgba(0,0,0,.05)!important;border-color:rgba(0,0,0,.15)!important;color:#202124!important}
        [data-wrtc-theme="light"] .wrtc-lobby-input::placeholder{color:rgba(0,0,0,.35)!important}
        [data-wrtc-theme="light"] .wrtc-lobby-input:focus{border-color:rgba(26,115,232,.6)!important}
        [data-wrtc-theme="light"] .wrtc-join-btn:disabled{background:#d0d3d8!important;color:rgba(0,0,0,.4)!important}
        /* Lobby preview buttons — keep visible on dark camera area */
        [data-wrtc-theme="light"] .wrtc-lbtn{background:rgba(255,255,255,.2)!important;color:#fff!important}
        [data-wrtc-theme="light"] .wrtc-lbtn:hover{background:rgba(255,255,255,.35)!important}

        /* Prescreen — light */
        [data-wrtc-theme="light"] .ep{background:#e8eaed!important}
        [data-wrtc-theme="light"] .ep-hdr h2{color:#202124!important}
        [data-wrtc-theme="light"] .ep-hdr p{color:#5f6368!important}
        [data-wrtc-theme="light"] .ep-card{background:#ffffff!important;border-color:rgba(0,0,0,.08)!important;box-shadow:0 4px 16px rgba(0,0,0,.08)!important}
        [data-wrtc-theme="light"] .ep-card h3{color:#5f6368!important}
        [data-wrtc-theme="light"] .ep-input{background:rgba(0,0,0,.05)!important;border-color:rgba(0,0,0,.12)!important;color:#202124!important}
        [data-wrtc-theme="light"] .ep-input::placeholder{color:rgba(0,0,0,.35)!important}
        [data-wrtc-theme="light"] .ep-row{border-bottom-color:rgba(0,0,0,.06)!important}
        [data-wrtc-theme="light"] .ep-row-title{color:#202124!important}
        [data-wrtc-theme="light"] .ep-row-date{color:#5f6368!important}
        [data-wrtc-theme="light"] .ep-empty{color:#5f6368!important}
        [data-wrtc-theme="light"] .ep-sched-btn{color:#5f6368!important;border-color:rgba(0,0,0,.15)!important}
        [data-wrtc-theme="light"] .ep-sched-btn:hover{color:#202124!important}
        [data-wrtc-theme="light"] .ep-modal{background:#fff!important;border-color:rgba(0,0,0,.1)!important}
        [data-wrtc-theme="light"] .ep-modal h3,[data-wrtc-theme="light"] .ep-modal-sub{color:#202124!important}
        [data-wrtc-theme="light"] .ep-label{color:#5f6368!important}
        [data-wrtc-theme="light"] .ep-inp2{background:rgba(0,0,0,.05)!important;border-color:rgba(0,0,0,.12)!important;color:#202124!important}
        [data-wrtc-theme="light"] .ep-cancel{color:#5f6368!important;border-color:rgba(0,0,0,.15)!important}
        [data-wrtc-theme="light"] .ep-tag{background:rgba(0,0,0,.06)!important;border-color:rgba(0,0,0,.1)!important;color:#202124!important}
      `;
    } else if (theme === 'dark') {
      // Dark is the default — only need to force it if the OS is in light mode
      s.textContent = `
        [data-wrtc-theme="dark"]{background:linear-gradient(135deg,#13151c 0%,#1a1d26 100%)!important}
      `;
    }
    document.head.appendChild(s);
  }

  async _applyBrandingToPrescreen() {
    const token = this._embedToken;
    if (!token) return;
    try {
      const res = await fetch(
        this._httpBase + '/api/v1/projects/public-branding?embed_token=' + encodeURIComponent(token)
      );
      if (!res.ok) return;
      const b = await res.json();

      // Inject color overrides for all prescreen buttons
      if (b.primary_color) {
        const c = b.primary_color;
        const s = document.createElement('style');
        s.textContent =
          `.ep-btn{background:${c}!important;box-shadow:0 4px 20px ${c}44!important}` +
          `.ep-join{background:${c}!important}` +
          `.ep-send{background:${c}!important;box-shadow:0 4px 16px ${c}55!important}` +
          `.ep-input:focus{border-color:${c}!important}` +
          `.ep-inp2:focus{border-color:${c}!important}` +
          `.ep-spin{border-top-color:${c}!important}`;
        document.head.appendChild(s);
      }

      // Show logo above the title
      if (b.logo_url) {
        const hdr = document.querySelector('.ep-hdr');
        if (hdr) {
          const img = document.createElement('img');
          img.src = b.logo_url;
          img.alt = 'logo';
          img.style.cssText = 'max-height:40px;max-width:160px;object-fit:contain;border-radius:4px;margin-bottom:14px;display:block;margin-left:auto;margin-right:auto';
          hdr.insertBefore(img, hdr.firstChild);
        }
      }
      // Store so host lobby (_buildLobby) picks them up after embed token is cleared
      this._branding = b;
      if (b.theme) { this._theme = b.theme; this._applyTheme(b.theme); }
    } catch(_) {}
  }

  _applyBrandingData(b) {
    if (!b) return;
    if (b.primary_color) {
      const btn = document.getElementById('wrtc-join-btn');
      if (btn) {
        btn.style.background = b.primary_color;
        btn.style.boxShadow  = `0 4px 20px ${b.primary_color}66`;
      }
      const s = document.createElement('style');
      s.textContent = `.wrtc-join-btn{background:${b.primary_color}!important;box-shadow:0 4px 20px ${b.primary_color}66!important}` +
                      `.wrtc-join-btn:hover{background:${b.primary_color}dd!important;box-shadow:0 6px 24px ${b.primary_color}88!important}` +
                      `.wrtc-join-btn:disabled{background:#2a2d38!important;box-shadow:none!important}`;
      document.head.appendChild(s);
    }
    if (b.button_label) {
      const btn = document.getElementById('wrtc-join-btn');
      if (btn) btn.textContent = b.button_label;
    }
    if (b.welcome_message) {
      const title = document.querySelector('.wrtc-lobby-title');
      if (title) title.textContent = b.welcome_message;
    }
    if (b.logo_url) {
      const brand = document.querySelector('.wrtc-lobby-brand');
      if (brand) {
        brand.innerHTML = `<img src="${b.logo_url}" alt="logo" style="max-height:28px;max-width:120px;object-fit:contain;border-radius:3px">`;
      }
    }
    if (b.theme) this._applyTheme(b.theme);
  }

  async _applyBranding() {
    // Fetch project branding using the embed token and apply to lobby DOM.
    // Works for both embedToken-flow and direct room joins (guestToken has no project).
    const token = this._embedToken || this._embedTokenSaved || '';
    if (!token) return;
    try {
      const res = await fetch(
        this._httpBase + '/api/v1/projects/public-branding?embed_token=' + encodeURIComponent(token)
      );
      if (!res.ok) return;
      const b = await res.json();

      // Primary color — override button background + shadow
      if (b.primary_color) {
        const btn = document.getElementById('wrtc-join-btn');
        if (btn) {
          btn.style.background  = b.primary_color;
          btn.style.boxShadow   = `0 4px 20px ${b.primary_color}66`;
        }
        // Also inject a style override for hover/disabled states
        const s = document.createElement('style');
        s.textContent = `.wrtc-join-btn{background:${b.primary_color}!important;box-shadow:0 4px 20px ${b.primary_color}66!important}` +
                        `.wrtc-join-btn:hover{background:${b.primary_color}dd!important;box-shadow:0 6px 24px ${b.primary_color}88!important}` +
                        `.wrtc-join-btn:disabled{background:#2a2d38!important;box-shadow:none!important}`;
        document.head.appendChild(s);
      }

      // Button label
      if (b.button_label) {
        const btn = document.getElementById('wrtc-join-btn');
        if (btn) btn.textContent = b.button_label;
      }

      // Welcome message — replace "Ready to join?" title
      if (b.welcome_message) {
        const title = document.querySelector('.wrtc-lobby-title');
        if (title) title.textContent = b.welcome_message;
      }

      // Logo — replace brand section
      if (b.logo_url) {
        const brand = document.querySelector('.wrtc-lobby-brand');
        if (brand) {
          brand.innerHTML = `<img src="${b.logo_url}" alt="logo" style="max-height:28px;max-width:120px;object-fit:contain;border-radius:3px">`;
        }
      }
      if (b.theme) { this._theme = b.theme; this._applyTheme(b.theme); }
    } catch (_) {
      // Branding fetch failed silently — use defaults
    }
  }

  async _initPreview() {
    // Check if permission is already granted — skip the hint if so
    let alreadyGranted = false;
    try {
      const [camPerm, micPerm] = await Promise.all([
        navigator.permissions.query({ name: "camera" }),
        navigator.permissions.query({ name: "microphone" }),
      ]);
      alreadyGranted = camPerm.state === "granted" && micPerm.state === "granted";
    } catch (_) { /* permissions API not supported — assume not granted */ }

    if (!alreadyGranted) this._showPermissionHint();

    try {
      this._localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      this._hidePermissionHint();
      document.getElementById("wrtc-lobby-video").srcObject = this._localStream;
    } catch (_) {
      this._hidePermissionHint();
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
    // Prefer server-authoritative start time so all participants share the same countdown.
    // Fall back to cached value (reconnect) or local Date.now() (no timer on this plan).
    if (this._serverMeetingStartedAt) {
      this._meetingStart = this._serverMeetingStartedAt;
      sessionStorage.setItem(startKey, String(this._meetingStart));
    } else {
      const saved = sessionStorage.getItem(startKey);
      this._meetingStart = saved ? parseInt(saved, 10) : Date.now();
      if (!saved) sessionStorage.setItem(startKey, String(this._meetingStart));
    }
    // Re-apply saved cam/mic state (handles cases where it may have been reset before UI builds)
    if (sessionStorage.getItem('wrtc_mic_' + this.roomName) === '0') {
      this._micEnabled = false;
      this._localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
    }
    if (sessionStorage.getItem('wrtc_cam_' + this.roomName) === '0') {
      this._camEnabled = false;
      this._localStream?.getVideoTracks().forEach(t => { t.enabled = false; });
    }
    // Persist current cam/mic state so refresh restores it correctly
    sessionStorage.setItem('wrtc_cam_' + this.roomName, this._camEnabled ? '1' : '0');
    sessionStorage.setItem('wrtc_mic_' + this.roomName, this._micEnabled ? '1' : '0');
    // Re-apply host-forced mute state — keeps admin mute active through participant refresh
    if (sessionStorage.getItem('wrtc_force_mic_' + this.roomName) === '1') {
      this._micLocked = true; this._hostMutedMic = true;
    }
    if (sessionStorage.getItem('wrtc_force_cam_' + this.roomName) === '1') {
      this._camLocked = true; this._hostMutedCam = true;
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
    if (this._camLocked) {
      document.getElementById("wrtc-btn-cam")?.classList.add("admin-locked");
      document.getElementById("wrtc-btn-cam")?.setAttribute("title", "Disabled by host");
    }
    if (!this._micEnabled) {
      document.getElementById("wrtc-btn-mic").classList.add("muted");
      document.getElementById("wrtc-ico-mic").style.display     = "none";
      document.getElementById("wrtc-ico-mic-off").style.display = "";
    }
    if (this._micLocked) {
      document.getElementById("wrtc-btn-mic")?.classList.add("admin-locked");
      document.getElementById("wrtc-btn-mic")?.setAttribute("title", "Disabled by host");
    }
    this._startSpeakerDetection();
    this._startQualityMonitor();
    this._initAutoHideControls();
    this._restoreChatHistory();
    this._initDeviceWatcher();
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

    // Recording — available to host when:
    //   • project meeting: paid plan + project allows it
    //   • public meeting: paid plan + add-on enabled + authenticated endpoint
    const recMenuItem = document.getElementById("wrtc-more-rec");
    if (recMenuItem) {
      const planAllowsRecording = this._ownerPlan && this._ownerPlan !== 'free';
      const canRecord = isHost && this._allowRecording && (
        this._isPublicMeeting
          ? (!!this._recordingEndpoint && planAllowsRecording && this._recordingAddonEnabled)
          : planAllowsRecording
      );
      recMenuItem.style.display = canRecord ? "" : "none";
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
      .wrtc-room-name{display:none}
      .wrtc-info-btn{
        width:26px;height:26px;border-radius:50%;border:1.5px solid rgba(255,255,255,.35);
        background:rgba(255,255,255,.1);backdrop-filter:blur(8px);
        color:#e8eaed;cursor:pointer;font-size:13px;font-weight:700;font-style:italic;
        display:flex;align-items:center;justify-content:center;
        position:relative;transition:background .15s;flex-shrink:0;
      }
      .wrtc-info-btn:hover{background:rgba(255,255,255,.2)}
      .wrtc-info-tooltip{
        position:absolute;top:calc(100% + 10px);left:0;
        background:rgba(18,20,28,.96);backdrop-filter:blur(16px);
        border:1px solid rgba(255,255,255,.12);border-radius:10px;
        padding:8px 14px;font-size:13px;font-weight:500;
        color:#e8eaed;white-space:nowrap;pointer-events:none;
        opacity:0;transform:translateY(-6px);
        transition:opacity .18s,transform .18s;
        box-shadow:0 8px 24px rgba(0,0,0,.5);
        font-style:normal;
      }
      .wrtc-info-btn:hover .wrtc-info-tooltip{opacity:1;transform:translateY(0)}
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
        padding:8px 0 8px;overflow:hidden;transition:padding-right .25s;
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
      @keyframes wrtc-tile-in{
        from{opacity:0;transform:scale(.88)}
        to{opacity:1;transform:scale(1)}
      }
      @keyframes wrtc-tile-out{
        0%  {opacity:1;transform:scale(1) translateY(0);filter:blur(0px)}
        30% {opacity:.8;transform:scale(.97) translateY(4px);filter:blur(1px)}
        100%{opacity:0;transform:scale(.88) translateY(24px);filter:blur(6px)}
      }
      @keyframes wrtc-speak-pulse{
        0%,100%{box-shadow:0 0 0 3px #4d94ff,0 0 16px 4px rgba(77,148,255,.35),0 4px 24px rgba(0,0,0,.35)}
        50%{box-shadow:0 0 0 4px #6aabff,0 0 28px 8px rgba(77,148,255,.55),0 4px 24px rgba(0,0,0,.35)}
      }
      .wrtc-tile{
        position:relative;border-radius:16px;overflow:hidden;
        background:#1a1d28;width:100%;height:100%;min-height:0;
        transition:transform .3s;
        box-shadow:0 4px 24px rgba(0,0,0,.35);
        animation:wrtc-tile-in .35s cubic-bezier(.34,1.4,.64,1) both;
      }
      .wrtc-tile video{
        width:100%;height:100%;object-fit:cover;display:block;background:#0d0f14;
      }
      .wrtc-tile.presenter video{object-fit:contain;background:#000;}
      #wrtc-local-video{transform:scaleX(-1)}
      .wrtc-tile.speaking{
        animation:wrtc-tile-in .35s cubic-bezier(.34,1.4,.64,1) both,wrtc-speak-pulse 1.4s ease-in-out infinite;
      }
      .wrtc-tile.wrtc-tile-leaving{
        animation:wrtc-tile-out .45s cubic-bezier(.4,0,1,1) forwards;
        pointer-events:none;
        will-change:transform,opacity,filter;
      }
      .wrtc-tile-avatar{
        position:absolute;inset:0;
        display:none;align-items:center;justify-content:center;
        z-index:0;
      }
      .wrtc-tile-avatar.visible{ display:flex; }
      @keyframes wrtc-shimmer{
        0%{background-position:200% center}
        100%{background-position:-200% center}
      }
      .wrtc-tile-avatar span{
        width:clamp(48px,9vw,96px);height:clamp(48px,9vw,96px);
        border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-size:clamp(18px,3.5vw,36px);font-weight:500;color:#fff;
        position:relative;overflow:hidden;
      }
      .wrtc-tile-avatar span::after{
        content:"";position:absolute;inset:0;border-radius:50%;
        background:linear-gradient(105deg,transparent 30%,rgba(255,255,255,.28) 50%,transparent 70%);
        background-size:200% 100%;
        animation:wrtc-shimmer 2.4s linear infinite;
      }
      .wrtc-tile-label{
        position:absolute;bottom:10px;left:10px;z-index:2;
        background:linear-gradient(135deg,rgba(255,255,255,.13) 0%,rgba(255,255,255,.06) 100%);
        backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
        border:1px solid rgba(255,255,255,.18);
        color:#fff;font-size:12px;font-weight:500;
        padding:4px 10px;border-radius:20px;
        max-width:calc(100% - 56px);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        text-shadow:0 1px 3px rgba(0,0,0,.5);
        box-shadow:0 2px 8px rgba(0,0,0,.25);
      }
      .wrtc-tile-hand{
        position:absolute;top:10px;right:10px;z-index:2;
        font-size:22px;display:none;
        animation:wrtc-bounce .6s ease-in-out infinite alternate;
      }
      @keyframes wrtc-bounce{from{transform:translateY(0)}to{transform:translateY(-4px)}}
      .wrtc-tile-hand.raised{display:block}
      /* ── PARTICLE BURST ── */
      @keyframes wrtc-particle{
        0%{transform:translate(0,0) scale(1);opacity:1}
        100%{transform:translate(var(--px),var(--py)) scale(0);opacity:0}
      }
      .wrtc-particle{
        position:fixed;width:7px;height:7px;border-radius:50%;
        pointer-events:none;z-index:9999;
        animation:wrtc-particle .7s ease-out forwards;
      }
      /* ── SPEAKING TOAST ── */
      .wrtc-speak-toast{
        position:fixed;bottom:100px;left:24px;z-index:9998;
        background:rgba(18,20,28,.92);backdrop-filter:blur(16px);
        border:1px solid rgba(255,255,255,.12);border-radius:24px;
        padding:8px 16px;display:flex;align-items:center;gap:8px;
        font-size:13px;font-weight:500;color:#e8eaed;
        box-shadow:0 8px 24px rgba(0,0,0,.5);
        opacity:0;transform:translateY(8px) scale(.96);
        transition:opacity .2s,transform .2s;pointer-events:none;
      }
      .wrtc-speak-toast.show{opacity:1;transform:translateY(0) scale(1)}
      .wrtc-speak-toast-dot{
        width:8px;height:8px;border-radius:50%;flex-shrink:0;
        animation:wrtc-speak-dot 1s ease-in-out infinite;
      }
      @keyframes wrtc-speak-dot{
        0%,100%{transform:scale(1);opacity:1}
        50%{transform:scale(1.4);opacity:.7}
      }
      /* ── SIGNAL BARS ── */
      .wrtc-signal{
        position:absolute;top:8px;left:8px;z-index:4;
        display:flex;align-items:flex-end;gap:2px;pointer-events:none;
        opacity:.85;
      }
      .wrtc-signal-bar{
        width:4px;border-radius:1px;background:rgba(255,255,255,.25);
        transition:background .4s,height .4s;
      }
      .wrtc-signal-bar:nth-child(1){height:5px}
      .wrtc-signal-bar:nth-child(2){height:9px}
      .wrtc-signal-bar:nth-child(3){height:13px}
      .wrtc-signal[data-q="good"]  .wrtc-signal-bar{background:#34a853}
      .wrtc-signal[data-q="ok"]    .wrtc-signal-bar:nth-child(1),
      .wrtc-signal[data-q="ok"]    .wrtc-signal-bar:nth-child(2){background:#fbbc04}
      .wrtc-signal[data-q="poor"]  .wrtc-signal-bar:nth-child(1){background:#ea4335}
      /* ── REACTION FLOAT ── */
      .wrtc-reaction-float{
        position:absolute;bottom:20%;left:50%;transform:translateX(-50%);
        font-size:36px;z-index:20;pointer-events:none;
        animation:wrtc-float-up 2.8s ease-out forwards;
      }
      @keyframes wrtc-float-up{
        0%{transform:translateX(-50%) translateY(0) scale(.6);opacity:0}
        15%{opacity:1;transform:translateX(-50%) translateY(-8px) scale(1.15)}
        70%{opacity:1;transform:translateX(-50%) translateY(-60px) scale(1)}
        100%{opacity:0;transform:translateX(-50%) translateY(-90px) scale(.85)}
      }
      /* ── REACTION PICKER ── */
      .wrtc-reaction-picker{
        position:fixed;z-index:200;
        background:rgba(18,20,28,.96);backdrop-filter:blur(20px);
        border:1px solid rgba(255,255,255,.12);border-radius:40px;
        padding:10px 14px;display:flex;gap:6px;align-items:center;
        box-shadow:0 8px 32px rgba(0,0,0,.6);
        transition:opacity .15s,transform .15s;
      }
      .wrtc-reaction-picker.hidden{opacity:0;pointer-events:none;transform:translateY(6px) scale(.95)}
      .wrtc-reaction-emoji-btn{
        background:none;border:none;cursor:pointer;
        font-size:24px;line-height:1;padding:6px;border-radius:50%;
        transition:background .12s,transform .12s;
      }
      .wrtc-reaction-emoji-btn:hover{background:rgba(255,255,255,.12);transform:scale(1.25)}
      .wrtc-reaction-emoji-btn:active{transform:scale(.9)}
      .wrtc-tile-mic{display:none!important}
      .wrtc-tile-mic-ring{
        position:absolute;inset:-4px;border-radius:50%;
        border:2.5px solid #50c878;transform:scale(0);opacity:0;
        will-change:transform,opacity;pointer-events:none;
      }
      .wrtc-tile-mic.muted{background:rgba(234,67,53,.22)}
      /* ── PIN BUTTON (hover-reveal center overlay) ── */
      .wrtc-tile-pin{
        position:absolute;inset:0;z-index:10;
        display:flex;align-items:center;justify-content:center;
        opacity:0;pointer-events:none;
        transition:opacity .18s;
      }
      .wrtc-tile:hover .wrtc-tile-pin{opacity:1;pointer-events:auto;}
      /* Don't show pin when tile is in the focus-main area */
      .wrtc-focus-main .wrtc-tile:hover .wrtc-tile-pin{opacity:0;pointer-events:none;}
      /* Don't show pin button on own (local) tile during screen share */
      .wrtc-stage.presenting #wrtc-local-tile .wrtc-tile-pin,
      .wrtc-focus-tiles #wrtc-local-tile .wrtc-tile-pin{opacity:0!important;pointer-events:none!important;}
      .wrtc-tile-pin-btn{
        width:52px;height:52px;border-radius:50%;
        background:rgba(0,0,0,.58);backdrop-filter:blur(6px);
        border:2px solid rgba(255,255,255,.35);
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;
        transition:background .15s,transform .15s,border-color .15s;
      }
      .wrtc-tile-pin-btn:hover{
        background:rgba(26,115,232,.82);border-color:rgba(255,255,255,.7);
        transform:scale(1.12);
      }

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
        position:absolute;top:10px;right:10px;z-index:20;
        width:32px;height:32px;border-radius:50%;
        background:rgba(0,0,0,.60);backdrop-filter:blur(6px);
        border:1px solid rgba(255,255,255,.25);color:#fff;
        font-size:16px;line-height:1;
        cursor:pointer;display:flex;align-items:center;justify-content:center;
        transition:background .15s,transform .12s;
      }
      .wrtc-focus-exit:hover{background:rgba(220,38,38,.85);transform:scale(1.1);}
      .wrtc-focus-panel{
        width:22%;min-width:140px;max-width:220px;
        display:flex;flex-direction:column;gap:6px;overflow:hidden;flex-shrink:0;
      }
      .wrtc-focus-tiles{
        display:flex;flex-direction:column;gap:6px;flex:1;overflow-y:auto;overflow-x:hidden;
      }
      .wrtc-focus-tiles>.wrtc-tile{
        flex:0 0 auto;height:130px;cursor:pointer;border-radius:12px;
        transition:box-shadow .2s,transform .15s,outline .15s;
        outline:2px solid transparent;
      }
      .wrtc-focus-tiles>.wrtc-tile:hover{
        transform:scale(1.03);
        outline:2px solid rgba(108,99,255,.7);
        box-shadow:0 4px 20px rgba(108,99,255,.35);
      }
      .wrtc-focus-more{
        background:rgba(108,99,255,.12);border:1px solid rgba(108,99,255,.3);
        border-radius:12px;color:#a09bff;font-size:13px;font-weight:600;
        text-align:center;padding:12px 8px;cursor:pointer;flex-shrink:0;
        transition:background .15s;
      }
      .wrtc-focus-more:hover{background:rgba(108,99,255,.22);}
      .wrtc-tile{cursor:default;}
      .wrtc-focus-tiles>.wrtc-tile{cursor:pointer;}

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
        z-index:2;max-width:calc(100% - 12px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      }
      .wrtc-thumb-pin{
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        opacity:0;pointer-events:none;transition:opacity .18s;
        background:rgba(0,0,0,.22);border-radius:10px;
      }
      .wrtc-thumb-tile:hover .wrtc-thumb-pin{opacity:1;pointer-events:auto;}
      .wrtc-thumb-pin-btn{
        width:38px;height:38px;border-radius:50%;
        background:rgba(0,0,0,.58);backdrop-filter:blur(6px);
        border:2px solid rgba(255,255,255,.35);
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;transition:background .15s,transform .15s,border-color .15s;
      }
      .wrtc-thumb-pin-btn:hover{background:rgba(26,115,232,.82);border-color:rgba(255,255,255,.7);transform:scale(1.12);}

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
        padding:10px 16px 28px;
        background:rgba(18,20,28,0.88);
        backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
        border-radius:56px;
        border:1px solid rgba(255,255,255,.09);
        box-shadow:0 8px 40px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.06);
        white-space:nowrap;
        transition:transform .38s cubic-bezier(.4,0,.2,1),opacity .38s;
      }
      .wrtc-controls.wrtc-ctrl-hidden{
        transform:translateX(-50%) translateY(calc(100% + 32px));
        opacity:0;pointer-events:none;
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
      .wrtc-btn.admin-locked{opacity:.45;cursor:not-allowed;pointer-events:none}
      .wrtc-btn.on-air{background:rgba(26,115,232,.9);color:#fff;box-shadow:0 2px 12px rgba(26,115,232,.4)}
      .wrtc-btn.on-air:hover{background:#1a73e8}
      /* ── MIC LIQUID FILL ── */
      /* Inner wrapper clips liquid to circle, label stays outside */
      .wrtc-mic-inner{
        position:absolute;inset:0;border-radius:50%;
        overflow:hidden;
        transform:translateZ(0);
        -webkit-mask-image:-webkit-radial-gradient(white,black);
      }
      .wrtc-vol-liquid{
        position:absolute;bottom:0;left:0;width:100%;height:0%;
        background:linear-gradient(180deg,#4cdb7a 0%,#1a9c45 100%);
        transition:height .12s ease-out;
        pointer-events:none;
        overflow:hidden;
      }
      .wrtc-vol-liquid::before{
        content:"";position:absolute;
        top:-7px;left:-40%;
        width:180%;height:14px;
        background:rgba(100,230,150,.8);
        border-radius:50%;
        animation:wrtc-wave-x 2s ease-in-out infinite;
      }
      @keyframes wrtc-wave-x{
        0%,100%{transform:translateX(0)}
        50%{transform:translateX(16%)}
      }
      /* Icon pinned to centre inside the inner wrapper */
      #wrtc-ico-mic,#wrtc-ico-mic-off{
        position:absolute;top:50%;left:50%;
        transform:translate(-50%,-50%);
        z-index:2;
      }
      .wrtc-btn-badge{
        position:absolute;top:1px;right:1px;
        width:16px;height:16px;border-radius:50%;
        background:#ea4335;color:#fff;font-size:9px;font-weight:700;
        display:none;align-items:center;justify-content:center;
        border:2px solid rgba(18,20,28,0.88);
      }
      .wrtc-btn-badge.show{display:flex}
      .wrtc-btn-label{
        position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);
        font-size:9.5px;font-weight:500;color:rgba(255,255,255,.52);white-space:nowrap;
        pointer-events:none;letter-spacing:.2px;
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
      .wrtc-host-tag{
        font-size:11px;color:#8ab4f8;margin-left:5px;font-weight:500;
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
      .wrtc-msg-name.host{color:#fbbc05}
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

      /* ── DEVICE SWITCHER ── */
      .wrtc-dev-group{display:flex;align-items:stretch;position:relative;}
      .wrtc-dev-group>.wrtc-btn{border-radius:12px 0 0 12px;}
      .wrtc-dev-chevron{
        display:flex;align-items:center;justify-content:center;
        width:20px;min-width:20px;
        background:rgba(255,255,255,.06);border:none;
        border-left:1px solid rgba(255,255,255,.1);
        border-radius:0 12px 12px 0;
        cursor:pointer;color:#e8eaed;transition:background .12s;padding:0;
      }
      .wrtc-dev-chevron:hover{background:rgba(255,255,255,.14);}
      .wrtc-dev-menu{
        position:fixed;
        background:#1e2024;border:1px solid rgba(255,255,255,.13);border-radius:12px;
        padding:6px;z-index:50;min-width:220px;
        box-shadow:0 8px 32px rgba(0,0,0,.55);
        display:flex;flex-direction:column;gap:2px;
      }
      .wrtc-dev-item{
        display:flex;align-items:center;gap:10px;padding:10px 14px;
        border-radius:8px;cursor:pointer;color:#e8eaed;font-size:13.5px;
        transition:background .12s;
      }
      .wrtc-dev-item:hover{background:rgba(255,255,255,.08);}
      .wrtc-dev-item.active{color:#8ab4f8;}
      .wrtc-dev-item-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .wrtc-dev-toast{
        position:absolute;bottom:88px;left:50%;
        transform:translateX(-50%) translateY(12px);
        background:#3c4043;color:#e8eaed;
        font-size:13px;padding:8px 14px;border-radius:10px;
        box-shadow:0 4px 16px rgba(0,0,0,.5);
        z-index:55;opacity:0;transition:opacity .2s,transform .2s;
        display:flex;align-items:center;gap:10px;
        white-space:nowrap;pointer-events:none;
      }
      .wrtc-dev-toast.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto;}
      .wrtc-dev-toast-btn{
        background:#8ab4f8;color:#202124;border:none;border-radius:6px;
        padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer;
      }
      .wrtc-dev-toast-btn:hover{background:#aac8fb;}
      .wrtc-dev-toast-dismiss{
        background:none;border:none;color:#9aa0a6;cursor:pointer;font-size:16px;padding:0 2px;
      }
      .wrtc-dev-toast-dismiss:hover{color:#e8eaed;}

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

      /* ══════════════════════════════════════════════════
         MOBILE RESPONSIVE  (≤ 640px)
      ══════════════════════════════════════════════════ */
      @media(max-width:640px){

        /* ── Top bar ── */
        .wrtc-top{padding:10px 12px;}
        .wrtc-room-name{font-size:13px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .wrtc-clock{display:none}
        .wrtc-peer-chip{padding:3px 8px 3px 6px;font-size:12px;}

        /* ── Stage ── */
        .wrtc-stage{padding:8px 0 8px;}
        /* Panel overlays full screen on mobile — no padding-right shift */
        .wrtc-stage.panel-open{padding-right:0}

        /* ── Side panel — full-screen overlay ── */
        .wrtc-side-panel{width:100%;border-left:none;border-top:1px solid rgba(255,255,255,.07);}

        /* ── Controls bar ── */
        .wrtc-controls{
          bottom:16px;
          padding:8px 10px;
          gap:4px;
          max-width:calc(100vw - 16px);
        }
        .wrtc-btn{width:40px;height:40px;}
        .wrtc-btn-label{display:none}
        .wrtc-divider{margin:0 1px;}
        /* Leave button: icon-only on mobile */
        .wrtc-btn-leave{padding:0;width:40px;border-radius:50%;}
        .wrtc-btn-leave .wrtc-leave-text{display:none;}

        /* ── More menu — slide up from bottom ── */
        .wrtc-more-menu{
          position:fixed;bottom:80px;left:8px;right:8px;min-width:unset;
          border-radius:16px;
        }

        /* ── Tile label ── */
        .wrtc-tile-label{font-size:11px;padding:3px 8px;bottom:6px;left:6px;}

        /* ── Focus mode ── */
        .wrtc-focus-wrap{flex-direction:column;}
        .wrtc-focus-main{flex:1;min-height:0;}
        .wrtc-focus-tiles{
          flex-direction:row;width:100%;height:90px;overflow-x:auto;overflow-y:hidden;
          border-left:none;border-top:1px solid rgba(255,255,255,.07);
        }
        .wrtc-focus-tile-wrap{width:120px;flex-shrink:0;height:90px;}

        /* ── Presentation thumb strip — horizontal at bottom ── */
        .wrtc-thumbs{
          flex-direction:row;width:100%;height:90px;
          border-left:none;border-top:1px solid rgba(255,255,255,.07);
          overflow-x:auto;overflow-y:hidden;
        }
        .wrtc-thumb-tile{width:120px;flex-shrink:0;height:90px;aspect-ratio:unset;}

        /* ── Knock popup ── */
        .wrtc-knock-popup{width:calc(100vw - 32px);left:16px;transform:none;}

        /* ── Toast ── */
        .wrtc-toast{max-width:calc(100vw - 32px);font-size:13px;}

        /* ── People panel rows ── */
        .wrtc-person{padding:10px 14px;}

        /* ── Lobby (pre-join) ── */
        .wrtc-lobby-card{flex-direction:column;}
        .wrtc-lobby-left{min-height:200px;}
        .wrtc-lobby-right{width:100%;padding:24px 20px;}
      }

    </style>

    <div class="wrtc" id="wrtc-root">

      <!-- TOP BAR -->
      <div class="wrtc-top">
        <div class="wrtc-top-left">
          <button class="wrtc-info-btn" id="wrtc-info-btn" title="Room info">
            i
            <div class="wrtc-info-tooltip" id="wrtc-info-tooltip"></div>
          </button>
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

      <!-- Speaking toast -->
      <div class="wrtc-speak-toast" id="wrtc-speak-toast">
        <div class="wrtc-speak-toast-dot" id="wrtc-speak-dot"></div>
        <span id="wrtc-speak-name"></span>
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
            <div class="wrtc-tile-mic" id="wrtc-mic-ind-local">
              <div class="wrtc-tile-mic-ring" id="wrtc-mic-ring-local"></div>
              <svg class="wrtc-mic-svg-on" width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
              <svg class="wrtc-mic-svg-off" width="13" height="13" viewBox="0 0 24 24" fill="#ea4335" style="display:none"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
            </div>
            <div class="wrtc-tile-label" id="wrtc-pip-label"></div>
          </div>
        </div>
        <!-- Focus mode layout — shown instead of grid when a tile is focused -->
        <div class="wrtc-focus-wrap" id="wrtc-focus-wrap" style="display:none">
          <div class="wrtc-focus-main" id="wrtc-focus-main">
            <div class="wrtc-focus-exit" id="wrtc-focus-exit" title="Exit spotlight">&#x2715;</div>
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
        <div class="wrtc-dev-group">
          <button class="wrtc-btn" id="wrtc-btn-mic" title="Mute / Unmute">
            <span class="wrtc-mic-inner">
              <div class="wrtc-vol-liquid" id="wrtc-vol-liquid"></div>
              <svg id="wrtc-ico-mic" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              </svg>
              <svg id="wrtc-ico-mic-off" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none">
                <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
              </svg>
            </span>
            <span class="wrtc-btn-label" id="wrtc-lbl-mic">Mic</span>
          </button>
          <button class="wrtc-dev-chevron" id="wrtc-chev-mic" title="Select microphone">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </button>
        </div>

        <!-- Camera -->
        <div class="wrtc-dev-group">
          <button class="wrtc-btn" id="wrtc-btn-cam" title="Stop / Start Video">
            <svg id="wrtc-ico-cam" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            </svg>
            <svg id="wrtc-ico-cam-off" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none">
              <path d="M21 6.5l-4-4-9.27 9.27-.73-.73-1.41 1.41.73.73-3 3H3v2h2.27L2 21l1.41 1.41L21 4.91 21 6.5zm-7 7l-5.5-5.5H16v3.5l4-4v9l-1.17-1.17L14 13.5zM3 7h2.27L7 8.73V7H3zm14 10H7.27l-2-2H17v2z"/>
            </svg>
            <span class="wrtc-btn-label" id="wrtc-lbl-cam">Camera</span>
          </button>
          <button class="wrtc-dev-chevron" id="wrtc-chev-cam" title="Select camera">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </button>
        </div>

        <div class="wrtc-divider"></div>

        <!-- Chat (visible toolbar button) -->
        <button class="wrtc-btn" id="wrtc-btn-chat" title="Chat" style="position:relative">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
          </svg>
          <div class="wrtc-btn-badge" id="wrtc-chat-badge-btn"></div>
          <span class="wrtc-btn-label">Chat</span>
        </button>

        <!-- Raise Hand -->
        <button class="wrtc-btn" id="wrtc-btn-hand" title="Raise hand">
          <span style="font-size:20px;line-height:1">✋</span>
          <span class="wrtc-btn-label">Raise Hand</span>
        </button>

        <!-- Reactions -->
        <button class="wrtc-btn" id="wrtc-btn-react" title="Send a reaction">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>
          </svg>
          <span class="wrtc-btn-label">React</span>
        </button>

        <div class="wrtc-divider"></div>

        <!-- Mute All Mics (host only, shown when mics not yet all muted) — normal mic icon (active state) -->
        <button class="wrtc-btn" id="wrtc-btn-muteall" title="Mute all microphones" style="display:none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
          <span class="wrtc-btn-label">Mute All</span>
        </button>
        <!-- Unmute All Mics (host only, shown after muting all) — slashed mic icon (muted state) -->
        <button class="wrtc-btn muted" id="wrtc-btn-unmuteall" title="Unmute all microphones" style="display:none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
          </svg>
          <span class="wrtc-btn-label">Unmute All</span>
        </button>
        <!-- Mute All Cams (host only, shown when cams not yet all muted) — normal camera icon (active state) -->
        <button class="wrtc-btn" id="wrtc-btn-mutecams" title="Mute all cameras" style="display:none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
          </svg>
          <span class="wrtc-btn-label">Cam Off</span>
        </button>
        <!-- Unmute All Cams (host only, shown after muting all cams) — slashed camera icon (muted state) -->
        <button class="wrtc-btn muted" id="wrtc-btn-unmutecams" title="Unmute all cameras" style="display:none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 6.5l-4-4-9.27 9.27-.73-.73-1.41 1.41.73.73-3 3H3v2h2.27L2 21l1.41 1.41L21 4.91 21 6.5zm-7 7l-5.5-5.5H16v3.5l4-4v9l-1.17-1.17L14 13.5zM3 7h2.27L7 8.73V7H3zm14 10H7.27l-2-2H17v2z"/>
          </svg>
          <span class="wrtc-btn-label">Cam On</span>
        </button>

        <div class="wrtc-divider"></div>

        <!-- 3-dot More menu -->
        <button class="wrtc-btn" id="wrtc-btn-more" title="More options" style="position:relative">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5"  r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
          </svg>
          <span class="wrtc-btn-label">More</span>
        </button>

        <!-- Leave -->
        <button class="wrtc-btn wrtc-btn-leave" id="wrtc-btn-leave" title="Leave call">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.28-.28.67-.36 1.02-.25 1.12.37 2.33.57 3.58.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.26.2 2.46.57 3.58.1.35.02.74-.25 1.02L6.6 10.8z" transform="rotate(135,12,12)"/>
          </svg>
          <span class="wrtc-leave-text">Leave</span>
        </button>
      </div>

      <!-- Hidden legacy buttons kept for JS compatibility -->
      <button id="wrtc-btn-share"  style="display:none"></button>
      <button id="wrtc-btn-rec"    style="display:none"></button>
      <button id="wrtc-btn-people" style="display:none"></button>
      <button id="wrtc-btn-filter" style="display:none"></button>
      <button id="wrtc-btn-invite" style="display:none"></button>

      <!-- Reaction picker popup -->
      <div class="wrtc-reaction-picker hidden" id="wrtc-reaction-picker">
        <button class="wrtc-reaction-emoji-btn" data-emoji="👍">👍</button>
        <button class="wrtc-reaction-emoji-btn" data-emoji="👏">👏</button>
        <button class="wrtc-reaction-emoji-btn" data-emoji="❤️">❤️</button>
        <button class="wrtc-reaction-emoji-btn" data-emoji="😂">😂</button>
        <button class="wrtc-reaction-emoji-btn" data-emoji="😮">😮</button>
        <button class="wrtc-reaction-emoji-btn" data-emoji="🎉">🎉</button>
        <button class="wrtc-reaction-emoji-btn" data-emoji="🔥">🔥</button>
      </div>

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
        <div class="wrtc-more-item" id="wrtc-more-invite">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
          </svg>
          <span>Invite People</span>
        </div>
      </div>

      <div class="wrtc-dev-menu" id="wrtc-dev-menu-mic" style="display:none"></div>
      <div class="wrtc-dev-menu" id="wrtc-dev-menu-cam" style="display:none"></div>

      <div class="wrtc-dev-toast" id="wrtc-dev-toast">
        <span id="wrtc-dev-toast-msg"></span>
        <button class="wrtc-dev-toast-btn" id="wrtc-dev-toast-btn">Switch</button>
        <button class="wrtc-dev-toast-dismiss" id="wrtc-dev-toast-dismiss">✕</button>
      </div>

      <div class="wrtc-toast" id="wrtc-toast"></div>

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
    document.getElementById("wrtc-info-tooltip").textContent   = "Room: " + this.roomName;
    document.getElementById("wrtc-room-hint").textContent      = this.roomName;
    document.getElementById("wrtc-pip-label").textContent      = (this._myName || "You") + this._hostTag("local");
    document.getElementById("wrtc-pip-avatar-text").textContent = this._getInitials(this._myName || "You");
    // Block browser's native video right-click context menu ("Show controls" etc.)
    this.parentNode.addEventListener("contextmenu", (e) => {
      if (e.target.tagName === "VIDEO") e.preventDefault();
    });

    // Local tile — pin button (hover-reveal, same as remote tiles)
    {
      const _localPinOverlay = document.createElement("div");
      _localPinOverlay.className = "wrtc-tile-pin";
      const _localPinBtn = document.createElement("div");
      _localPinBtn.className = "wrtc-tile-pin-btn";
      _localPinBtn.title = "Spotlight your video";
      _localPinBtn.innerHTML =
        `<svg width="22" height="22" viewBox="0 0 24 24" fill="white">` +
        `<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
      _localPinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this._presenterUserId || this._isSharing) return; // don't allow self-pin during any screen share
        if (this._focusTileId === "wrtc-local-tile") return;
        if (this._focusTileId) { this._switchFocusTile("wrtc-local-tile"); return; }
        const _remoteTiles = document.querySelectorAll("#wrtc-grid .wrtc-tile:not(#wrtc-local-tile)").length;
        if (_remoteTiles > 0) this._enterFocusMode("wrtc-local-tile");
      });
      _localPinOverlay.appendChild(_localPinBtn);
      document.getElementById("wrtc-local-tile").appendChild(_localPinOverlay);
    }
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
    document.getElementById("wrtc-btn-react").addEventListener("click", (e) => { e.stopPropagation(); this._toggleReactionPicker(); });
    document.querySelectorAll(".wrtc-reaction-emoji-btn").forEach(btn => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); this._sendReaction(btn.dataset.emoji); });
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
      if (this._isRecording) {
        this._stopRecording();
      } else {
        this._showRecordingModal();
      }
    });
    document.getElementById("wrtc-more-people").addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
      this._togglePanel("people");
    });
    document.getElementById("wrtc-more-invite").addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
      this._showInvite();
    });
    // Close more menu and reaction picker on outside click
    document.addEventListener("click", () => {
      document.getElementById("wrtc-more-menu").style.display = "none";
      document.getElementById("wrtc-reaction-picker")?.classList.add("hidden");
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
    if (this._micLocked) {
      this._toast("Your microphone is disabled by the host");
      return;
    }
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
          this._micEnabled    = true;
          this._selfMutedMic  = false; // participant turned mic on themselves
          sessionStorage.removeItem('wrtc_self_mic_' + this.roomName);
          sessionStorage.setItem('wrtc_mic_' + this.roomName, '1');
          document.getElementById("wrtc-btn-mic").classList.remove("muted");
          document.getElementById("wrtc-ico-mic").style.display     = "";
          document.getElementById("wrtc-ico-mic-off").style.display = "none";
          this._setupAudioAnalyser("local", this._localStream);
          this._sendWS({ type: "mic-state", payload: { enabled: true } });
          this._toast("Microphone on");
        })
        .catch(err => {
          this._toast(err.name === "NotAllowedError" ? "Microphone permission denied" : "No microphone available");
        });
      return;
    }

    this._micEnabled = !this._micEnabled;
    this._selfMutedMic = !this._micEnabled; // true when participant turns mic off, false when on
    if (this._selfMutedMic) sessionStorage.setItem('wrtc_self_mic_' + this.roomName, '1');
    else sessionStorage.removeItem('wrtc_self_mic_' + this.roomName);
    this._localStream?.getAudioTracks().forEach(t => { t.enabled = this._micEnabled; });
    sessionStorage.setItem('wrtc_mic_' + this.roomName, this._micEnabled ? '1' : '0');
    document.getElementById("wrtc-btn-mic").classList.toggle("muted", !this._micEnabled);
    document.getElementById("wrtc-ico-mic").style.display     = this._micEnabled ? "" : "none";
    document.getElementById("wrtc-ico-mic-off").style.display = this._micEnabled ? "none" : "";
    this._sendWS({ type: "mic-state", payload: { enabled: this._micEnabled } });
    this._syncLocalMicTile();
    this._toast(this._micEnabled ? "Microphone on" : "Microphone muted");
  }

  _toggleCam() {
    if (this._camLocked) {
      this._toast("Your camera is disabled by the host");
      return;
    }
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
          this._camEnabled   = true;
          this._selfMutedCam = false; // participant turned cam on themselves
          sessionStorage.setItem('wrtc_cam_' + this.roomName, '1');
          sessionStorage.removeItem('wrtc_self_cam_' + this.roomName);
          document.getElementById("wrtc-btn-cam").classList.remove("muted");
          document.getElementById("wrtc-ico-cam").style.display     = "";
          document.getElementById("wrtc-ico-cam-off").style.display = "none";
          document.getElementById("wrtc-local-video").srcObject     = this._activeVideoStream();
          document.getElementById("wrtc-local-video").style.display = "block";
          document.getElementById("wrtc-pip-avatar").style.display  = "none";
          this._sendWS({ type: "cam-state", payload: { enabled: true } });
          if (this._isSharing) this._updateLocalThumb();
          this._toast("Camera on");
        })
        .catch(err => {
          this._toast(err.name === "NotAllowedError" ? "Camera permission denied" : "No camera available");
        });
      return;
    }

    this._camEnabled = !this._camEnabled;
    this._selfMutedCam = !this._camEnabled; // true when participant turns cam off, false when on
    if (this._selfMutedCam) sessionStorage.setItem('wrtc_self_cam_' + this.roomName, '1');
    else sessionStorage.removeItem('wrtc_self_cam_' + this.roomName);
    this._localStream?.getVideoTracks().forEach(t => { t.enabled = this._camEnabled; });
    sessionStorage.setItem('wrtc_cam_' + this.roomName, this._camEnabled ? '1' : '0');
    document.getElementById("wrtc-btn-cam").classList.toggle("muted", !this._camEnabled);
    document.getElementById("wrtc-ico-cam").style.display     = this._camEnabled ? "" : "none";
    document.getElementById("wrtc-ico-cam-off").style.display = this._camEnabled ? "none" : "";
    document.getElementById("wrtc-local-video").style.display = this._camEnabled ? "block" : "none";
    document.getElementById("wrtc-pip-avatar").style.display  = this._camEnabled ? "none"  : "flex";
    this._sendWS({ type: "cam-state", payload: { enabled: this._camEnabled } });
    if (this._isSharing) this._updateLocalThumb();
    this._toast(this._camEnabled ? "Camera on" : "Camera off");
  }

  _updateLocalThumb() {
    const thumbs = document.getElementById("wrtc-thumbs");
    if (!thumbs) return;
    // Remove any existing local thumb — covers both "local" and the old "local-tile" id
    thumbs.querySelectorAll('[data-user-id="local"],[data-user-id="local-tile"]').forEach(el => el.remove());

    const _makeAvatarThumb = () => {
      const _w = document.createElement("div");
      _w.className = "wrtc-thumb-tile";
      _w.dataset.userId = "local";
      const _av = document.createElement("div");
      _av.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#1a1d28;border-radius:10px;";
      const _sp = document.createElement("span");
      _sp.style.cssText = "width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;color:#fff;background:#1a73e8;flex-shrink:0;";
      _sp.textContent = this._getInitials(this._myName || "You");
      _av.appendChild(_sp);
      const _lb = document.createElement("div");
      _lb.className = "wrtc-thumb-label";
      _lb.textContent = (this._myName || "You") + (this._isHost ? " (Host)" : "");
      _w.append(_av, _lb);
      thumbs.appendChild(_w);
    };

    if (!this._camEnabled) { _makeAvatarThumb(); return; }

    // Camera is on — use only live video tracks to avoid black frame from ended tracks
    const _liveTracks = (this._localStream?.getVideoTracks() || []).filter(t => t.readyState === 'live');
    if (_liveTracks.length > 0) {
      const _w = document.createElement("div");
      _w.className = "wrtc-thumb-tile";
      _w.dataset.userId = "local";
      const _tv = document.createElement("video");
      _tv.autoplay = true; _tv.playsInline = true; _tv.muted = true;
      _tv.srcObject = new MediaStream(_liveTracks);
      const _lb = document.createElement("div");
      _lb.className = "wrtc-thumb-label";
      _lb.textContent = (this._myName || "You") + (this._isHost ? " (Host)" : "");
      _w.append(_tv, _lb);
      thumbs.appendChild(_w);
    } else {
      // All camera tracks are ended (browser reclaimed during getDisplayMedia) — restart
      _makeAvatarThumb(); // show avatar while waiting
      navigator.mediaDevices.getUserMedia({ video: true })
        .then(camStream => {
          const newTrack = camStream.getVideoTracks()[0];
          const ended = (this._localStream?.getVideoTracks() || []).filter(t => t.readyState === 'ended');
          ended.forEach(t => { try { this._localStream?.removeTrack(t); } catch (_) {} });
          if (this._localStream) this._localStream.addTrack(newTrack);
          else this._localStream = camStream;
          newTrack.enabled = true;
          if (this._isSharing) this._updateLocalThumb(); // re-render with live track
        })
        .catch(() => {}); // getUserMedia failed — avatar stays
    }
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

      const wasOn = this._camEnabledBeforeShare !== false;
      this._camEnabledBeforeShare = undefined;

      // Only restart the camera track if it was ON before sharing started.
      // If camera was already OFF, don't acquire a new track (would turn hardware on).
      const _endedCamTracks = wasOn
        ? (this._localStream?.getVideoTracks() || []).filter(t => t.readyState === 'ended')
        : [];
      if (_endedCamTracks.length > 0) {
        this._log('Camera track ended during share — restarting camera', undefined, 'warn');
        try {
          const newCamStream = await navigator.mediaDevices.getUserMedia({ video: true });
          const newTrack = newCamStream.getVideoTracks()[0];
          if (newTrack && this._localStream) {
            // Swap out the ended track for the fresh one
            _endedCamTracks.forEach(t => { try { this._localStream.removeTrack(t); } catch (_) {} });
            this._localStream.addTrack(newTrack);
          } else if (newTrack) {
            this._localStream = newCamStream;
          }
        } catch (e) {
          this._log('Camera restart failed: ' + e.message, undefined, 'error');
        }
      }

      // Camera state is unchanged during screen share — no restore needed.

      try { await this._restoreCameraTrack(); } catch (_) {}
      try { this._renegotiateAll(); } catch (_) {}

      document.getElementById("wrtc-more-share").classList.remove("on-air");
      document.getElementById("wrtc-more-share-label").textContent = "Share Screen";

      this._presenterUserId = null;
      this._clearPresenter();

      const _lv = document.getElementById("wrtc-local-video");
      _lv.style.display = this._camEnabled ? "block" : "none";
      if (this._camEnabled) {
        const _stream = this._activeVideoStream();
        _lv.srcObject = null;
        _lv.srcObject = _stream;
        _lv.play().catch(() => {});
        setTimeout(() => { if (_lv.paused) _lv.play().catch(() => {}); }, 300);
      }
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
        this._camEnabledBeforeShare = this._camEnabled;

        // Some browsers end the camera track when getDisplayMedia is called.
        // Restart the camera so the thumbnail strip shows a live feed.
        if (this._camEnabled) {
          const _camTrack = this._localStream?.getVideoTracks()[0];
          if (!_camTrack || _camTrack.readyState === 'ended') {
            try {
              const newCam = await navigator.mediaDevices.getUserMedia({ video: true });
              const newTrack = newCam.getVideoTracks()[0];
              if (newTrack && this._localStream) {
                if (_camTrack) { try { this._localStream.removeTrack(_camTrack); } catch (_) {} }
                this._localStream.addTrack(newTrack);
              } else if (newTrack) {
                this._localStream = newCam;
              }
              // Re-point local video element to refreshed stream
              const _lv = document.getElementById("wrtc-local-video");
              if (_lv) { _lv.srcObject = null; _lv.srcObject = this._localStream; _lv.play().catch(() => {}); }
            } catch (_e) { this._log('Camera restart on share failed: ' + _e.message, undefined, 'warn'); }
          }
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
      // If viewer has a tile pinned, keep their pinned view — don't switch to presenter layout
      if (this._focusTileId) return;
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

    // Move remote tiles to the thumbnail strip
    document.querySelectorAll(".wrtc-tile:not(#wrtc-local-share-tile):not(#wrtc-local-tile)").forEach(t => {
      this._addThumb(t, thumbs);
      t.style.display = "none";
    });
    // Always show local tile in the thumbnail strip — camera feed if on, avatar if off
    const localTile = document.getElementById("wrtc-local-tile");
    if (localTile) {
      if (this._camEnabled) {
        this._addThumb(localTile, thumbs);
      } else {
        const _lWrap = document.createElement("div");
        _lWrap.className = "wrtc-thumb-tile";
        _lWrap.dataset.userId = "local";
        const _lAvatar = document.createElement("div");
        _lAvatar.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#1a1d28;border-radius:10px;";
        const _lSpan = document.createElement("span");
        _lSpan.style.cssText = "width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;color:#fff;background:#1a73e8;flex-shrink:0;";
        _lSpan.textContent = this._getInitials(this._myName || "You");
        _lAvatar.appendChild(_lSpan);
        const _lLbl = document.createElement("div");
        _lLbl.className = "wrtc-thumb-label";
        _lLbl.textContent = (this._myName || "You") + (this._isHost ? " (Host)" : "");
        _lWrap.append(_lAvatar, _lLbl);
        thumbs.appendChild(_lWrap);
      }
    }
    if (localTile) localTile.style.display = "none";
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
    const userId = tile.id === "wrtc-local-tile" ? "local" : (tile.id.replace("wrtc-tile-", "") || "local");
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

    // Pin overlay — hover to reveal, click to pin this participant into spotlight
    if (userId !== "local") {
      const pinOverlay = document.createElement("div");
      pinOverlay.className = "wrtc-thumb-pin";
      const pinBtn = document.createElement("div");
      pinBtn.className = "wrtc-thumb-pin-btn";
      pinBtn.title = "Spotlight this participant";
      pinBtn.innerHTML =
        `<svg width="20" height="20" viewBox="0 0 24 24" fill="white">` +
        `<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
      pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tileId = `wrtc-tile-${userId}`;
        // Restore tiles from presentation layout first, then enter focus mode
        // (_presenterUserId stays set so exiting focus re-applies presenter layout)
        this._clearPresenter();
        this._enterFocusMode(tileId);
      });
      pinOverlay.appendChild(pinBtn);
      wrap.appendChild(pinOverlay);
    }

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
    if (this._sfuAvailable && this._sfuVideoProducer) {
      await this._sfuVideoProducer.replaceTrack({ track: newTrack });
      return;
    }
    for (const pc of Object.values(this._peerConnections)) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
    }
  }

  async _restoreCameraTrack() {
    // If a virtual background filter is active, restore the filter track (not raw camera).
    const track = this._activeVideoTrack();
    if (!track) return;
    if (this._sfuAvailable && this._sfuVideoProducer) {
      try { await this._sfuVideoProducer.replaceTrack({ track }); } catch (_) {}
      return;
    }
    for (const pc of Object.values(this._peerConnections)) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) { try { await sender.replaceTrack(track); } catch (_) {} }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RECORDING
  // ═══════════════════════════════════════════════════════════════════════
  // ── Recording mode modal ────────────────────────────────────────────────────

  _showRecordingModal() {
    const screenActive = this._isSharing && this._shareStream;
    const overlay = document.createElement("div");
    overlay.id = "wrtc-rec-modal-overlay";
    overlay.style.cssText = [
      "position:fixed;inset:0;z-index:9999",
      "background:rgba(0,0,0,.65)",
      "display:flex;align-items:center;justify-content:center",
    ].join(";");

    const modes = screenActive
      ? [
          { id: "screen-only",  icon: "🖥️",   title: "Record Shared Screen",        desc: "Records only the shared screen and your mic audio." },
          { id: "screen-host",  icon: "🖥️👤",  title: "Screen + Host Camera",        desc: "Shared screen fullscreen with your webcam in the corner." },
          { id: "everything",   icon: "🎬",   title: "Record Everything",           desc: "All video tiles and all audio mixed together." },
        ]
      : [
          { id: "host-only",    icon: "👤",   title: "Record Host Only",            desc: "Captures your webcam and microphone." },
          { id: "everything",   icon: "🎬",   title: "Record All Participants",     desc: "All video tiles and all audio mixed together." },
        ];

    const cards = modes.map(m => `
      <div data-mode="${m.id}" style="
        flex:1;min-width:160px;max-width:220px;cursor:pointer;border-radius:14px;
        border:2px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);
        padding:22px 18px;display:flex;flex-direction:column;align-items:center;
        gap:10px;transition:border-color .15s,background .15s;text-align:center;
      " onmouseover="this.style.borderColor='#6c63ff';this.style.background='rgba(108,99,255,.15)'"
         onmouseout="this.style.borderColor='rgba(255,255,255,.12)';this.style.background='rgba(255,255,255,.05)'">
        <span style="font-size:28px">${m.icon}</span>
        <span style="font-size:13px;font-weight:700;color:#e8eaed">${m.title}</span>
        <span style="font-size:11px;color:#9aa0a6;line-height:1.5">${m.desc}</span>
      </div>`).join("");

    overlay.innerHTML = `
      <div style="background:#1e2029;border:1px solid rgba(255,255,255,.1);border-radius:18px;
                  padding:28px 32px;max-width:720px;width:90%;box-shadow:0 24px 64px rgba(0,0,0,.6)">
        <div style="font-size:18px;font-weight:700;color:#e8eaed;margin-bottom:6px">Choose Recording Mode</div>
        <div style="font-size:13px;color:#9aa0a6;margin-bottom:22px">
          ${screenActive ? "Screen sharing is active." : "No screen share active."}
          Select what to record.
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center">${cards}</div>
        <div style="margin-top:20px;text-align:right">
          <button id="wrtc-rec-cancel" style="padding:9px 22px;background:transparent;border:1px solid rgba(255,255,255,.2);
            border-radius:8px;color:#9aa0a6;font-size:13px;cursor:pointer">Cancel</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    overlay.querySelectorAll("[data-mode]").forEach(el => {
      el.addEventListener("click", () => {
        document.body.removeChild(overlay);
        this._startRecording(el.dataset.mode);
      });
    });
    document.getElementById("wrtc-rec-cancel").addEventListener("click", () => document.body.removeChild(overlay));
    overlay.addEventListener("click", e => { if (e.target === overlay) document.body.removeChild(overlay); });
  }

  // ── Canvas compositor helper ─────────────────────────────────────────────────

  _buildCanvasStream(videoEls, w = 1280, h = 720) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx    = canvas.getContext("2d");

    const draw = () => {
      // Re-query every frame so new elements (e.g. screen share tile added after recording starts) are captured
      const els   = this._getAllVideoEls();
      const count = els.length;
      const hasScreen = this._isSharing && count > 0;

      ctx.fillStyle = "#0f1117";
      ctx.fillRect(0, 0, w, h);
      if (!count) return;

      if (count === 1) {
        if (els[0].readyState >= 2) ctx.drawImage(els[0], 0, 0, w, h);
      } else if (hasScreen && count >= 2) {
        // Screen takes left 70%, cameras stack in right 30%
        const screenW = Math.floor(w * 0.70);
        const sideW   = w - screenW;
        const cams    = els.slice(1);
        const camH    = Math.floor(h / cams.length);

        if (els[0].readyState >= 2) ctx.drawImage(els[0], 0, 0, screenW, h);

        // Divider line
        ctx.fillStyle = "#000";
        ctx.fillRect(screenW, 0, 2, h);

        cams.forEach((v, i) => {
          if (v.readyState >= 2) ctx.drawImage(v, screenW + 2, i * camH, sideW - 2, camH);
          // Separator between cams
          if (i > 0) { ctx.fillStyle = "#000"; ctx.fillRect(screenW + 2, i * camH, sideW - 2, 1); }
        });
      } else {
        // Equal grid for cameras only
        const cols = count <= 2 ? 2 : count <= 4 ? 2 : 3;
        const rows = Math.ceil(count / cols);
        const tw   = Math.floor(w / cols);
        const th   = Math.floor(h / rows);
        els.forEach((v, i) => {
          if (v.readyState < 2) return;
          ctx.drawImage(v, (i % cols) * tw, Math.floor(i / cols) * th, tw, th);
        });
      }
    };

    let rafId;
    const loop = () => { draw(); rafId = requestAnimationFrame(loop); };
    loop();
    const stream = canvas.captureStream(30);
    stream._stopCanvas = () => cancelAnimationFrame(rafId);
    return stream;
  }

  _buildPipStream(screenVid, hostVid, w = 1280, h = 720) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const pipW = Math.floor(w * 0.25), pipH = Math.floor(h * 0.25);
    const pipX = w - pipW - 16, pipY = h - pipH - 16;

    function draw() {
      ctx.fillStyle = "#0f1117";
      ctx.fillRect(0, 0, w, h);
      if (screenVid.readyState >= 2) ctx.drawImage(screenVid, 0, 0, w, h);
      if (hostVid && hostVid.readyState >= 2) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(pipX, pipY, pipW, pipH, 8);
        ctx.clip();
        ctx.drawImage(hostVid, pipX, pipY, pipW, pipH);
        ctx.restore();
        ctx.strokeStyle = "rgba(255,255,255,.4)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(pipX, pipY, pipW, pipH, 8);
        ctx.stroke();
      }
    }

    let rafId;
    function loop() { draw(); rafId = requestAnimationFrame(loop); }
    loop();
    const stream = canvas.captureStream(30);
    stream._stopCanvas = () => cancelAnimationFrame(rafId);
    return stream;
  }

  _mixAudioStreams(streams) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = audioCtx.createMediaStreamDestination();
    streams.forEach(s => {
      if (s && s.getAudioTracks().length) {
        audioCtx.createMediaStreamSource(s).connect(dest);
      }
    });
    return { audioCtx, audioStream: dest.stream };
  }

  _getAllVideoEls() {
    const seen = new Set();
    const els  = [];
    const add  = v => {
      if (!v?.srcObject) return;
      const id = v.srcObject.id;
      if (seen.has(id)) return;
      seen.add(id); els.push(v);
    };
    // Screen share tile first (so it's the dominant tile in grid layout)
    if (this._isSharing) {
      add(document.getElementById("wrtc-local-share-tile")?.querySelector("video"));
    }
    // Local camera
    add(document.getElementById("wrtc-local-video"));
    // Remote tiles (may be hidden during screen share but still in DOM)
    document.querySelectorAll(".wrtc-tile:not(#wrtc-local-tile):not(#wrtc-local-share-tile) video").forEach(add);
    return els;
  }

  _getAllAudioStreams() {
    const seen    = new Set();
    const streams = [];
    const add = s => {
      if (!s || seen.has(s.id)) return;
      seen.add(s.id); streams.push(s);
    };
    if (this._isSharing && this._shareStream) add(this._shareStream);
    if (this._localStream) add(this._localStream);
    document.querySelectorAll(".wrtc-tile:not(#wrtc-local-tile):not(#wrtc-local-share-tile) video").forEach(v => {
      if (v.srcObject) add(v.srcObject);
    });
    return streams;
  }

  // ── Start recording with chosen mode ────────────────────────────────────────

  async _startRecording(mode) {
    let combinedStream = null;
    let audioCtx       = null;
    let canvasStream   = null;
    const offscreenEls = [];

    // Helper: create an off-screen video element playing a stream, await readiness
    const makeOffscreen = async stream => {
      const el = document.createElement("video");
      el.srcObject   = stream;
      el.muted       = true;
      el.autoplay    = true;
      el.playsInline = true;
      el.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none";
      document.body.appendChild(el);
      offscreenEls.push(el);
      await el.play().catch(() => {});
      await new Promise(r => setTimeout(r, 80)); // let readyState update
      return el;
    };

    const cleanup = () => {
      canvasStream?._stopCanvas?.();
      try { audioCtx?.close(); } catch (_) {}
      offscreenEls.forEach(el => { el.srcObject = null; try { document.body.removeChild(el); } catch (_) {} });
    };

    try {
      const mimeType = ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"]
        .find(t => MediaRecorder.isTypeSupported(t)) || "";

      if (mode === "screen-only") {
        if (!this._shareStream) { this._toast("Start screen sharing first"); return; }
        // Screen video tracks + mic audio tracks — no canvas, no compositing
        const screenVideoTracks = this._shareStream.getVideoTracks();
        const micAudioTracks    = (this._localStream?.getAudioTracks() || []).filter(t => t.readyState === "live");
        // Also include any system/tab audio the user chose to share
        const screenAudioTracks = this._shareStream.getAudioTracks();
        combinedStream = new MediaStream([...screenVideoTracks, ...screenAudioTracks, ...micAudioTracks]);

      } else if (mode === "screen-host") {
        if (!this._shareStream) { this._toast("Start screen sharing first"); return; }
        if (!this._camEnabled)  { this._toast("Turn on your camera first"); return; }
        const screenEl = await makeOffscreen(this._shareStream);
        const camEl    = await makeOffscreen(this._localStream);
        canvasStream   = this._buildPipStream(screenEl, camEl);
        const { audioCtx: ac, audioStream } = this._mixAudioStreams(
          [this._shareStream, this._localStream].filter(Boolean)
        );
        audioCtx = ac;
        combinedStream = new MediaStream([
          ...canvasStream.getVideoTracks(),
          ...audioStream.getAudioTracks(),
        ]);

      } else if (mode === "host-only") {
        if (!this._localStream) { this._toast("No camera/mic available"); return; }
        const tracks = [
          ...this._localStream.getVideoTracks().filter(t => t.readyState === "live"),
          ...this._localStream.getAudioTracks().filter(t => t.readyState === "live"),
        ];
        if (!tracks.length) { this._toast("Camera and mic are not active"); return; }
        combinedStream = new MediaStream(tracks);

      } else if (mode === "everything") {
        const videoEls = this._getAllVideoEls();
        if (!videoEls.length) { this._toast("No video sources available"); return; }
        canvasStream = this._buildCanvasStream(videoEls);
        const { audioCtx: ac, audioStream } = this._mixAudioStreams(this._getAllAudioStreams());
        audioCtx = ac;
        combinedStream = new MediaStream([
          ...canvasStream.getVideoTracks(),
          ...audioStream.getAudioTracks(),
        ]);
      }

      if (!combinedStream) return;

      this._recordChunks  = [];
      this._recordCleanup = cleanup;

      this._mediaRecorder = new MediaRecorder(combinedStream, mimeType ? { mimeType } : {});
      this._mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this._recordChunks.push(e.data); };
      this._mediaRecorder.onstop = () => {
        this._recordCleanup?.();
        this._recordCleanup = null;
        const blob       = new Blob(this._recordChunks, { type: mimeType || "video/webm" });
        const embedToken = this._embedTokenSaved || '';
        const roomName   = this.roomName || '';
        const fname      = `recording-${Date.now()}.webm`;
        if (this._recordingEndpoint && this._recordingToken) {
          // Public-meet: upload to dedicated public recordings endpoint
          const form = new FormData();
          form.append('file', blob, fname);
          fetch(
            this._recordingEndpoint + '?room_code=' + encodeURIComponent(roomName),
            { method: 'POST', headers: { Authorization: `Bearer ${this._recordingToken}` }, body: form }
          )
            .then(r => r.ok ? this._toast('Recording saved to your dashboard') : this._toast('Recording upload failed'))
            .catch(() => this._toast('Recording upload failed'));
        } else if (embedToken) {
          const form = new FormData();
          form.append('file', blob, fname);
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

      this._mediaRecorder.start(1000);
      this._isRecording  = true;
      this._recordingMode = mode;
      document.getElementById("wrtc-more-rec").classList.add("on-air");
      document.getElementById("wrtc-more-rec-label").textContent = "Stop Recording";
      document.getElementById("wrtc-rec-badge").classList.add("active");
      document.getElementById("wrtc-rec-circle").setAttribute("fill", "#fff");
      this._toast("Recording started");

    } catch (err) {
      cleanup();
      if (err.name !== "NotAllowedError") this._toast("Recording failed: " + err.message);
      this._log("Recording error: " + err.message, undefined, "error");
    }
  }

  _stopRecording() {
    this._mediaRecorder?.stop();
    this._isRecording   = false;
    this._recordingMode = null;
    this._recordTabStream?.getTracks().forEach(t => t.stop());
    this._recordTabStream = null;
    document.getElementById("wrtc-more-rec")?.classList.remove("on-air");
    const _recLbl = document.getElementById("wrtc-more-rec-label");
    if (_recLbl) _recLbl.textContent = "Record";
    document.getElementById("wrtc-rec-badge")?.classList.remove("active");
    document.getElementById("wrtc-rec-circle")?.setAttribute("fill", "currentColor");
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
    this._repositionPip();
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
    this._repositionPip();
  }

  _repositionPip() {
    const localTile = document.getElementById("wrtc-local-tile");
    if (!localTile || localTile.style.position !== "fixed") return;
    localTile.style.right = (this._panelTab ? 356 : 16) + "px";
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
    const isHostUser = (isMe && this._isHost) || (!isMe && userId === this._hostUserId);
    if (isHostUser) {
      const hostTag = document.createElement("span");
      hostTag.className = "wrtc-host-tag";
      hostTag.textContent = "(Host)";
      nameEl.appendChild(hostTag);
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

    // Host controls — only rendered for host, hidden for self
    if (this._isHost && !isMe) {
      const _btnStyle =
        "background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);cursor:pointer;"
        + "padding:3px 9px;border-radius:6px;color:#e8eaed;font-size:11px;font-weight:500;"
        + "font-family:inherit;transition:background .15s;flex-shrink:0;";

      // ── Mic button ──────────────────────────────────────────────────────────
      // Show "Mute" when mic is on, "Unmute" only when admin force-muted them,
      // nothing when participant self-muted (no confusion).
      // _hostForcedOffMic stores base user IDs (UUID without session suffix).
      const baseUserId = userId.split('_')[0];
      const adminMutedMic = this._hostForcedOffMic.has(baseUserId);
      // If admin already force-muted, treat mic as off regardless of self-reported state
      const micOn = adminMutedMic ? false : (this._micStates[userId] !== false);
      if (micOn || adminMutedMic) {
        const muteBtn = document.createElement("button");
        muteBtn.dataset.uid = userId;
        muteBtn.style.cssText = _btnStyle;
        if (micOn) {
          muteBtn.textContent = "Mute";
          muteBtn.title = "Mute microphone";
          muteBtn.addEventListener("click", () => {
            this._sendWS({ type: "host-mute-user", payload: { target_id: userId } });
            this._hostForcedOffMic.add(baseUserId);
            this._micStates[userId] = false;
            this._renderParticipants();
          });
        } else {
          muteBtn.textContent = "Unmute";
          muteBtn.title = "Unmute microphone";
          muteBtn.addEventListener("click", () => {
            this._sendWS({ type: "host-unmute-user", payload: { target_id: userId } });
            this._hostForcedOffMic.delete(baseUserId);
            this._micStates[userId] = true;
            this._renderParticipants();
          });
        }
        icons.appendChild(muteBtn);
      }

      // ── Cam button ──────────────────────────────────────────────────────────
      // Show "Cam off" when cam is on, "Cam on" only when admin force-turned it off,
      // nothing when participant self-turned it off (no confusion).
      const adminMutedCam = this._hostForcedOffCam.has(baseUserId);
      // If admin already force-turned off, treat cam as off regardless of self-reported state
      const camOn = adminMutedCam ? false : (this._camStates[userId] !== false);
      if (camOn || adminMutedCam) {
        const camBtn = document.createElement("button");
        camBtn.style.cssText = _btnStyle;
        if (camOn) {
          camBtn.textContent = "Cam off";
          camBtn.title = "Turn off camera";
          camBtn.addEventListener("click", () => {
            this._sendWS({ type: "host-cam-off-user", payload: { target_id: userId } });
            this._hostForcedOffCam.add(baseUserId);
            this._camStates[userId] = false;
            this._renderParticipants();
          });
        } else {
          camBtn.textContent = "Cam on";
          camBtn.title = "Turn on camera";
          camBtn.addEventListener("click", () => {
            this._sendWS({ type: "host-cam-on-user", payload: { target_id: userId } });
            this._hostForcedOffCam.delete(baseUserId);
            this._camStates[userId] = true;
            this._renderParticipants();
          });
        }
        icons.appendChild(camBtn);
      }

      // Remove button
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
      this._renderMessage("You" + this._hostTag("local"), text, ts, true, "public");
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

    const isHostName = !isMine && name.includes("(Host)");
    const div = document.createElement("div");
    div.className = `wrtc-msg${isMine ? " mine" : ""}`;
    div.innerHTML = `
      ${isPrivate ? '<div class="wrtc-msg-private-label">🔒 Private</div>' : ""}
      <div class="wrtc-msg-header">
        <span class="wrtc-msg-name${isMine ? " mine" : isHostName ? " host" : ""}">${name}</span>
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
    // Persist so hand stays raised through a page refresh
    if (this._handRaised) sessionStorage.setItem('wrtc_hand_' + this.roomName, '1');
    else                  sessionStorage.removeItem('wrtc_hand_' + this.roomName);
  }

  _updateHandUI(userId, raised) {
    const hand = document.getElementById(`wrtc-hand-${userId}`);
    if (hand) hand.classList.toggle("raised", raised);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PARTICLE BURST
  // ═══════════════════════════════════════════════════════════════════════
  _particleBurst(tile) {
    const rect   = tile.getBoundingClientRect();
    const cx     = rect.left + rect.width  / 2;
    const cy     = rect.top  + rect.height / 2;
    const colors = ["#4d94ff","#34a853","#fbbc04","#ea4335","#a142f4","#ff6d00","#00bcd4"];
    const count  = 14;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 2 * Math.PI;
      const dist  = 55 + Math.random() * 50;
      const px    = Math.round(Math.cos(angle) * dist);
      const py    = Math.round(Math.sin(angle) * dist);
      const el    = document.createElement("div");
      el.className = "wrtc-particle";
      el.style.cssText = `left:${cx}px;top:${cy}px;background:${colors[i % colors.length]};--px:${px}px;--py:${py}px;animation-delay:${(Math.random()*0.12).toFixed(2)}s`;
      document.body.appendChild(el);
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SPEAKING TOAST
  // ═══════════════════════════════════════════════════════════════════════
  _showSpeakToast(uid) {
    const toast = document.getElementById("wrtc-speak-toast");
    const dot   = document.getElementById("wrtc-speak-dot");
    const name  = document.getElementById("wrtc-speak-name");
    if (!toast) return;
    const displayName = uid === "local" ? (this._myName || "You") : this._displayName(uid);
    const color = uid === "local" ? "#4d94ff" : this._colorFromId(uid);
    dot.style.background  = color;
    name.textContent      = `${displayName} is speaking`;
    clearTimeout(this._speakToastTimer);
    toast.classList.add("show");
    this._speakToastTimer = setTimeout(() => this._hideSpeakToast(), 3500);
  }

  _hideSpeakToast() {
    document.getElementById("wrtc-speak-toast")?.classList.remove("show");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONNECTION QUALITY
  // ═══════════════════════════════════════════════════════════════════════
  _startQualityMonitor() {
    const update = async () => {
      for (const [uid, pc] of Object.entries(this._peerConnections)) {
        try {
          const stats = await pc.getStats();
          let loss = 0, rtt = 0, found = false;
          stats.forEach(r => {
            if (r.type === "inbound-rtp" && r.kind === "video") {
              const sent     = (r.packetsReceived || 0) + (r.packetsLost || 0);
              loss = sent > 0 ? r.packetsLost / sent : 0;
              found = true;
            }
            if (r.type === "candidate-pair" && r.state === "succeeded") {
              rtt = r.currentRoundTripTime || 0;
            }
          });
          if (!found) continue;
          let q = "good";
          if (loss > 0.08 || rtt > 0.4) q = "poor";
          else if (loss > 0.02 || rtt > 0.15) q = "ok";
          const sig = document.getElementById(`wrtc-signal-${uid}`);
          if (sig) sig.dataset.q = q;
        } catch {}
      }
    };
    this._qualityInterval = setInterval(update, 4000);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AUTO-HIDE CONTROLS
  // ═══════════════════════════════════════════════════════════════════════
  _initAutoHideControls() {
    const controls = document.getElementById("wrtc-controls");
    const stage    = document.getElementById("wrtc-stage");
    if (!controls || !stage) return;
    let _hideTimer = null;
    const show = () => {
      controls.classList.remove("wrtc-ctrl-hidden");
      clearTimeout(_hideTimer);
      _hideTimer = setTimeout(() => {
        controls.classList.add("wrtc-ctrl-hidden");
        document.getElementById("wrtc-reaction-picker")?.classList.add("hidden");
      }, 10000);
    };
    stage.addEventListener("mousemove", show);
    stage.addEventListener("mouseenter", show);
    controls.addEventListener("mouseenter", () => clearTimeout(_hideTimer));
    controls.addEventListener("mouseleave", show);
    show();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REACTIONS
  // ═══════════════════════════════════════════════════════════════════════
  _toggleReactionPicker() {
    const picker = document.getElementById("wrtc-reaction-picker");
    const btn    = document.getElementById("wrtc-btn-react");
    const hidden = picker.classList.contains("hidden");
    if (hidden) {
      picker.classList.remove("hidden");
      // Position above the button
      const rect   = btn.getBoundingClientRect();
      const pickerW = picker.offsetWidth || 310;
      let left = rect.left + rect.width / 2 - pickerW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - pickerW - 8));
      picker.style.left   = left + "px";
      picker.style.bottom = (window.innerHeight - rect.top + 10) + "px";
      picker.style.top    = "";
    } else {
      picker.classList.add("hidden");
    }
  }

  _sendReaction(emoji) {
    document.getElementById("wrtc-reaction-picker")?.classList.add("hidden");
    // Show on own tile
    const localTile = document.getElementById("wrtc-local-tile");
    if (localTile) this._showReactionOnTile(localTile, emoji);
    // Broadcast to peers
    this._sendWS({ type: "reaction", payload: { emoji } });
  }

  _showReactionOnTile(tileOrUserId, emoji) {
    let tile;
    if (typeof tileOrUserId === "string") {
      tile = document.getElementById(`wrtc-tile-${tileOrUserId}`);
    } else {
      tile = tileOrUserId;
    }
    if (!tile) return;
    // Randomise horizontal offset slightly so multiple reactions don't stack
    const offset = (Math.random() - 0.5) * 40;
    const el = document.createElement("div");
    el.className = "wrtc-reaction-float";
    el.textContent = emoji;
    el.style.left = `calc(50% + ${offset}px)`;
    tile.appendChild(el);
    // Remove after animation ends
    el.addEventListener("animationend", () => el.remove());
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
    // Asymmetric EMA: fast attack, slow decay — gives snappy visual response.
    const THRESHOLD = 8 / 255;
    const RISE = 0.65, DECAY = 0.88;

    const tick = () => {
      this._speakerRafId = requestAnimationFrame(tick);
      let maxLevel = THRESHOLD, activeSpeaker = null;

      for (const [uid, analyser] of Object.entries(this._analysers)) {
        const raw     = this._getAudioLevel(analyser) / 255;
        const prev    = this._smoothedLevels[uid] || 0;
        const smoothed = raw > prev ? prev + (raw - prev) * RISE : prev * DECAY;
        this._smoothedLevels[uid] = smoothed;

        // Drive per-tile mic ring
        const ringId = uid === "local" ? "wrtc-mic-ring-local" : `wrtc-mic-ring-${uid}`;
        const ring   = document.getElementById(ringId);
        if (ring) {
          const s = Math.min(1.8, 0.6 + smoothed * 9);
          const o = Math.min(0.9, smoothed * 12);
          ring.style.transform = `scale(${s.toFixed(3)})`;
          ring.style.opacity   = o.toFixed(3);
        }
        // Drive mic liquid fill in control bar (local only)
        if (uid === "local") {
          const liq = document.getElementById("wrtc-vol-liquid");
          if (liq) {
            const fill = this._micEnabled ? (Math.min(1, smoothed * 6) * 100).toFixed(1) + "%" : "0%";
            liq.style.height = fill;
          }
        }

        if (smoothed > maxLevel) { maxLevel = smoothed; activeSpeaker = uid; }
      }

      if (activeSpeaker !== this._currentSpeaker) {
        if (this._currentSpeaker) {
          const prev = this._currentSpeaker === "local"
            ? document.getElementById("wrtc-local-tile")
            : document.getElementById(`wrtc-tile-${this._currentSpeaker}`);
          prev?.classList.remove("speaking");
        }
        if (activeSpeaker) {
          const el = activeSpeaker === "local"
            ? document.getElementById("wrtc-local-tile")
            : document.getElementById(`wrtc-tile-${activeSpeaker}`);
          el?.classList.add("speaking");
          this._showSpeakToast(activeSpeaker);
        } else {
          this._hideSpeakToast();
        }
        this._currentSpeaker = activeSpeaker;
      }
    };

    this._speakerRafId = requestAnimationFrame(tick);
  }

  /** Sync the local tile mic indicator icon with current mic state. */
  _syncLocalMicTile() {
    const on  = this._micEnabled;
    const ind = document.getElementById("wrtc-mic-ind-local");
    if (!ind) return;
    ind.classList.toggle("muted", !on);
    const onSvg  = ind.querySelector(".wrtc-mic-svg-on");
    const offSvg = ind.querySelector(".wrtc-mic-svg-off");
    if (onSvg)  onSvg.style.display  = on ? "" : "none";
    if (offSvg) offSvg.style.display = on ? "none" : "";
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
  // DEVICE SWITCHER
  // ═══════════════════════════════════════════════════════════════════════
  async _initDeviceWatcher() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this._knownDevices = devices.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
      const audioTrack = this._localStream?.getAudioTracks()[0];
      const videoTrack = this._localStream?.getVideoTracks()[0];
      this._currentMicId = audioTrack?.getSettings()?.deviceId || null;
      this._currentCamId = videoTrack?.getSettings()?.deviceId || null;
    } catch(_) {}

    navigator.mediaDevices.addEventListener('devicechange', () => this._onDeviceChange());

    document.getElementById('wrtc-chev-mic')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleDeviceMenu('mic');
    });
    document.getElementById('wrtc-chev-cam')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleDeviceMenu('cam');
    });
    document.getElementById('wrtc-dev-toast-dismiss')?.addEventListener('click', () => this._hideDevToast());
    document.getElementById('wrtc-dev-toast-btn')?.addEventListener('click', () => {
      if (this._pendingSwitch) {
        const { kind, deviceId } = this._pendingSwitch;
        if (kind === 'audioinput') this._switchMic(deviceId);
        else if (kind === 'audiooutput') this._switchSpeaker(deviceId);
        else this._switchCam(deviceId);
      }
      this._hideDevToast();
    });
    document.addEventListener('click', () => this._closeDeviceMenus());
  }

  async _onDeviceChange() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const relevant = devices.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
      const prev = this._knownDevices || [];

      // Count-based diff — avoids false positives when Chrome rehashes deviceIds
      const prevAudio  = prev.filter(d => d.kind === 'audioinput').length;
      const prevVideo  = prev.filter(d => d.kind === 'videoinput').length;
      const prevOutput = prev.filter(d => d.kind === 'audiooutput').length;
      const nextAudio  = relevant.filter(d => d.kind === 'audioinput').length;
      const nextVideo  = relevant.filter(d => d.kind === 'videoinput').length;
      const nextOutput = relevant.filter(d => d.kind === 'audiooutput').length;

      this._knownDevices = relevant;

      if (nextAudio > prevAudio) {
        const prevIds = new Set(prev.filter(d => d.kind === 'audioinput').map(d => d.deviceId));
        const newMic = relevant.filter(d => d.kind === 'audioinput').find(d => !prevIds.has(d.deviceId))
          || relevant.filter(d => d.kind === 'audioinput').pop();
        if (newMic) {
          this._pendingSwitch = { kind: 'audioinput', deviceId: newMic.deviceId };
          this._showDevToast(`New microphone connected: ${newMic.label || 'Microphone'}`);
        }
      } else if (nextOutput > prevOutput) {
        const prevIds = new Set(prev.filter(d => d.kind === 'audiooutput').map(d => d.deviceId));
        const newSpk = relevant.filter(d => d.kind === 'audiooutput').find(d => !prevIds.has(d.deviceId))
          || relevant.filter(d => d.kind === 'audiooutput').pop();
        if (newSpk) {
          this._pendingSwitch = { kind: 'audiooutput', deviceId: newSpk.deviceId };
          this._showDevToast(`New speaker connected: ${newSpk.label || 'Speaker'}`);
        }
      } else if (nextVideo > prevVideo) {
        const prevIds = new Set(prev.filter(d => d.kind === 'videoinput').map(d => d.deviceId));
        const newCam = relevant.filter(d => d.kind === 'videoinput').find(d => !prevIds.has(d.deviceId))
          || relevant.filter(d => d.kind === 'videoinput').pop();
        if (newCam) {
          this._pendingSwitch = { kind: 'videoinput', deviceId: newCam.deviceId };
          this._showDevToast(`New camera connected: ${newCam.label || 'Camera'}`);
        }
      }
    } catch(_) {}
  }

  _showDevToast(msg) {
    const toast = document.getElementById('wrtc-dev-toast');
    const msgEl = document.getElementById('wrtc-dev-toast-msg');
    if (!toast || !msgEl) return;
    msgEl.textContent = msg;
    toast.classList.add('show');
    clearTimeout(this._devToastTimer);
    this._devToastTimer = setTimeout(() => this._hideDevToast(), 8000);
  }

  _hideDevToast() {
    document.getElementById('wrtc-dev-toast')?.classList.remove('show');
    clearTimeout(this._devToastTimer);
    this._pendingSwitch = null;
  }

  async _toggleDeviceMenu(kind) {
    const menuId = kind === 'mic' ? 'wrtc-dev-menu-mic' : 'wrtc-dev-menu-cam';
    const chevId = kind === 'mic' ? 'wrtc-chev-mic' : 'wrtc-chev-cam';
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    this._closeDeviceMenus();
    if (!isOpen) {
      await this._buildDeviceMenu(kind);
      menu.style.visibility = 'hidden';
      menu.style.display = 'flex';
      // Position after paint so offsetWidth/Height are valid
      requestAnimationFrame(() => {
        const chev = document.getElementById(chevId);
        if (chev) {
          const rect = chev.getBoundingClientRect();
          menu.style.left = Math.max(8, rect.left - menu.offsetWidth + rect.width) + 'px';
          menu.style.top = (rect.top - menu.offsetHeight - 8) + 'px';
        }
        menu.style.visibility = '';
      });
    }
  }

  _closeDeviceMenus() {
    ['wrtc-dev-menu-mic', 'wrtc-dev-menu-speaker', 'wrtc-dev-menu-cam'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  async _buildDeviceMenu(kind) {
    const menuId = kind === 'mic' ? 'wrtc-dev-menu-mic' : 'wrtc-dev-menu-cam';
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.innerHTML = '';
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      if (kind === 'mic') {
        // ── Microphone section ──
        const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
        this._appendDevSection(menu, 'Microphone', mics, this._currentMicId, (id) => this._switchMic(id));

        // ── Speaker section ──
        const speakers = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
        if (speakers.length > 0) {
          const divider = document.createElement('div');
          divider.className = 'wrtc-more-divider';
          menu.appendChild(divider);
          this._appendDevSection(menu, 'Speaker', speakers, this._currentSpeakerId, (id) => this._switchSpeaker(id));
        }
      } else {
        // ── Camera section ──
        const cams = devices.filter(d => d.kind === 'videoinput' && d.deviceId !== 'default');
        this._appendDevSection(menu, 'Camera', cams, this._currentCamId, (id) => this._switchCam(id));
      }
    } catch(_) {
      menu.innerHTML = '<div class="wrtc-dev-item" style="opacity:.5;cursor:default">Unable to list devices</div>';
    }
  }

  _appendDevSection(menu, label, devices, currentId, onSelect) {
    const heading = document.createElement('div');
    heading.style.cssText = 'padding:6px 14px 4px;font-size:11px;font-weight:600;color:#9aa0a6;text-transform:uppercase;letter-spacing:0.5px';
    heading.textContent = label;
    menu.appendChild(heading);

    if (devices.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wrtc-dev-item';
      empty.style.cssText = 'opacity:.5;cursor:default';
      empty.textContent = 'No devices found';
      menu.appendChild(empty);
      return;
    }

    devices.forEach(dev => {
      const item = document.createElement('div');
      item.className = 'wrtc-dev-item' + (dev.deviceId === currentId ? ' active' : '');
      const check = dev.deviceId === currentId
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
        : '<span style="width:16px;display:inline-block"></span>';
      item.innerHTML = `${check}<span class="wrtc-dev-item-label">${dev.label || label}</span>`;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(dev.deviceId);
        this._closeDeviceMenus();
      });
      menu.appendChild(item);
    });
  }

  async _switchMic(deviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      const newTrack = stream.getAudioTracks()[0];
      Object.values(this._peerConnections).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) sender.replaceTrack(newTrack);
      });
      const oldTrack = this._localStream?.getAudioTracks()[0];
      if (oldTrack) { this._localStream.removeTrack(oldTrack); oldTrack.stop(); }
      this._localStream?.addTrack(newTrack);
      this._currentMicId = deviceId;
      this._toast('Microphone switched');
    } catch(e) {
      this._toast('Failed to switch microphone');
      console.error('[DevSwitch] mic:', e);
    }
  }

  async _switchSpeaker(deviceId) {
    try {
      const videoEls = document.querySelectorAll('[id^="wrtc-vid-"]');
      for (const el of videoEls) {
        if (typeof el.setSinkId === 'function') await el.setSinkId(deviceId);
      }
      this._currentSpeakerId = deviceId;
      this._toast('Speaker switched');
    } catch(e) {
      this._toast('Failed to switch speaker');
      console.error('[DevSwitch] speaker:', e);
    }
  }

  async _switchCam(deviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack = stream.getVideoTracks()[0];
      Object.values(this._peerConnections).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(newTrack);
      });
      const oldTrack = this._localStream?.getVideoTracks()[0];
      if (oldTrack) { this._localStream.removeTrack(oldTrack); oldTrack.stop(); }
      this._localStream?.addTrack(newTrack);
      const localVid = document.getElementById('wrtc-local-video');
      if (localVid) localVid.srcObject = this._localStream;
      this._currentCamId = deviceId;
      this._toast('Camera switched');
    } catch(e) {
      this._toast('Failed to switch camera');
      console.error('[DevSwitch] cam:', e);
    }
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
    this._log('knock action sent  action=' + action + '  guestId=' + guestId);
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

    const _pipRight = (this._panelTab ? 356 : 16) + "px";
    if (remoteCount === 0) {
      // Alone — move local tile OUT of the hidden grid directly into stage
      // (display:none on a parent hides fixed children too, so we must reparent)
      if (localTile.parentElement !== stage) stage.appendChild(localTile);
      localTile.style.position     = "fixed";
      localTile.style.bottom       = "96px";
      localTile.style.right        = _pipRight;
      localTile.style.width        = "200px";
      localTile.style.height       = "130px";
      localTile.style.zIndex       = "33";
      localTile.style.borderRadius = "12px";
      localTile.style.boxShadow    = "0 4px 24px rgba(0,0,0,.7)";
      localTile.style.border       = "2px solid rgba(255,255,255,.1)";
      grid.style.display           = "none";
      waiting.style.display        = "flex";
    } else if (remoteCount === 1) {
      // 1-on-1: remote fills full screen, local is a small PiP overlay
      if (localTile.parentElement !== stage) stage.appendChild(localTile);
      localTile.style.position     = "fixed";
      localTile.style.bottom       = "96px";
      localTile.style.right        = _pipRight;
      localTile.style.width        = "180px";
      localTile.style.height       = "120px";
      localTile.style.zIndex       = "33";
      localTile.style.borderRadius = "12px";
      localTile.style.boxShadow    = "0 4px 24px rgba(0,0,0,.7)";
      localTile.style.border       = "2px solid rgba(255,255,255,.15)";
      grid.style.display           = "";
      waiting.style.display        = "none";
      grid.style.gridTemplateColumns = "1fr";
      grid.style.gridTemplateRows    = "1fr";
    } else {
      // 3+ people — move local tile back into the grid and reset styles
      if (localTile.parentElement !== grid) grid.prepend(localTile);
      localTile.style.cssText = "";
      grid.style.display      = "";
      waiting.style.display   = "none";
      // Make sure local tile is first in the grid
      if (grid.firstChild !== localTile) grid.prepend(localTile);

      const total = remoteCount + 1;
      let cols, rows;
      if (total === 3)      { cols = 3; rows = 1; }
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
    // Count all tiles (local + remote) — works in both P2P and SFU modes
    const totalTiles = document.querySelectorAll("#wrtc-grid .wrtc-tile").length;
    if (totalTiles < 2) return; // only one person, nothing to focus on

    this._focusTileId = tileId;
    const grid      = document.getElementById("wrtc-grid");
    const focusWrap = document.getElementById("wrtc-focus-wrap");
    const focusMain = document.getElementById("wrtc-focus-main");
    if (!grid || !focusWrap || !focusMain) return;

    // Move focused tile into main panel — strip any presenter-mode overrides
    const tile = document.getElementById(tileId);
    if (!tile) return;
    tile.classList.remove("presenter");
    tile.style.removeProperty("width");
    tile.style.removeProperty("height");
    tile.style.removeProperty("position");
    tile.style.removeProperty("top");
    tile.style.removeProperty("left");
    tile.style.removeProperty("right");
    tile.style.removeProperty("bottom");
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
        delete t.dataset.sidebarClick; // allow re-wiring on next focus entry
        grid.appendChild(t);
      });
    }

    // Restore local tile to front
    const localTile = document.getElementById("wrtc-local-tile");
    if (localTile?.parentElement === grid) grid.prepend(localTile);

    this._focusTileId       = null;
    focusWrap.style.display = "none";
    grid.style.display      = "";
    // Re-apply presentation layout if a share is still active
    if (this._presenterUserId) {
      this._setPresenter(this._presenterUserId); // someone else is sharing
    } else if (this._isSharing) {
      this._setLocalPresenter(); // local user is still sharing their screen
    } else {
      this._updateGrid();
    }
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

    // Move them all into the panel; wire a click to switch spotlight
    allOther.forEach(t => {
      // Strip any presentation-mode overrides so the tile fits the sidebar correctly
      t.classList.remove("presenter");
      t.style.removeProperty("width");
      t.style.removeProperty("height");
      t.style.removeProperty("position");
      t.style.removeProperty("top");
      t.style.removeProperty("left");
      t.style.removeProperty("right");
      t.style.removeProperty("bottom");
      focusTiles.appendChild(t);
      // Mark sidebar tiles so we can attach click handler only once
      if (!t.dataset.sidebarClick) {
        t.dataset.sidebarClick = "1";
        t.addEventListener("click", () => this._switchFocusTile(t.id));
      }
    });

    // Show all sidebar tiles — panel scrolls if more than ~4 fit
    const panelTiles = [...focusTiles.querySelectorAll(".wrtc-tile")];
    panelTiles.forEach(t => {
      t.style.display = "";
      // Re-sync avatar visibility so it matches actual cam/share state
      const av = t.querySelector(".wrtc-tile-avatar");
      if (!av) return;
      if (t.id === "wrtc-local-tile") {
        // Local tile: hide avatar if camera on OR if sharing screen (tile shows share video)
        av.classList.toggle("visible", !this._camEnabled && !this._isSharing);
      } else {
        const uid = t.id.replace("wrtc-tile-", "");
        // Presenter tile: always hide avatar — tile shows screen share video, not a blank feed
        if (uid === this._presenterUserId) {
          av.classList.remove("visible");
        } else {
          const camOn = this._camStates[uid];
          if (camOn !== undefined) av.classList.toggle("visible", !camOn);
        }
      }
    });
    if (focusMore) focusMore.style.display = "none";
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOGGER
  // ═══════════════════════════════════════════════════════════════════════
  _log(msg, data, level = "info") {
    if (!window.WRTC_DEBUG) return;
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
    this._log(`_setupWebSocket  attempt=${this._wsReconnectAttempts}  reconnect=${this._isReconnecting}`);
    this._log("Connecting WebSocket…");
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      this._log('WS opened  room=' + this.roomName + '  name=' + this._myName);
      this._log("WS connected", undefined, "ok");
      this._setStatus("ok");
      // Reset reconnect backoff on successful connection
      this._wsReconnectAttempts = 0;
      clearTimeout(this._wsReconnectTimer);
      this._wsReconnectTimer = null;
      // Tell everyone in the room our name and current camera state
      this._sendWS({ type: "name", payload: { name: this._myName } });
      if (!this._camEnabled) {
        this._sendWS({ type: "cam-state", payload: { enabled: false } });
      }
    };

    this._ws.onclose = (e) => {
      this._log(`WS closed  code=${e.code}  reason=${e.reason}  isLeaving=${this._isLeaving}`, undefined, "warn");
      this._setStatus("err");

      // Codes that mean "don't retry" — user left, was kicked, meeting ended,
      // or server rejected the connection permanently (bad token, room full, etc.)
      const _noRetry = [
        1000,  // Normal closure (user clicked leave)
        4001,  // Invalid / expired token
        4003,  // Forbidden
        4403,  // Meeting has ended (plan/time limit — inactive)
        4429,  // MAU limit reached
        4430,  // Room full
      ];
      if (this._isLeaving || _noRetry.includes(e.code)) {
        this._log(`WS closed permanently — no reconnect  code=${e.code}  isLeaving=${this._isLeaving}`);
        if (e.code === 4403) {
          sessionStorage.removeItem("wrtc_name_" + this.roomName);
          sessionStorage.removeItem("meet_session_" + this.roomName);
          sessionStorage.removeItem("wrtc_mic_" + this.roomName);
          sessionStorage.removeItem("wrtc_cam_" + this.roomName);
          sessionStorage.removeItem("wrtc_start_" + this.roomName);
          sessionStorage.removeItem("wrtc_chat_" + this.roomName);
          sessionStorage.removeItem("wrtc_hand_" + this.roomName);
          sessionStorage.removeItem("wrtc_force_mic_" + this.roomName);
          sessionStorage.removeItem("wrtc_force_cam_" + this.roomName);
          sessionStorage.removeItem("wrtc_admin_mic_" + this.roomName);
          sessionStorage.removeItem("wrtc_admin_cam_" + this.roomName);
          try { window.__wrtcEndedByHost = true; } catch(_) {}
          if (typeof this._onLeave === 'function') this._onLeave();
        }
        return;
      }

      // Reset SFU state so the fresh WS session gets new transports/producers/consumers.
      // Must happen before reconnect so _sfuInit() runs cleanly on the new connection.
      this._sfuReset();

      // Unexpected disconnect (backend restart, network blip, etc.) — reconnect
      // with exponential backoff: 1 s, 2 s, 4 s, 8 s, 16 s, then cap at 30 s.
      this._wsReconnectAttempts += 1;
      const _delay = Math.min(1000 * Math.pow(2, this._wsReconnectAttempts - 1), 30000);
      this._log(`WS reconnect scheduled  attempt=${this._wsReconnectAttempts}  delay=${_delay}ms`);
      this._log(`Connection lost — reconnecting in ${Math.round(_delay / 1000)}s…`, undefined, "warn");

      clearTimeout(this._wsReconnectTimer);
      this._wsReconnectTimer = setTimeout(() => {
        if (this._isLeaving) return;
        this._log(`WS reconnecting now  attempt=${this._wsReconnectAttempts}`);
        // reconnect=1 tells the server this is a returning user, not a fresh join,
        // so admitted guests bypass the knock queue and the host reclaims host role.
        this._isReconnecting = true;
        this._setupWebSocket();
      }, _delay);
    };

    this._ws.onerror = (e) => {
      this._log("WS error", undefined, "error");
      this._setStatus("err");
      // onclose will fire immediately after onerror — reconnect logic lives there
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
        this._myUserId        = payload.myId || null;
        this._isHost          = payload.isHost || false;
        this._hostUserId      = payload.hostId || null;
        this._settings        = payload.settings || {};
        this._ownerPlan       = payload.ownerPlan ?? null;
        this._isPublicMeeting = payload.isPublicMeeting || false;
        this._allowRecording  = payload.allowRecording !== false;
        this._log('user-list received  room=' + this.roomName + '  myId=' + this._myUserId + '  isHost=' + this._isHost);
        // Only now is the user admitted — safe to persist name for reconnect
        sessionStorage.setItem('wrtc_name_' + this.roomName, this._myName || '');
        // ── Server-authoritative forced media state ──────────────────────────
        // Apply BEFORE _buildUIAfterAdmit so the UI is built with correct lock state.
        // Server sends forcedMicOff/forcedCamOff based on base user ID — survives refresh.
        if (payload.forcedMicOff) {
          this._micLocked = true; this._hostMutedMic = true;
          this._micEnabled = false;
          this._localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
          sessionStorage.setItem('wrtc_mic_' + this.roomName, '0');
          sessionStorage.setItem('wrtc_force_mic_' + this.roomName, '1');
        } else {
          // Server says no force-lock — clear any stale sessionStorage from prior session
          sessionStorage.removeItem('wrtc_force_mic_' + this.roomName);
          this._micLocked = false;
        }
        if (payload.forcedCamOff) {
          this._camLocked = true; this._hostMutedCam = true;
          this._camEnabled = false;
          this._localStream?.getVideoTracks().forEach(t => { t.enabled = false; });
          sessionStorage.setItem('wrtc_cam_' + this.roomName, '0');
          sessionStorage.setItem('wrtc_force_cam_' + this.roomName, '1');
        } else {
          sessionStorage.removeItem('wrtc_force_cam_' + this.roomName);
          this._camLocked = false;
        }
        // Restore admin tracking sets from server (base user IDs — survives all refreshes)
        if (Array.isArray(payload.forcedMicUsers))
          this._hostForcedOffMic = new Set(payload.forcedMicUsers);
        if (Array.isArray(payload.forcedCamUsers))
          this._hostForcedOffCam = new Set(payload.forcedCamUsers);
        // Apply mute-all lock for participants — if admin did mute-all/cam-mute-all the lock
        // must survive participant refresh too (not just the host's button state).
        if (!this._isHost) {
          if (payload.allMicsMuted && !this._micLocked) {
            this._micLocked = true; this._hostMutedMic = true;
            this._micEnabled = false;
            this._localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
            sessionStorage.setItem('wrtc_mic_' + this.roomName, '0');
            sessionStorage.setItem('wrtc_force_mic_' + this.roomName, '1');
          }
          if (payload.allCamsMuted && !this._camLocked) {
            this._camLocked = true; this._hostMutedCam = true;
            this._camEnabled = false;
            this._localStream?.getVideoTracks().forEach(t => { t.enabled = false; });
            sessionStorage.setItem('wrtc_cam_' + this.roomName, '0');
            sessionStorage.setItem('wrtc_force_cam_' + this.roomName, '1');
          }
          // Restore self-mute flags so admin cannot override participant's own choice after refresh
          if (sessionStorage.getItem('wrtc_self_mic_' + this.roomName) === '1') this._selfMutedMic = true;
          if (sessionStorage.getItem('wrtc_self_cam_' + this.roomName) === '1') this._selfMutedCam = true;
        }
        // Populate cam/mic states from server so admin panel is correct immediately after refresh.
        // participantStates is keyed by base_user_id; map to session_ids via payload.users.
        if (payload.participantStates && typeof payload.participantStates === 'object') {
          payload.users.forEach(uid => {
            const base = uid.split('_')[0];
            const st = payload.participantStates[base];
            if (st) {
              if (typeof st.cam === 'boolean') this._camStates[uid] = st.cam;
              if (typeof st.mic === 'boolean') this._micStates[uid] = st.mic;
            }
          });
        }
        if (payload.meetingStartedAt) this._serverMeetingStartedAt = payload.meetingStartedAt;
        this._buildUIAfterAdmit(); // build full meeting UI now (first time only)
        this._applySettings();
        // Restore host bulk-mute button state AFTER _applySettings — it re-shows muteall/mutecams
        // unconditionally for host, so we must override it here to reflect the real muted state.
        if (this._isHost) {
          this._allMicsMuted = !!payload.allMicsMuted;
          this._allCamsMuted = !!payload.allCamsMuted;
          const muteAllBtn    = document.getElementById("wrtc-btn-muteall");
          const unmuteAllBtn  = document.getElementById("wrtc-btn-unmuteall");
          const muteCamsBtn   = document.getElementById("wrtc-btn-mutecams");
          const unmuteCamsBtn = document.getElementById("wrtc-btn-unmutecams");
          if (muteAllBtn)    muteAllBtn.style.display    = this._allMicsMuted ? "none" : "";
          if (unmuteAllBtn)  unmuteAllBtn.style.display  = this._allMicsMuted ? ""     : "none";
          if (muteCamsBtn)   muteCamsBtn.style.display   = this._allCamsMuted ? "none" : "";
          if (unmuteCamsBtn) unmuteCamsBtn.style.display = this._allCamsMuted ? ""     : "none";
        }
        // Show sub-tabs for everyone — guests need the Private tab to receive host replies
        const subtabs = document.getElementById("wrtc-chat-subtabs");
        if (subtabs) subtabs.style.display = "flex";
        // Re-announce our name and camera state — messages sent in onopen are consumed
        // by the knock-wait drain loop and never reach the main relay, so we re-send
        // them here after admission when the main message loop is active.
        this._sendWS({ type: "name", payload: { name: this._myName } });
        this._sendWS({ type: "cam-state", payload: { enabled: this._camEnabled } });
        this._sendWS({ type: "mic-state", payload: { enabled: this._micEnabled } });
        // Populate participants for users already in room (names arrive via "name" messages)
        payload.users.forEach(uid => { this._participants[uid] = this._displayName(uid); });
        this._renderParticipants();
        // Pre-create tiles for existing participants so they appear immediately in the grid
        // even if they have no camera/mic tracks (ontrack would never fire for them).
        payload.users.forEach(uid => this._ensureRemoteTile(uid));
        this._updateGrid();  // set initial solo/grid state
        // Restore raise-hand state after reconnect and re-broadcast so others see it
        if (sessionStorage.getItem('wrtc_hand_' + this.roomName) === '1') {
          this._handRaised = true;
          document.getElementById("wrtc-btn-hand")?.classList.add("active-feature");
          document.getElementById("wrtc-pip-hand")?.classList.add("raised");
          this._sendWS({ type: "raise-hand", payload: { raised: true } });
        }
        // Restore raised-hand indicators for other participants from server state
        if (Array.isArray(payload.raisedHands) && payload.raisedHands.length) {
          const raisedSet = new Set(payload.raisedHands);
          payload.users.forEach(uid => {
            const base = uid.split('_')[0];
            if (raisedSet.has(base)) {
              this._raisedHands.add(uid);
              this._updateHandUI(uid, true);
            }
          });
        }
        // Show host welcome card
        if (this._isHost) this._showMeetingReadyCard();
        // Kick off SFU if mediasoup is available.
        // sfu:rtpCapabilities always arrives before user-list, so _sfuRtpCaps is already set.
        this._sfuAvailable = payload.sfuAvailable || false;
        if (this._sfuAvailable && this._sfuRtpCaps && !this._sfuInitDone) {
          this._sfuInit().catch(e => this._log('SFU init failed: ' + e.message, undefined, 'error'));
        }
        break;

      case "join":
        // Cancel any deferred "X left" message — this user reconnected
        const _joinBase = payload.user_id.split('_')[0];
        clearTimeout(this._leaveTimers[_joinBase]);
        delete this._leaveTimers[_joinBase];
        if (payload.name) this._peerNames[payload.user_id] = payload.name;
        this._participants[payload.user_id] = this._displayName(payload.user_id);
        this._renderParticipants();
        // Clear any pending knock UI — this user was admitted (possibly by another participant)
        document.getElementById("wrtc-knock-popup-" + payload.user_id)?.remove();
        { const _ke = document.getElementById("wrtc-knock-entry-" + payload.user_id);
          if (_ke) { _ke.remove(); const _kl = document.getElementById("wrtc-knock-list"); if (_kl && !_kl.querySelectorAll(".wrtc-knock-entry").length) this._clearKnockHeader(); } }
        // Pre-create the tile immediately so participant is visible in the grid
        // even if they join with no camera/mic tracks (ontrack would never fire).
        this._ensureRemoteTile(payload.user_id);
        // Tell the new joiner our name and camera state (targeted so other existing
        // participants don't see a spurious "X joined" when we respond)
        this._sendWS({ type: "name", to: payload.user_id, payload: { name: this._myName } });
        this._sendWS({ type: "cam-state", payload: { enabled: this._camEnabled } });
        this._sendWS({ type: "mic-state", payload: { enabled: this._micEnabled } });
        // If we're presenting, re-announce so late joiner gets the layout
        if (this._isSharing) {
          setTimeout(() => this._sendWS({ type: "presenting", payload: { active: true } }), 800);
        }
        // In SFU mode the new joiner calls sfu:getProducers and subscribes to
        // our stream automatically — no P2P offer needed.
        if (!this._sfuAvailable) {
          await this._initiateOffer(payload.user_id);
        }
        break;

      case "host-changed": {
        const wasHost = this._isHost;
        this._isHost = (payload.hostId === this._myUserId);
        this._hostUserId = payload.hostId || null;
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
        this._refreshHostLabels();
        if (!wasHost && this._isHost) this._toast("You are now the host");
        break;
      }

      case "session-replaced":
        this._isLeaving = true;
        this._localStream?.getTracks().forEach(t => t.stop());
        this._shareStream?.getTracks().forEach(t => t.stop());
        this._localStream = null; this._shareStream = null;
        this.parentNode.innerHTML =
          '<div style="position:fixed;inset:0;background:#13151c;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;">' +
          '<div style="background:#1e2028;border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:40px 44px;max-width:400px;width:100%;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.6);">' +
          '<div style="width:56px;height:56px;background:rgba(251,188,4,.12);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">' +
          '<svg width="28" height="28" viewBox="0 0 24 24" fill="#fbbc04"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg></div>' +
          '<h2 style="color:#e8eaed;font-size:20px;font-weight:600;margin:0 0 10px;">Moved to another tab</h2>' +
          '<p style="color:#9aa0a6;font-size:14px;line-height:1.6;margin:0 0 28px;">You joined this meeting from another device or browser.<br>This tab is no longer active.</p>' +
          '<button onclick="window.location.href=window.location.origin" style="background:#1a73e8;color:#fff;border:none;border-radius:10px;padding:12px 28px;font-size:14px;font-weight:500;cursor:pointer;width:100%;">Go home</button>' +
          '</div></div>';
        break;

      case "plan-upgraded": {
        const _newMin   = payload.newLimitMinutes;
        const _limitTxt = _newMin == null ? "unlimited time" : `up to ${_newMin} minutes`;
        this._toast(`Plan upgraded — this meeting now allows ${_limitTxt}.`);
        break;
      }

      case "meeting-ended":
        this._isLeaving = true;
        this._localStream?.getTracks().forEach(t => t.stop());
        this._shareStream?.getTracks().forEach(t => t.stop());
        this._localStream = null;
        this._shareStream = null;
        try { localStorage.setItem("meeting_ended_" + this.roomName, "1"); } catch(_) {}
        try { window.__wrtcEndedByHost = true; } catch(_) {}
        sessionStorage.removeItem("wrtc_name_" + this.roomName);
        sessionStorage.removeItem("meet_session_" + this.roomName);
        sessionStorage.removeItem("wrtc_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_cam_" + this.roomName);
        sessionStorage.removeItem("wrtc_start_" + this.roomName);
        sessionStorage.removeItem("wrtc_chat_" + this.roomName);
        sessionStorage.removeItem("wrtc_hand_" + this.roomName);
        sessionStorage.removeItem("wrtc_force_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_force_cam_" + this.roomName);
        sessionStorage.removeItem("wrtc_admin_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_admin_cam_" + this.roomName);
        sessionStorage.removeItem("wrtc_self_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_self_cam_" + this.roomName);
        const _wasRecordingEnded = this._isRecording;
        if (this._isRecording) this._stopRecording();
        this._ws?.close();
        if (typeof this._onLeave === 'function') {
          setTimeout(() => this._onLeave('host-ended'), _wasRecordingEnded ? 1500 : 0);
        }
        break;

      case "meeting_ended_plan_limit": {
        this._isLeaving = true;
        this._localStream?.getTracks().forEach(t => t.stop());
        this._shareStream?.getTracks().forEach(t => t.stop());
        this._localStream = null;
        this._shareStream = null;
        try { localStorage.setItem("meeting_ended_" + this.roomName, "1"); } catch(_) {}
        sessionStorage.removeItem("wrtc_name_" + this.roomName);
        sessionStorage.removeItem("meet_session_" + this.roomName);
        sessionStorage.removeItem("wrtc_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_cam_" + this.roomName);
        sessionStorage.removeItem("wrtc_start_" + this.roomName);
        sessionStorage.removeItem("wrtc_chat_" + this.roomName);
        sessionStorage.removeItem("wrtc_hand_" + this.roomName);
        sessionStorage.removeItem("wrtc_force_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_force_cam_" + this.roomName);
        sessionStorage.removeItem("wrtc_admin_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_admin_cam_" + this.roomName);
        sessionStorage.removeItem("wrtc_self_mic_" + this.roomName);
        sessionStorage.removeItem("wrtc_self_cam_" + this.roomName);
        try { window.__wrtcTimeLimitReached = true; } catch(_) {}
        const _wasRecordingLimit = this._isRecording;
        if (this._isRecording) this._stopRecording();
        this._ws?.close();
        if (typeof this._onLeave === 'function') {
          const _tlRole = this._isHost ? 'timelimit-host' : 'timelimit-guest';
          setTimeout(() => this._onLeave(_tlRole), _wasRecordingLimit ? 1500 : 0);
        }
        break;
      }

      case "leave": {
        const _leaveId   = payload.user_id;
        const _leaveBase = _leaveId.split('_')[0];
        const leaveName  = this._displayName(_leaveId);
        // Delay "X left" by 3 s so brief reconnects (page refresh, screen-share
        // dialog stealing focus) don't flash a spurious "left/joined" pair in chat.
        clearTimeout(this._leaveTimers[_leaveBase]);
        this._leaveTimers[_leaveBase] = setTimeout(() => {
          delete this._leaveTimers[_leaveBase];
          this._announcedJoins.delete(_leaveBase); // allow "joined" if they return later
          this._toast(`${leaveName} left the call`);
          this._renderSystemMsg(`${leaveName} left`);
        }, 3000);
        const presenterTile = document.getElementById(`wrtc-tile-${_leaveId}`);
        if (presenterTile?.classList.contains("presenter")) {
          if (this._presenterUserId === _leaveId) this._presenterUserId = null;
          this._clearPresenter();
        }
        this._removeParticipant(_leaveId);
        this._cleanupPeer(_leaveId);
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
          const mName = (this._displayName(mFrom) || mFrom?.slice(0, 8) || '?') + this._hostTag(mFrom);
          const isMine = mFrom === this._myUserId;
          this._renderMessage(mName, mPayload.text, mPayload.ts || Date.now(), isMine, "public", false, null);
        });
        break;
      }

      case "chat": {
        const name = this._displayName(from) + this._hostTag(from);
        this._renderMessage(name, payload.text, payload.ts || Date.now(), false, "public");
        if (this._panelTab !== "chat") {
          this._unread++;
          const n = this._unread > 9 ? "9+" : this._unread;
          ["wrtc-chat-badge","wrtc-chat-badge-btn","wrtc-chat-badge-menu"].forEach(id => {
            const b = document.getElementById(id);
            if (b) { b.textContent = n; b.classList.add("show"); }
          });
        }
        if (this._panelTab !== "chat") {
          this._toast(`${name}: ${payload.text.slice(0, 40)}${payload.text.length > 40 ? "…" : ""}`);
        }
        break;
      }

      case "chat-private": {
        const name = this._displayName(from) + this._hostTag(from);
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
        const _nameBase = from.split('_')[0];
        // Cancel any pending "X left" — this user is still present (name re-announce)
        clearTimeout(this._leaveTimers[_nameBase]);
        delete this._leaveTimers[_nameBase];
        // Show "joined" only the first time we announce this base user.
        // _announcedJoins is set when we first show the message and cleared only
        // after the leave timer fires (genuine leave), so reconnects stay silent.
        const _isNewPeer = !this._announcedJoins.has(_nameBase);
        this._peerNames[from] = payload.name;
        const tile = document.getElementById(`wrtc-tile-${from}`);
        if (tile) {
          const lbl = tile.querySelector(".wrtc-tile-label");
          if (lbl) lbl.textContent = payload.name + this._hostTag(from);
          const av = document.querySelector(`#wrtc-avatar-${from} span`);
          if (av) av.textContent = payload.name.slice(0, 2).toUpperCase();
        }
        this._addParticipant(from, payload.name);
        if (_isNewPeer) {
          this._announcedJoins.add(_nameBase);
          this._renderSystemMsg(`${payload.name} joined`);
        }
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

      case "reaction": {
        this._showReactionOnTile(from, payload.emoji);
        break;
      }

      case "presenting": {
        // Ignore echo of own presenting signal — local state is managed directly
        // by _setLocalPresenter() / _clearPresenter() in _toggleScreenShare().
        // Without this guard the echo triggers _waitForPresenterVideo(myId) which
        // polls for a tile that never exists, eventually calling _setPresenter()
        // and hiding all tiles including the local camera tile.
        if (from === this._myUserId) break;
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
          // Only clear presenter layout if it was actually applied (i.e. viewer had no pin)
          if (!this._focusTileId) this._clearPresenter();
          this._toast(`${name} stopped presenting`);
        }
        break;
      }

      // ── SFU: server sends router RTP capabilities on join ────────────────
      case "sfu:rtpCapabilities":
        this._sfuRtpCaps = payload.rtpCapabilities;
        this._log('SFU rtpCapabilities received');
        // _sfuInit() is triggered after user-list arrives (sfuAvailable flag)
        break;

      // ── SFU: transport creation responses ────────────────────────────────
      case "sfu:transportCreated": {
        const direction = payload.direction;
        const _r = this._sfuResolvers[`transportCreated:${direction}`];
        if (_r) { _r.resolve(payload); delete this._sfuResolvers[`transportCreated:${direction}`]; }
        break;
      }

      // ── SFU: transport DTLS connect ack ──────────────────────────────────
      case "sfu:transportConnected": {
        const _ck = `transportConnected:${payload.transportId}`;
        const _r  = this._sfuResolvers[_ck];
        if (_r) { _r.resolve(); delete this._sfuResolvers[_ck]; }
        break;
      }

      // ── SFU: our produce was accepted — give producerId to mediasoup-client
      case "sfu:produced":
        if (this._sfuProduceCallback) {
          this._sfuProduceCallback.callback({ id: payload.producerId });
          this._sfuProduceCallback = null;
        }
        break;

      // ── SFU: a remote peer started producing — subscribe to their stream
      case "sfu:newProducer": {
        const { producerId: _np_pid, peerId: _np_peer, kind: _np_kind } = payload;
        this._log(`SFU new producer  peer=${_np_peer}  kind=${_np_kind}`);
        if (this._sfuRecvTransport && this._sfuDevice) {
          this._sfuConsumeProducer(_np_pid, _np_peer, _np_kind).catch(e =>
            this._log('SFU consume failed: ' + e.message, undefined, 'warn')
          );
        }
        break;
      }

      // ── SFU: server created consumer — wire track to video element ────────
      case "sfu:consumed": {
        const { consumerId: _c_id, producerId: _c_pid, kind: _c_kind,
                rtpParameters: _c_rtp, producerPeerId: _c_peer } = payload;
        try {
          const _consumer = await this._sfuRecvTransport.consume({
            id: _c_id, producerId: _c_pid, kind: _c_kind, rtpParameters: _c_rtp,
          });
          this._sfuConsumers[_c_id] = { consumer: _consumer, peerId: _c_peer, kind: _c_kind };

          // Build (or extend) a per-peer MediaStream and attach to video element
          if (!this._sfuPeerStreams[_c_peer]) this._sfuPeerStreams[_c_peer] = new MediaStream();
          const _ps = this._sfuPeerStreams[_c_peer];
          _ps.addTrack(_consumer.track);

          const _vel = document.getElementById(`wrtc-vid-${_c_peer}`);
          if (_vel) {
            if (_vel.srcObject !== _ps) _vel.srcObject = _ps;
            _vel.play().catch(() => {});
          }

          if (_c_kind === 'video') {
            this._addRemoteVideo(_c_peer, _ps);
          } else {
            this._setupAudioAnalyser(_c_peer, _ps);
          }

          _consumer.on('transportclose', () => { delete this._sfuConsumers[_c_id]; });
          _consumer.on('producerclose',  () => { delete this._sfuConsumers[_c_id]; });

          // Resume — server starts forwarding RTP only after this
          this._sendWS({ type: 'sfu:resumeConsumer', payload: { consumerId: _c_id } });
        } catch (e) {
          this._log('SFU consume error: ' + e.message, undefined, 'error');
        }
        break;
      }

      case "sfu:consumerResumed":
        this._log('SFU consumer resumed  id=' + payload.consumerId);
        break;

      // ── SFU: existing producers list on join — subscribe to each ──────────
      case "sfu:producers": {
        const _prods = payload.producers || [];
        this._log(`SFU existing producers: ${_prods.length}`);
        for (const { producerId: _pp, peerId: _ppr, kind: _pk } of _prods) {
          if (this._sfuRecvTransport && this._sfuDevice) {
            this._sfuConsumeProducer(_pp, _ppr, _pk).catch(e =>
              this._log('SFU consume failed: ' + e.message, undefined, 'warn')
            );
          }
        }
        break;
      }

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
        if (from === this._myUserId) break; // ignore own echo
        this._camStates[from] = payload.enabled;
        // If participant turned cam back on themselves, clear admin force-off tracking
        if (payload.enabled) {
          this._hostForcedOffCam.delete(from.split('_')[0]);
        }
        const avatarEl = document.getElementById(`wrtc-avatar-${from}`);
        if (avatarEl) avatarEl.classList.toggle("visible", !payload.enabled);
        if (this._isHost && this._panelTab === "people") this._renderParticipants();
        break;
      }

      case "mic-state": {
        if (from === this._myUserId) break; // ignore own echo
        this._micStates[from] = payload.enabled;
        // If participant turned mic back on themselves, clear admin force-off tracking
        if (payload.enabled) {
          this._hostForcedOffMic.delete(from.split('_')[0]);
        }
        if (this._isHost && this._panelTab === "people") this._renderParticipants();
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
        // Always apply the lock — even if mic is already off (participant self-muted).
        // Without this, a self-muted participant could unmute during a host mute-all.
        this._hostMutedMic = true;
        this._micLocked    = true;
        if (!this._micEnabled) break; // already off — lock set, no UI change needed
        this._micEnabled = false;
        this._localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
        document.getElementById("wrtc-btn-mic")?.classList.add("muted", "admin-locked");
        document.getElementById("wrtc-btn-mic")?.setAttribute("title", "Disabled by host");
        if (document.getElementById("wrtc-ico-mic"))     document.getElementById("wrtc-ico-mic").style.display     = "none";
        if (document.getElementById("wrtc-ico-mic-off")) document.getElementById("wrtc-ico-mic-off").style.display = "";
        this._syncLocalMicTile();
        this._toast("Your microphone was muted by the host");
        break;

      case "unmute-all":
        if (!this._hostMutedMic) break; // host didn't lock me — nothing to release
        this._hostMutedMic = false;
        this._micLocked    = false; // release lock
        // Don't turn mic on if participant self-muted — that was their own choice
        if (this._selfMutedMic || this._micEnabled) break;
        this._micEnabled = true;
        this._localStream?.getAudioTracks().forEach(t => { t.enabled = true; });
        document.getElementById("wrtc-btn-mic")?.classList.remove("muted", "admin-locked");
        document.getElementById("wrtc-btn-mic")?.removeAttribute("title");
        if (document.getElementById("wrtc-ico-mic"))     document.getElementById("wrtc-ico-mic").style.display     = "";
        if (document.getElementById("wrtc-ico-mic-off")) document.getElementById("wrtc-ico-mic-off").style.display = "none";
        this._syncLocalMicTile();
        this._toast("Your microphone was unmuted by the host");
        break;

      case "cam-mute-all":
        // Always apply the lock — even if cam is already off (participant self-turned off).
        this._hostMutedCam = true;
        this._camLocked    = true;
        if (!this._camEnabled) break; // already off — lock set, no UI change needed
        this._camEnabled = false;
        this._localStream?.getVideoTracks().forEach(t => { t.enabled = false; });
        document.getElementById("wrtc-btn-cam")?.classList.add("muted", "admin-locked");
        document.getElementById("wrtc-btn-cam")?.setAttribute("title", "Disabled by host");
        if (document.getElementById("wrtc-ico-cam"))     document.getElementById("wrtc-ico-cam").style.display     = "none";
        if (document.getElementById("wrtc-ico-cam-off")) document.getElementById("wrtc-ico-cam-off").style.display = "";
        if (document.getElementById("wrtc-local-video")) document.getElementById("wrtc-local-video").style.display = "none";
        if (document.getElementById("wrtc-pip-avatar"))  document.getElementById("wrtc-pip-avatar").style.display  = "flex";
        this._toast("Your camera was disabled by the host");
        this._sendWS({ type: "cam-state", payload: { enabled: false } });
        break;

      case "cam-unmute-all":
        if (!this._hostMutedCam) break; // host didn't lock me — nothing to release
        this._hostMutedCam = false;
        this._camLocked    = false; // release lock
        // Don't turn cam on if participant self-turned it off — that was their own choice
        if (this._selfMutedCam || this._camEnabled) break;
        this._camEnabled = true;
        this._localStream?.getVideoTracks().forEach(t => { t.enabled = true; });
        document.getElementById("wrtc-btn-cam")?.classList.remove("muted", "admin-locked");
        document.getElementById("wrtc-btn-cam")?.removeAttribute("title");
        if (document.getElementById("wrtc-ico-cam"))     document.getElementById("wrtc-ico-cam").style.display     = "";
        if (document.getElementById("wrtc-ico-cam-off")) document.getElementById("wrtc-ico-cam-off").style.display = "none";
        if (document.getElementById("wrtc-local-video")) document.getElementById("wrtc-local-video").style.display = "block";
        if (document.getElementById("wrtc-pip-avatar"))  document.getElementById("wrtc-pip-avatar").style.display  = "none";
        this._toast("Your camera was enabled by the host");
        this._sendWS({ type: "cam-state", payload: { enabled: true } });
        break;

      // ── Per-user force mute/unmute from host ──────────────────────────────────
      case "you-are-force-muted":
        this._micLocked    = true;
        this._hostMutedMic = true;
        this._micEnabled   = false;
        this._localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
        document.getElementById("wrtc-btn-mic")?.classList.add("muted", "admin-locked");
        document.getElementById("wrtc-btn-mic")?.setAttribute("title", "Disabled by host");
        if (document.getElementById("wrtc-ico-mic"))     document.getElementById("wrtc-ico-mic").style.display     = "none";
        if (document.getElementById("wrtc-ico-mic-off")) document.getElementById("wrtc-ico-mic-off").style.display = "";
        this._syncLocalMicTile();
        this._toast("Your microphone was disabled by the host");
        sessionStorage.setItem('wrtc_mic_' + this.roomName, '0');
        sessionStorage.setItem('wrtc_force_mic_' + this.roomName, '1');
        this._sendWS({ type: "mic-state", payload: { enabled: false } });
        break;

      case "you-are-force-unmuted":
        // Block if participant self-muted — admin cannot override their choice.
        if (this._selfMutedMic) break;
        this._micLocked    = false;
        this._hostMutedMic = false;
        this._micEnabled   = true;
        this._localStream?.getAudioTracks().forEach(t => { t.enabled = true; });
        document.getElementById("wrtc-btn-mic")?.classList.remove("muted", "admin-locked");
        document.getElementById("wrtc-btn-mic")?.removeAttribute("title");
        if (document.getElementById("wrtc-ico-mic"))     document.getElementById("wrtc-ico-mic").style.display     = "";
        if (document.getElementById("wrtc-ico-mic-off")) document.getElementById("wrtc-ico-mic-off").style.display = "none";
        this._syncLocalMicTile();
        this._toast("Your microphone was enabled by the host");
        this._sendWS({ type: "mic-state", payload: { enabled: true } });
        sessionStorage.removeItem('wrtc_force_mic_' + this.roomName);
        break;

      case "you-are-force-cam-off":
        this._camLocked    = true;
        this._hostMutedCam = true;
        this._camEnabled   = false;
        this._localStream?.getVideoTracks().forEach(t => { t.enabled = false; });
        document.getElementById("wrtc-btn-cam")?.classList.add("muted", "admin-locked");
        document.getElementById("wrtc-btn-cam")?.setAttribute("title", "Disabled by host");
        if (document.getElementById("wrtc-ico-cam"))     document.getElementById("wrtc-ico-cam").style.display     = "none";
        if (document.getElementById("wrtc-ico-cam-off")) document.getElementById("wrtc-ico-cam-off").style.display = "";
        if (document.getElementById("wrtc-local-video")) document.getElementById("wrtc-local-video").style.display = "none";
        if (document.getElementById("wrtc-pip-avatar"))  document.getElementById("wrtc-pip-avatar").style.display  = "flex";
        this._toast("Your camera was disabled by the host");
        sessionStorage.setItem('wrtc_cam_' + this.roomName, '0');
        sessionStorage.setItem('wrtc_force_cam_' + this.roomName, '1');
        // Broadcast so other participants show avatar immediately
        this._sendWS({ type: "cam-state", payload: { enabled: false } });
        break;

      case "you-are-force-cam-on":
        // Block if participant self-muted — admin cannot override their choice.
        if (this._selfMutedCam) break;
        this._camLocked    = false;
        this._hostMutedCam = false;
        this._camEnabled   = true;
        this._localStream?.getVideoTracks().forEach(t => { t.enabled = true; });
        document.getElementById("wrtc-btn-cam")?.classList.remove("muted", "admin-locked");
        document.getElementById("wrtc-btn-cam")?.removeAttribute("title");
        if (document.getElementById("wrtc-ico-cam"))     document.getElementById("wrtc-ico-cam").style.display     = "";
        if (document.getElementById("wrtc-ico-cam-off")) document.getElementById("wrtc-ico-cam-off").style.display = "none";
        if (document.getElementById("wrtc-local-video")) document.getElementById("wrtc-local-video").style.display = "block";
        if (document.getElementById("wrtc-pip-avatar"))  document.getElementById("wrtc-pip-avatar").style.display  = "none";
        this._toast("Your camera was enabled by the host");
        sessionStorage.removeItem('wrtc_force_cam_' + this.roomName);
        // Broadcast so other participants hide avatar and show video
        this._sendWS({ type: "cam-state", payload: { enabled: true } });
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
        sessionStorage.removeItem('wrtc_hand_' + this.roomName);
        sessionStorage.removeItem('wrtc_force_mic_' + this.roomName);
        sessionStorage.removeItem('wrtc_force_cam_' + this.roomName);
        sessionStorage.removeItem('wrtc_admin_mic_' + this.roomName);
        sessionStorage.removeItem('wrtc_admin_cam_' + this.roomName);
        sessionStorage.removeItem('wrtc_self_mic_' + this.roomName);
        sessionStorage.removeItem('wrtc_self_cam_' + this.roomName);
        try { window.__wrtcEndedByHost = true; } catch(_) {}
        if (typeof this._onLeave === 'function') this._onLeave();
        break;

      // ── Knock-to-join: guest is waiting for host approval ──────────────────
      case "knock-waiting": {
        this._log('knock-waiting received — host_present=' + payload.host_present);
        const el = document.getElementById("wrtc-approval-text");
        if (el) el.textContent = payload.host_present
          ? "Waiting for host to admit you…"
          : "Waiting for host to join the meeting…";
        break;
      }

      case "knock-denied": {
        this._ws?.close();
        if (typeof this._onLeave === 'function') this._onLeave();
        break;
      }

      // ── Knock-to-join: host sees approval request ──────────────────────────
      case "knock-request": {
        const { guestId, name: knockName } = payload;
        this._log('knock-request received  guestId=' + guestId + '  name=' + knockName);
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
    // In SFU mode replaceTrack() on the producer is enough — no SDP renegotiation needed.
    if (this._sfuAvailable) return;
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
    // In SFU mode close all consumers for this peer
    if (this._sfuAvailable) this._sfuCleanupConsumersForPeer(userId);
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
    const _lt = document.getElementById(leavingTileId);
    if (_lt) {
      _lt.classList.add("wrtc-tile-leaving");
      const _doRemove = () => {
        if (_lt.isConnected) _lt.remove();
        this._updateGrid();
      };
      _lt.addEventListener("animationend", _doRemove, { once: true });
      // Fallback: if animationend never fires (reduced-motion, hidden tab, etc.) run after 600ms
      setTimeout(_doRemove, 600);
    } else {
      this._updateGrid();
    }
    // Remove this user's thumb from the presentation strip (if active).
    document.querySelectorAll(`#wrtc-thumbs .wrtc-thumb-tile[data-user-id="${userId}"]`)
      .forEach(t => t.remove());
    this._updateUserCount(Object.keys(this._peerConnections).length + 1);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════
  _sendWS(msg) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._log('sendWS  type=' + msg.type);
      this._ws.send(JSON.stringify(msg));
    } else {
      this._log('sendWS DROPPED  type=' + msg.type + '  wsState=' + this._ws?.readyState, undefined, "warn");
    }
  }

  // Creates the tile DOM for a remote participant if it doesn't exist yet.
  // Avatar is shown by default — it is hidden only when a live video track arrives
  // or when cam-state:true is received. This ensures participants with no tracks
  // (camera permanently denied) are always visible as an avatar tile.
  // Safe to call multiple times — idempotent.
  _ensureRemoteTile(userId) {
    // Skip our own stale session (race: old WS not yet cleaned up when new one arrives).
    // User IDs are "<base-uuid>_<8-char-suffix>"; same base = same physical user.
    if (this._myUserId) {
      const myBase = this._myUserId.split('_')[0];
      if (userId.split('_')[0] === myBase) return;
    }
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
    label.textContent = this._displayName(userId) + this._hostTag(userId);

    const badge = document.createElement("div");
    badge.className = "wrtc-presenter-badge";
    badge.textContent = "Presenting";

    const hand = document.createElement("div");
    hand.className = "wrtc-tile-hand";
    hand.id        = `wrtc-hand-${userId}`;
    hand.textContent = "✋";
    if (this._raisedHands.has(userId)) hand.classList.add("raised");

    // Pin overlay — appears on hover, click pins this participant to the main spotlight
    const pinOverlay = document.createElement("div");
    pinOverlay.className = "wrtc-tile-pin";
    const pinBtn = document.createElement("div");
    pinBtn.className = "wrtc-tile-pin-btn";
    pinBtn.title = "Spotlight this participant";
    pinBtn.innerHTML =
      `<svg width="22" height="22" viewBox="0 0 24 24" fill="white">` +
      `<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._focusTileId === tile.id) return;
      if (this._focusTileId) { this._switchFocusTile(tile.id); return; }
      // If presenter layout is active, restore tiles first then enter focus
      if (document.getElementById("wrtc-stage")?.classList.contains("presenting")) {
        this._clearPresenter();
      }
      this._enterFocusMode(tile.id);
    });
    pinOverlay.appendChild(pinBtn);

    const micInd = document.createElement("div");
    micInd.className = "wrtc-tile-mic";
    micInd.id = `wrtc-mic-ind-${userId}`;
    micInd.innerHTML =
      `<div class="wrtc-tile-mic-ring" id="wrtc-mic-ring-${userId}"></div>` +
      `<svg class="wrtc-mic-svg-on" width="13" height="13" viewBox="0 0 24 24" fill="white">` +
      `<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>`;

    // Signal bars
    const signal = document.createElement("div");
    signal.className = "wrtc-signal";
    signal.id = `wrtc-signal-${userId}`;
    signal.innerHTML = `<div class="wrtc-signal-bar"></div><div class="wrtc-signal-bar"></div><div class="wrtc-signal-bar"></div>`;

    tile.append(video, avatarWrap, badge, pinOverlay, micInd, label, hand, signal);
    grid.appendChild(tile);
    this._updateGrid();
    // Particle burst
    setTimeout(() => this._particleBurst(tile), 80);
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
      // Guard against stale events: after _sfuReset() closes old consumers, their tracks
      // fire async mute events that can arrive after the new stream is already wired up.
      // Reject any event whose track is no longer part of the current peer stream.
      stream.getVideoTracks().forEach(track => {
        track.addEventListener("mute", () => {
          const cur = this._sfuPeerStreams[userId];
          if (cur && !cur.getTracks().includes(track)) return;
          avatarWrap.classList.add("visible");
        });
        track.addEventListener("unmute", () => {
          const cur = this._sfuPeerStreams[userId];
          if (cur && !cur.getTracks().includes(track)) return;
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

  /** Returns " (Host)" if the given userId is the current room host, else "". */
  _hostTag(userId) {
    if (userId === "local") return this._isHost ? " (Host)" : "";
    return (this._hostUserId && userId === this._hostUserId) ? " (Host)" : "";
  }

  /** Re-stamps all visible tile labels with the current host tag after a host change. */
  _refreshHostLabels() {
    // Local tile
    const pipLbl = document.getElementById("wrtc-pip-label");
    if (pipLbl) pipLbl.textContent = (this._myName || "You") + this._hostTag("local");
    // Remote tiles
    Object.keys(this._participants).forEach(uid => {
      const lbl = document.querySelector(`#wrtc-tile-${uid} .wrtc-tile-label`);
      if (lbl) lbl.textContent = this._displayName(uid) + this._hostTag(uid);
    });
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
    // Deduplicate by base user ID (strip session suffix) — keep first occurrence
    const seen = new Set();
    const unique = participants.filter(([uid]) => {
      const base = uid.includes("_") ? uid.split("_").slice(0, -1).join("_") : uid;
      if (seen.has(base)) return false;
      seen.add(base);
      return true;
    });

    let selectedUid = unique.length > 0 ? unique[0][0] : null;

    const overlay = document.createElement("div");
    overlay.id = "wrtc-host-leave-modal";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.65);" +
      "display:flex;align-items:center;justify-content:center;font-family:sans-serif;padding:16px;";

    const itemsHtml = unique.map(([uid, name], i) => {
      const initials = (name || "G").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
      const isFirst = i === 0;
      return '<div data-uid="' + uid + '" class="wrtc-th-item" style="display:flex;align-items:center;gap:10px;' +
        'padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:4px;' +
        'background:' + (isFirst ? "rgba(26,115,232,.18)" : "transparent") + ';' +
        'border:1.5px solid ' + (isFirst ? "#1a73e8" : "transparent") + ';">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:#1a73e8;display:flex;align-items:center;' +
        'justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">' + initials + '</div>' +
        '<span style="color:#e8eaed;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
        (name || "Guest") + '</span>' +
        (isFirst ? '<span style="margin-left:auto;font-size:11px;color:#1a73e8;font-weight:600;">Selected</span>' : '') +
        '</div>';
    }).join("");

    overlay.innerHTML =
      '<div style="background:#2d2e31;border-radius:16px;padding:28px;max-width:380px;width:100%;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.6);">' +
      '<h3 style="color:#e8eaed;font-size:18px;font-weight:600;margin:0 0 6px;">Leave meeting</h3>' +
      '<p style="color:#9aa0a6;font-size:13px;margin:0 0 20px;">You are the host. Choose what happens when you leave.</p>' +
      '<div style="color:#9aa0a6;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Transfer host to</div>' +
      '<div id="wrtc-th-list" style="background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.1);' +
      'border-radius:10px;padding:6px;margin-bottom:20px;max-height:180px;overflow-y:auto;">' +
      itemsHtml + '</div>' +
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

    // Selection logic for custom list
    overlay.querySelectorAll(".wrtc-th-item").forEach(item => {
      item.addEventListener("click", () => {
        selectedUid = item.dataset.uid;
        overlay.querySelectorAll(".wrtc-th-item").forEach(el => {
          const isSel = el.dataset.uid === selectedUid;
          el.style.background = isSel ? "rgba(26,115,232,.18)" : "transparent";
          el.style.border = "1.5px solid " + (isSel ? "#1a73e8" : "transparent");
          const badge = el.querySelector("span:last-child");
          if (badge && badge !== el.querySelector("span:nth-child(2)")) badge.remove();
          if (isSel) {
            const b = document.createElement("span");
            b.style.cssText = "margin-left:auto;font-size:11px;color:#1a73e8;font-weight:600;";
            b.textContent = "Selected";
            el.appendChild(b);
          }
        });
      });
    });

    document.getElementById("wrtc-transfer-btn").addEventListener("click", () => {
      if (selectedUid) this._sendWS({ type: "transfer-host", payload: { userId: selectedUid } });
      overlay.remove();
      this._doLeave();
    });
    document.getElementById("wrtc-end-meeting-btn").addEventListener("click", () => {
      this._sendWS({ type: "end-meeting", payload: {} });
      overlay.remove();
      try { window.__wrtcEndedByHost = true; } catch(_) {}
      this._doLeave();
    });
    document.getElementById("wrtc-cancel-leave-btn").addEventListener("click", () => overlay.remove());
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SFU — mediasoup-client implementation (marker kept for grep below)
  // ═══════════════════════════════════════════════════════════════════════

  // Returns the video track that should be sent to peers right now.
  // Priority: screen share > raw camera.
  _activeVideoTrack() {
    if (this._isSharing && this._shareStream) {
      return this._shareStream.getVideoTracks()[0] ?? null;
    }
    return this._localStream?.getVideoTracks()[0] ?? null;
  }

  // Returns the stream that should be shown in the local video preview.
  _activeVideoStream() {
    return this._localStream;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SFU — mediasoup-client implementation
  // ═══════════════════════════════════════════════════════════════════════

  /** Lazy-load mediasoup-client from CDN (same pattern as MediaPipe). */
  _loadMediasoupClient() {
    return new Promise((resolve, reject) => {
      if (window.mediasoupClient) { resolve(); return; }
      const s = document.createElement('script');
      s.src = `${this._httpBase}/public/js/mediasoup-client.min.js`;
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load mediasoup-client'));
      document.head.appendChild(s);
    });
  }

  /**
   * Tear down all mediasoup-client objects so _sfuInit() can run cleanly on
   * the next WebSocket reconnect.  Called from onclose before rescheduling.
   */
  _sfuReset() {
    try { this._sfuSendTransport?.close(); } catch (_) {}
    try { this._sfuRecvTransport?.close(); } catch (_) {}
    try { this._sfuAudioProducer?.close(); } catch (_) {}
    try { this._sfuVideoProducer?.close(); } catch (_) {}
    for (const { consumer } of Object.values(this._sfuConsumers)) {
      try { consumer.close(); } catch (_) {}
    }
    this._sfuSendTransport   = null;
    this._sfuRecvTransport   = null;
    this._sfuAudioProducer   = null;
    this._sfuVideoProducer   = null;
    this._sfuConsumers       = {};
    this._sfuPeerStreams      = {};
    this._sfuResolvers       = {};
    this._sfuProduceCallback = null;
    this._sfuDevice          = null;
    this._sfuRtpCaps         = null;
    this._sfuAvailable       = false;
    this._sfuInitDone        = false;  // ← critical: allows _sfuInit() to run again
    this._log('SFU state reset for reconnect');
  }

  /**
   * Full SFU initialisation:
   *  1. Load mediasoup-client Device with server RTP capabilities
   *  2. Create send + recv WebRTC transports
   *  3. Produce local audio + video
   *  4. Fetch existing producers and subscribe to them
   */
  async _sfuInit() {
    if (this._sfuInitDone) return;
    this._sfuInitDone = true;

    try {
      // 1. Load library + create Device
      await this._loadMediasoupClient();
      this._sfuDevice = new window.mediasoupClient.Device();
      await this._sfuDevice.load({ routerRtpCapabilities: this._sfuRtpCaps });
      this._log('SFU device loaded');

      // 2a. Create send transport
      this._sendWS({ type: 'sfu:createTransport', payload: { direction: 'send' } });
      const sendParams = await this._sfuWaitFor('transportCreated:send');
      this._sfuSendTransport = this._sfuDevice.createSendTransport({
        id:             sendParams.transportId,
        iceParameters:  sendParams.iceParameters,
        iceCandidates:  sendParams.iceCandidates,
        dtlsParameters: sendParams.dtlsParameters,
      });

      // Wire send transport events
      this._sfuSendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        this._sfuResolvers[`transportConnected:${this._sfuSendTransport.id}`] = { resolve: callback, reject: errback };
        this._sendWS({ type: 'sfu:connectTransport', payload: { transportId: this._sfuSendTransport.id, dtlsParameters } });
      });
      this._sfuSendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        this._sfuProduceCallback = { callback, errback };
        this._sendWS({ type: 'sfu:produce', payload: { transportId: this._sfuSendTransport.id, kind, rtpParameters, appData } });
      });

      // 2b. Create recv transport
      this._sendWS({ type: 'sfu:createTransport', payload: { direction: 'recv' } });
      const recvParams = await this._sfuWaitFor('transportCreated:recv');
      this._sfuRecvTransport = this._sfuDevice.createRecvTransport({
        id:             recvParams.transportId,
        iceParameters:  recvParams.iceParameters,
        iceCandidates:  recvParams.iceCandidates,
        dtlsParameters: recvParams.dtlsParameters,
      });

      // Wire recv transport events
      this._sfuRecvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        this._sfuResolvers[`transportConnected:${this._sfuRecvTransport.id}`] = { resolve: callback, reject: errback };
        this._sendWS({ type: 'sfu:connectTransport', payload: { transportId: this._sfuRecvTransport.id, dtlsParameters } });
      });

      this._log('SFU transports created');

      // 3. Produce local audio + video through the send transport
      await this._sfuProduce();

      // 4. Fetch existing producers (people already in the room) and subscribe
      this._sendWS({ type: 'sfu:getProducers' });

    } catch (e) {
      this._sfuInitDone = false; // allow retry on next reconnect
      this._log('SFU init failed: ' + e.message, undefined, 'error');
      throw e;
    }
  }

  /** Produce local audio and video tracks through the SFU send transport. */
  async _sfuProduce() {
    const audioTrack = this._localStream?.getAudioTracks()[0] ?? null;
    const videoTrack = this._activeVideoTrack();

    if (audioTrack) {
      this._sfuAudioProducer = await this._sfuSendTransport.produce({
        track: audioTrack,
        codecOptions: { opusStereo: false, opusDtx: true },
        appData: { kind: 'audio' },
      });
      // Honour current mic mute state
      if (!this._micEnabled) this._sfuAudioProducer.pause();
      this._log('SFU audio producer ready  id=' + this._sfuAudioProducer.id);
    }

    if (videoTrack) {
      this._sfuVideoProducer = await this._sfuSendTransport.produce({
        track: videoTrack,
        encodings: [
          { maxBitrate: 100000 },
          { maxBitrate: 300000 },
          { maxBitrate: 900000 },
        ],
        codecOptions: { videoGoogleStartBitrate: 1000 },
        appData: { kind: 'video' },
      });
      // Honour current cam mute state
      if (!this._camEnabled) this._sfuVideoProducer.pause();
      this._log('SFU video producer ready  id=' + this._sfuVideoProducer.id);
    }
  }

  /**
   * Send sfu:consume for a remote producer.
   * The server responds with sfu:consumed which wires the track to the UI.
   */
  async _sfuConsumeProducer(producerId, peerId, kind) {
    if (!this._sfuDevice || !this._sfuRecvTransport) return;
    // canConsume is a server-side check (router.canConsume) — client just sends the request
    this._sendWS({
      type: 'sfu:consume',
      payload: {
        producerId,
        transportId: this._sfuRecvTransport.id,
        rtpCapabilities: this._sfuDevice.rtpCapabilities,
      },
    });
    // Response arrives as sfu:consumed and is handled in _handleMessages
  }

  /**
   * Promise that resolves when a specific SFU response key arrives.
   * Used to bridge the async request/response pattern over WebSocket.
   */
  _sfuWaitFor(key, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this._sfuResolvers[key];
        reject(new Error('SFU timeout waiting for ' + key));
      }, timeout);
      this._sfuResolvers[key] = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  /** Close and remove all SFU consumers belonging to a peer that left. */
  _sfuCleanupConsumersForPeer(peerId) {
    for (const [consumerId, entry] of Object.entries(this._sfuConsumers)) {
      if (entry.peerId === peerId) {
        try { entry.consumer.close(); } catch (_) {}
        delete this._sfuConsumers[consumerId];
      }
    }
    delete this._sfuPeerStreams[peerId];
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
    sessionStorage.removeItem('wrtc_mic_' + this.roomName);
    sessionStorage.removeItem('wrtc_cam_' + this.roomName);
    sessionStorage.removeItem('wrtc_start_' + this.roomName);
    sessionStorage.removeItem('wrtc_chat_' + this.roomName);
    sessionStorage.removeItem('wrtc_hand_' + this.roomName);
    sessionStorage.removeItem('wrtc_force_mic_' + this.roomName);
    sessionStorage.removeItem('wrtc_force_cam_' + this.roomName);
    sessionStorage.removeItem('wrtc_admin_mic_' + this.roomName);
    sessionStorage.removeItem('wrtc_admin_cam_' + this.roomName);
    sessionStorage.removeItem('wrtc_self_mic_' + this.roomName);
    sessionStorage.removeItem('wrtc_self_cam_' + this.roomName);
    sessionStorage.removeItem('wrtc_ready_dismissed_' + this.roomName);
    this._sendWS({ type: "leave", payload: {} });
    // Close SFU producers and transports before disconnecting
    try { this._sfuVideoProducer?.close(); } catch (_) {}
    try { this._sfuAudioProducer?.close(); } catch (_) {}
    try { this._sfuSendTransport?.close(); } catch (_) {}
    try { this._sfuRecvTransport?.close(); } catch (_) {}
    Object.keys(this._peerConnections).forEach(id => this._cleanupPeer(id));
    this._ws?.close();
    this._localStream?.getTracks().forEach(t => t.stop());
    this._shareStream?.getTracks().forEach(t => t.stop());
    if (this._isRecording) this._stopRecording();
    clearInterval(this._clockTimer);
    clearInterval(this._qualityInterval);
    if (this._speakerRafId) { cancelAnimationFrame(this._speakerRafId); this._speakerRafId = null; }
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
