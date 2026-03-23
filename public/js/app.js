// ═══════════════════════════════════════════════════════════════════════════
// WebRTCMeetingAPI — embeddable WebRTC meeting SDK
// ═══════════════════════════════════════════════════════════════════════════
class WebRTCMeetingAPI {

  constructor({ serverUrl, roomName, token = "", parentNode, onLeave = null }) {
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

    this.roomName   = roomName;
    this.token      = token;
    this.parentNode = parentNode;
    this._onLeave   = onLeave;

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
    this._myUserId = null;
    this._isHost   = false;

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
    // Public meeting tokens (RS256) don't belong to any project — skip embed-check
    try {
      const payload = JSON.parse(atob(this.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.type === 'public_host' || payload.type === 'public_guest') {
        this._buildLobby();
        return;
      }
    } catch (_) { /* not a parseable JWT — fall through to embed-check */ }

    fetch(this._httpBase + '/api/v1/projects/embed-check?token=' + encodeURIComponent(this.token))
      .then(res => {
        console.log('[WRTC] embed-check status:', res.status, res.ok);
        if (!res.ok) { this._showAccessDenied(); return; }
        this._buildLobby();
      })
      .catch((err) => { console.error('[WRTC] embed-check FAILED (catch):', err); this._showAccessDenied(); });
  }

  _showAccessDenied() {
    this.parentNode.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;background:#202124;';
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

    // Enable Join only when name is non-empty
    const nameInput = document.getElementById("wrtc-name-input");
    const joinBtn   = document.getElementById("wrtc-join-btn");
    nameInput.addEventListener("input", () => {
      joinBtn.disabled = nameInput.value.trim().length === 0;
    });
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
      const savedName = sessionStorage.getItem('wrtc_name_' + this.roomName);
      if (savedName) {
        nameInput.value = savedName;
        joinBtn.disabled = false;
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
    sessionStorage.setItem('wrtc_name_' + this.roomName, name);
    this._buildUI();
    // Reattach local stream to the meeting PiP
    const localVid = document.getElementById("wrtc-local-video");
    if (localVid) localVid.srcObject = this._localStream;
    // Sync mic/cam state from lobby toggles
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
    this._setupAudioAnalyser("local", this._localStream);
    this._setupWebSocket();
    this._startSpeakerDetection();
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
        backdrop-filter:blur(4px);
      }
      .wrtc-status-dot{
        width:8px;height:8px;border-radius:50%;background:#5f6368;
        transition:background .3s;
      }
      .wrtc-status-dot.ok {background:#34a853}
      .wrtc-status-dot.err{background:#ea4335}

      /* ── STAGE ── */
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
        position:absolute;bottom:8px;left:8px;
        display:none;flex-direction:row;gap:6px;z-index:9;
      }
      .wrtc-stage.presenting .wrtc-thumbs{ display:flex; }
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

      /* ── WAITING ── */
      .wrtc-waiting{
        position:absolute;inset:0;z-index:5;border-radius:inherit;
        display:none;flex-direction:column;align-items:center;justify-content:center;
        gap:16px;color:rgba(255,255,255,.7);text-align:center;padding:40px;
      }
      .wrtc-waiting-ring{
        width:48px;height:48px;border-radius:50%;
        border:2px solid rgba(255,255,255,.15);border-top-color:rgba(255,255,255,.6);
        animation:wrtc-spin 1.3s linear infinite;
      }
      @keyframes wrtc-spin{to{transform:rotate(360deg)}}
      .wrtc-waiting p  {font-size:14px;font-weight:500}
      .wrtc-waiting small{font-size:12px;opacity:.6}

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
        position:absolute;top:0;right:0;bottom:0;width:340px;z-index:28;
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
            <video id="wrtc-local-video" autoplay muted playsinline></video>
            <div class="wrtc-pip-avatar" id="wrtc-pip-avatar">
              <span id="wrtc-pip-avatar-text"></span>
            </div>
            <div class="wrtc-pip-hand" id="wrtc-pip-hand">✋</div>
            <div class="wrtc-tile-label" id="wrtc-pip-label"></div>
            <!-- Waiting overlay — shown when alone -->
            <div class="wrtc-waiting" id="wrtc-waiting">
              <div class="wrtc-waiting-ring"></div>
              <p>Waiting for others to join</p>
              <small>Room: <strong id="wrtc-room-hint"></strong></small>
            </div>
          </div>
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
    document.getElementById("wrtc-btn-mic").addEventListener("click",   () => this._toggleMic());
    document.getElementById("wrtc-btn-cam").addEventListener("click",   () => this._toggleCam());
    document.getElementById("wrtc-btn-share").addEventListener("click", () => this._toggleScreenShare());
    document.getElementById("wrtc-btn-rec").addEventListener("click",   () => this._toggleRecording());
    document.getElementById("wrtc-btn-hand").addEventListener("click",  () => this._toggleHand());
    document.getElementById("wrtc-btn-people").addEventListener("click", () => this._togglePanel("people"));
    document.getElementById("wrtc-btn-chat").addEventListener("click",   () => this._togglePanel("chat"));
    document.getElementById("wrtc-tab-people").addEventListener("click", () => this._switchTab("people"));
    document.getElementById("wrtc-tab-chat").addEventListener("click",   () => this._switchTab("chat"));
    document.getElementById("wrtc-panel-close").addEventListener("click",() => this._closePanel());
    document.getElementById("wrtc-chat-send").addEventListener("click",  () => this._sendChat());
    document.getElementById("wrtc-chat-input").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._sendChat(); }
    });

    this._startClock();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLOCK
  // ═══════════════════════════════════════════════════════════════════════
  _startClock() {
    const tick = () => {
      const el = document.getElementById("wrtc-clock");
      if (el) el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };
    tick();
    this._clockTimer = setInterval(tick, 15000);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MIC / CAM
  // ═══════════════════════════════════════════════════════════════════════
  _toggleMic() {
    this._micEnabled = !this._micEnabled;
    this._localStream?.getAudioTracks().forEach(t => { t.enabled = this._micEnabled; });
    document.getElementById("wrtc-btn-mic").classList.toggle("muted", !this._micEnabled);
    document.getElementById("wrtc-ico-mic").style.display     = this._micEnabled ? "" : "none";
    document.getElementById("wrtc-ico-mic-off").style.display = this._micEnabled ? "none" : "";
    this._toast(this._micEnabled ? "Microphone on" : "Microphone muted");
  }

  _toggleCam() {
    this._camEnabled = !this._camEnabled;
    this._localStream?.getVideoTracks().forEach(t => { t.enabled = this._camEnabled; });
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
    document.getElementById("wrtc-thumbs").innerHTML = "";
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
    const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const div  = document.createElement("div");
    div.className = `wrtc-msg${isMine ? " mine" : ""}`;
    div.innerHTML = `
      <div class="wrtc-msg-header">
        <span class="wrtc-msg-name${isMine ? " mine" : ""}">${name}</span>
        <span class="wrtc-msg-time">${time}</span>
      </div>
      <span class="wrtc-msg-text">${text.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</span>`;
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
  _updateGrid() {
    const grid    = document.getElementById("wrtc-grid");
    const waiting = document.getElementById("wrtc-waiting");
    if (!grid) return;
    const remoteCount = Object.keys(this._peerConnections).length;
    waiting.style.display = remoteCount === 0 ? "flex" : "none";
    const total = remoteCount + 1; // +1 for local tile
    let cols, rows;
    if (total <= 1)       { cols = 1; rows = 1; }
    else if (total === 2) { cols = 2; rows = 1; }
    else if (total <= 4)  { cols = 2; rows = 2; }
    else if (total <= 6)  { cols = 3; rows = 2; }
    else if (total <= 9)  { cols = 3; rows = 3; }
    else                  { cols = 4; rows = Math.ceil(total / 4); }
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows    = `repeat(${rows}, minmax(0, 1fr))`;
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
    const url = `${this.serverUrl}/ws/meetings/${this.roomName}?token=${this.token}`;
    this._log("Connecting WebSocket: " + url);
    this._ws = new WebSocket(url);
    this._ws.onopen    = ()  => {
      this._log("WS connected", undefined, "ok");
      this._setStatus("ok");
      // Tell everyone in the room our name
      this._sendWS({ type: "name", payload: { name: this._myName } });
    };
    this._ws.onclose   = (e) => { this._log(`WS closed — code=${e.code}`, undefined, "warn"); this._setStatus("err"); };
    this._ws.onerror   = ()  => { this._log("WS error", undefined, "error"); this._setStatus("err"); };
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
        this._myUserId = payload.myId || null;
        this._isHost   = payload.isHost || false;
        // Populate participants for users already in room (names arrive via "name" messages)
        payload.users.forEach(uid => { this._participants[uid] = this._displayName(uid); });
        this._renderParticipants();
        break;

      case "join":
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

      case "host-changed":
        this._isHost = (payload.hostId === this._myUserId);
        if (this._isHost) this._toast("You are now the host");
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
      case "sfu:transportCreated":
      case "sfu:transportConnected":
      case "sfu:produced":
      case "sfu:newProducer":
      case "sfu:consumed":
      case "sfu:consumerResumed":
      case "sfu:producers":
        this._log(`${type} (SFU stub)`);
        break;

      case "error": this._log("Server error: " + payload.detail, undefined, "error"); break;
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
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(msg));
    else this._log("WS not open — dropped " + msg.type, undefined, "warn");
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
    this._sendWS({ type: "leave", payload: {} });
    Object.keys(this._peerConnections).forEach(id => this._cleanupPeer(id));
    this._ws?.close();
    this._localStream?.getTracks().forEach(t => t.stop());
    this._shareStream?.getTracks().forEach(t => t.stop());
    if (this._isRecording) this._mediaRecorder?.stop();
    clearInterval(this._clockTimer);
    clearInterval(this._speakerTimer);
    if (this._audioCtx) { this._audioCtx.close(); this._audioCtx = null; }
    document.getElementById("wrtc-local-video").srcObject = null;
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
