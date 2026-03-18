class WebRTCMeetingAPI{constructor({serverUrl:e,roomName:t,token:i="",parentNode:a}){this.serverUrl=e,this.roomName=t,this.token=i,this.parentNode=a,this._ws=null,this._localStream=null,this._peerConnections={},this._pendingCandidates={},this._micEnabled=!0,this._camEnabled=!0,this._isSharing=!1,this._shareStream=null,this._isRecording=!1,this._mediaRecorder=null,this._recordChunks=[],this._chatOpen=!1,this._unread=0,this._handRaised=!1,this._raisedHands=new Set,this._audioCtx=null,this._analysers={},this._speakerTimer=null,this._currentSpeaker=null,this._myName="",this._peerNames={},this._participants={},this._panelTab=null,this._clockTimer=null,this._toastTimer=null,this._iceConfig={iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}]},this._buildLobby()}_buildLobby(){this.parentNode.innerHTML=`
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
    </div>`,document.getElementById("wrtc-lobby-room-name").textContent=this.roomName;let t=document.getElementById("wrtc-name-input"),i=document.getElementById("wrtc-join-btn");t.addEventListener("input",()=>{i.disabled=0===t.value.trim().length}),t.addEventListener("keydown",e=>{"Enter"!==e.key||i.disabled||i.click()}),i.addEventListener("click",()=>{var e=t.value.trim();e&&this._joinMeeting(e)}),document.getElementById("wrtc-lobby-mic").addEventListener("click",()=>{this._micEnabled=!this._micEnabled,this._localStream?.getAudioTracks().forEach(e=>{e.enabled=this._micEnabled}),document.getElementById("wrtc-lobby-mic").classList.toggle("muted",!this._micEnabled),document.getElementById("wrtc-lobby-mic-on").style.display=this._micEnabled?"":"none",document.getElementById("wrtc-lobby-mic-off").style.display=this._micEnabled?"none":""}),document.getElementById("wrtc-lobby-cam").addEventListener("click",()=>{this._camEnabled=!this._camEnabled,this._localStream?.getVideoTracks().forEach(e=>{e.enabled=this._camEnabled}),document.getElementById("wrtc-lobby-cam").classList.toggle("muted",!this._camEnabled),document.getElementById("wrtc-lobby-cam-on").style.display=this._camEnabled?"":"none",document.getElementById("wrtc-lobby-cam-icon-off").style.display=this._camEnabled?"none":"",document.getElementById("wrtc-lobby-video").style.display=this._camEnabled?"block":"none",document.getElementById("wrtc-lobby-cam-off").style.display=this._camEnabled?"none":"flex"}),this._initPreview()}async _initPreview(){try{this._localStream=await navigator.mediaDevices.getUserMedia({video:!0,audio:!0}),document.getElementById("wrtc-lobby-video").srcObject=this._localStream}catch(e){this._log("Preview camera failed: "+e.message,void 0,"warn"),document.getElementById("wrtc-lobby-cam-off").style.display="flex",document.getElementById("wrtc-lobby-video").style.display="none"}}_joinMeeting(e){this._myName=e,this._buildUI();e=document.getElementById("wrtc-local-video");e&&(e.srcObject=this._localStream),this._camEnabled||(document.getElementById("wrtc-local-video").style.display="none",document.getElementById("wrtc-pip-avatar").style.display="flex",document.getElementById("wrtc-btn-cam").classList.add("muted"),document.getElementById("wrtc-ico-cam").style.display="none",document.getElementById("wrtc-ico-cam-off").style.display=""),this._micEnabled||(document.getElementById("wrtc-btn-mic").classList.add("muted"),document.getElementById("wrtc-ico-mic").style.display="none",document.getElementById("wrtc-ico-mic-off").style.display=""),this._setupAudioAnalyser("local",this._localStream),this._setupWebSocket(),this._startSpeakerDetection()}_buildUI(){this.parentNode.innerHTML=`
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
        flex:1;display:grid;gap:8px;
        padding:8px;overflow:hidden;
        align-items:center;justify-items:center;
        align-content:center;justify-content:center;
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
      /* local pip moves up when thumbs visible */
      .wrtc-stage.presenting ~ .wrtc-pip{ bottom:106px; }
      .wrtc-stage.panel-open ~ .wrtc-pip{ right:356px; }

      /* ── WAITING ── */
      .wrtc-waiting{
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:16px;color:rgba(255,255,255,.45);text-align:center;padding:40px;
      }
      .wrtc-waiting-ring{
        width:64px;height:64px;border-radius:50%;
        border:2px solid rgba(255,255,255,.15);border-top-color:rgba(255,255,255,.5);
        animation:wrtc-spin 1.3s linear infinite;
      }
      @keyframes wrtc-spin{to{transform:rotate(360deg)}}
      .wrtc-waiting p  {font-size:15px;font-weight:400}
      .wrtc-waiting small{font-size:12px;opacity:.6}

      /* ── PiP ── */
      .wrtc-pip{
        position:absolute;bottom:96px;right:16px;
        width:192px;height:108px;border-radius:12px;overflow:hidden;
        background:#3c4043;z-index:25;
        box-shadow:0 4px 24px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08);
        transition:transform .15s,box-shadow .25s,right .25s;cursor:pointer;
      }
      .wrtc-stage.chat-open ~ .wrtc-pip{right:356px}
      .wrtc-pip:hover{transform:scale(1.03);box-shadow:0 8px 32px rgba(0,0,0,.7),0 0 0 2px rgba(255,255,255,.2)}
      .wrtc-pip.speaking{box-shadow:0 0 0 3px #1a73e8,0 4px 24px rgba(0,0,0,.6)}
      .wrtc-pip video{width:100%;height:100%;object-fit:cover;display:block}
      .wrtc-pip-avatar{
        position:absolute;inset:0;display:none;
        align-items:center;justify-content:center;
      }
      .wrtc-pip-avatar span{
        width:48px;height:48px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        font-size:20px;font-weight:500;color:#fff;background:#5f6368;
      }
      .wrtc-pip-label{
        position:absolute;bottom:6px;left:8px;
        font-size:11px;color:#fff;font-weight:500;
        background:rgba(0,0,0,.5);padding:2px 6px;border-radius:4px;
        backdrop-filter:blur(3px);
      }
      .wrtc-pip-hand{
        position:absolute;top:6px;right:8px;font-size:18px;
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
          <div class="wrtc-waiting" id="wrtc-waiting">
            <div class="wrtc-waiting-ring"></div>
            <p>Waiting for others to join</p>
            <small>Room: <strong id="wrtc-room-hint"></strong></small>
          </div>
        </div>
      </div>

      <!-- Thumbnail strip (shown during presentation) -->
      <div class="wrtc-thumbs" id="wrtc-thumbs"></div>

      <!-- SELF PiP -->
      <div class="wrtc-pip" id="wrtc-pip">
        <video id="wrtc-local-video" autoplay muted playsinline></video>
        <div class="wrtc-pip-avatar" id="wrtc-pip-avatar">
          <span id="wrtc-pip-avatar-text"></span>
        </div>
        <div class="wrtc-pip-hand" id="wrtc-pip-hand">✋</div>
        <div class="wrtc-pip-label" id="wrtc-pip-label"></div>
      </div>

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
    </div>`,document.getElementById("wrtc-room-name").textContent=this.roomName,document.getElementById("wrtc-room-hint").textContent=this.roomName,document.getElementById("wrtc-pip-label").textContent=this._myName||"You",document.getElementById("wrtc-pip-avatar-text").textContent=this._myName?this._myName.slice(0,2).toUpperCase():"YO",document.getElementById("wrtc-btn-leave").addEventListener("click",()=>this.hangup()),document.getElementById("wrtc-btn-mic").addEventListener("click",()=>this._toggleMic()),document.getElementById("wrtc-btn-cam").addEventListener("click",()=>this._toggleCam()),document.getElementById("wrtc-btn-share").addEventListener("click",()=>this._toggleScreenShare()),document.getElementById("wrtc-btn-rec").addEventListener("click",()=>this._toggleRecording()),document.getElementById("wrtc-btn-hand").addEventListener("click",()=>this._toggleHand()),document.getElementById("wrtc-btn-people").addEventListener("click",()=>this._togglePanel("people")),document.getElementById("wrtc-btn-chat").addEventListener("click",()=>this._togglePanel("chat")),document.getElementById("wrtc-tab-people").addEventListener("click",()=>this._switchTab("people")),document.getElementById("wrtc-tab-chat").addEventListener("click",()=>this._switchTab("chat")),document.getElementById("wrtc-panel-close").addEventListener("click",()=>this._closePanel()),document.getElementById("wrtc-chat-send").addEventListener("click",()=>this._sendChat()),document.getElementById("wrtc-chat-input").addEventListener("keydown",e=>{"Enter"!==e.key||e.shiftKey||(e.preventDefault(),this._sendChat())}),this._startClock()}_startClock(){var e=()=>{var e=document.getElementById("wrtc-clock");e&&(e.textContent=(new Date).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}))};e(),this._clockTimer=setInterval(e,15e3)}_toggleMic(){this._micEnabled=!this._micEnabled,this._localStream?.getAudioTracks().forEach(e=>{e.enabled=this._micEnabled}),document.getElementById("wrtc-btn-mic").classList.toggle("muted",!this._micEnabled),document.getElementById("wrtc-ico-mic").style.display=this._micEnabled?"":"none",document.getElementById("wrtc-ico-mic-off").style.display=this._micEnabled?"none":"",this._toast(this._micEnabled?"Microphone on":"Microphone muted")}_toggleCam(){this._camEnabled=!this._camEnabled,this._localStream?.getVideoTracks().forEach(e=>{e.enabled=this._camEnabled}),document.getElementById("wrtc-btn-cam").classList.toggle("muted",!this._camEnabled),document.getElementById("wrtc-ico-cam").style.display=this._camEnabled?"":"none",document.getElementById("wrtc-ico-cam-off").style.display=this._camEnabled?"none":"",document.getElementById("wrtc-local-video").style.display=this._camEnabled?"block":"none",document.getElementById("wrtc-pip-avatar").style.display=this._camEnabled?"none":"flex",this._toast(this._camEnabled?"Camera on":"Camera off")}async _toggleScreenShare(){if(this._isSharing)this._shareStream?.getTracks().forEach(e=>e.stop()),this._shareStream=null,this._isSharing=!1,await this._restoreCameraTrack(),document.getElementById("wrtc-btn-share").classList.remove("on-air"),document.getElementById("wrtc-ico-share").style.display="",document.getElementById("wrtc-ico-share-stop").style.display="none",document.getElementById("wrtc-local-video").srcObject=this._localStream,this._clearPresenter(),this._sendWS({type:"presenting",payload:{active:!1}}),this._toast("Screen sharing stopped");else try{this._shareStream=await navigator.mediaDevices.getDisplayMedia({video:!0,audio:!0}),this._isSharing=!0;var e=this._shareStream.getVideoTracks()[0];e.onended=()=>{this._isSharing&&this._toggleScreenShare()},await this._replaceVideoTrack(e),document.getElementById("wrtc-btn-share").classList.add("on-air"),document.getElementById("wrtc-ico-share").style.display="none",document.getElementById("wrtc-ico-share-stop").style.display="",this._setLocalPresenter(),this._sendWS({type:"presenting",payload:{active:!0}}),this._toast("You are now presenting")}catch(e){"NotAllowedError"!==e.name&&this._toast("Screen share failed"),this._log("Screen share error: "+e.message,void 0,"error")}}_setPresenter(t){var e=document.getElementById("wrtc-stage");let i=document.getElementById("wrtc-thumbs");e?.classList.add("presenting"),i.innerHTML="",document.querySelectorAll(".wrtc-tile").forEach(e=>{e.id==="wrtc-tile-"+t?e.classList.add("presenter"):(this._addThumb(e,i),e.style.display="none")})}_setLocalPresenter(){var e=document.getElementById("wrtc-stage");let t=document.getElementById("wrtc-thumbs");var i=document.getElementById("wrtc-grid"),e=(e?.classList.add("presenting"),t.innerHTML="",document.createElement("div")),a=(e.id="wrtc-local-share-tile",e.className="wrtc-tile presenter",document.createElement("video")),r=(a.autoplay=!0,a.playsInline=!0,a.muted=!0,a.srcObject=this._shareStream,document.createElement("div")),n=(r.className="wrtc-presenter-badge",r.textContent="You are presenting",document.createElement("div"));n.className="wrtc-tile-label",n.textContent=this._myName||"You",e.append(a,r,n),i.appendChild(e),document.querySelectorAll(".wrtc-tile:not(#wrtc-local-share-tile)").forEach(e=>{this._addThumb(e,t),e.style.display="none"}),document.getElementById("wrtc-local-video").srcObject=this._localStream}_addThumb(e,t){var i,a,r=e.querySelector("video");r&&((i=document.createElement("div")).className="wrtc-thumb-tile",(a=document.createElement("video")).autoplay=!0,a.playsInline=!0,a.muted=!0,a.srcObject=r.srcObject,(r=document.createElement("div")).className="wrtc-thumb-label",r.textContent=e.querySelector(".wrtc-tile-label")?.textContent||"",i.append(a,r),t.appendChild(i))}_clearPresenter(){document.getElementById("wrtc-local-share-tile")?.remove(),document.getElementById("wrtc-stage")?.classList.remove("presenting"),document.getElementById("wrtc-thumbs").innerHTML="",document.querySelectorAll(".wrtc-tile").forEach(e=>{e.classList.remove("presenter"),e.style.display=""}),this._updateGrid()}async _replaceVideoTrack(e){for(var t of Object.values(this._peerConnections)){t=t.getSenders().find(e=>"video"===e.track?.kind);t&&await t.replaceTrack(e)}}async _restoreCameraTrack(){var e=this._localStream?.getVideoTracks()[0];e&&await this._replaceVideoTrack(e)}_toggleRecording(){if(this._isRecording)this._mediaRecorder?.stop(),this._isRecording=!1,document.getElementById("wrtc-btn-rec").classList.remove("active-feature"),document.getElementById("wrtc-rec-badge").classList.remove("active"),document.getElementById("wrtc-rec-circle").setAttribute("fill","currentColor"),this._toast("Recording saved");else{var e=this._isSharing?this._shareStream:this._localStream;if(e){let t=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"].find(e=>MediaRecorder.isTypeSupported(e))||"";this._recordChunks=[],this._mediaRecorder=new MediaRecorder(e,t?{mimeType:t}:{}),this._mediaRecorder.ondataavailable=e=>{0<e.data.size&&this._recordChunks.push(e.data)},this._mediaRecorder.onstop=()=>{var e=new Blob(this._recordChunks,{type:t||"video/webm"}),e=URL.createObjectURL(e);Object.assign(document.createElement("a"),{href:e,download:`meeting-${Date.now()}.webm`}).click(),URL.revokeObjectURL(e)},this._mediaRecorder.start(1e3),this._isRecording=!0,document.getElementById("wrtc-btn-rec").classList.add("active-feature"),document.getElementById("wrtc-rec-badge").classList.add("active"),document.getElementById("wrtc-rec-circle").setAttribute("fill","#fff"),this._toast("Recording started")}else this._toast("No stream to record")}}_togglePanel(e){this._panelTab===e?this._closePanel():(this._panelTab=e,document.getElementById("wrtc-side-panel").classList.add("open"),document.getElementById("wrtc-stage").classList.add("panel-open"),document.getElementById("wrtc-btn-people").classList.toggle("on-air","people"===e),document.getElementById("wrtc-btn-chat").classList.toggle("on-air","chat"===e),this._switchTab(e))}_switchTab(e){this._panelTab=e,document.getElementById("wrtc-tab-people").classList.toggle("active","people"===e),document.getElementById("wrtc-tab-chat").classList.toggle("active","chat"===e),document.getElementById("wrtc-people-content").style.display="people"===e?"flex":"none",document.getElementById("wrtc-chat-content").style.display="chat"===e?"flex":"none","chat"===e&&(this._unread=0,document.getElementById("wrtc-chat-badge").classList.remove("show"),document.getElementById("wrtc-chat-badge-btn").classList.remove("show"),setTimeout(()=>document.getElementById("wrtc-chat-input")?.focus(),260))}_closePanel(){this._panelTab=null,document.getElementById("wrtc-side-panel").classList.remove("open"),document.getElementById("wrtc-stage").classList.remove("panel-open"),document.getElementById("wrtc-btn-people").classList.remove("on-air"),document.getElementById("wrtc-btn-chat").classList.remove("on-air")}_addParticipant(e,t){this._participants[e]=t,this._renderParticipants()}_removeParticipant(e){delete this._participants[e],this._renderParticipants()}_renderParticipants(){let i=document.getElementById("wrtc-people-list");var e,t;i&&(e=Object.keys(this._participants).length+1,(t=document.getElementById("wrtc-people-count"))&&(t.textContent=e),this._updateUserCount(e),i.innerHTML="",t=this._makePersonEl("local",this._myName||"You",!0),i.appendChild(t),Object.entries(this._participants).forEach(([e,t])=>{i.appendChild(this._makePersonEl(e,t,!1))}))}_makePersonEl(e,t,i){var a=document.createElement("div"),r=(a.className="wrtc-person",document.createElement("div")),e=(r.className="wrtc-person-avatar",r.style.background=this._colorFromId(e),r.textContent=t.slice(0,2).toUpperCase(),document.createElement("div")),n=(e.className="wrtc-person-info",document.createElement("div")),t=(n.className="wrtc-person-name",n.textContent=t,i&&((t=document.createElement("span")).className="wrtc-you-tag",t.textContent="(you)",n.appendChild(t)),e.appendChild(n),document.createElement("div"));return t.className="wrtc-person-icons",i&&!this._micEnabled&&(t.innerHTML+=`<span class="wrtc-person-icon muted" title="Muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
          </svg></span>`),a.append(r,e,t),a}_sendChat(){var e=document.getElementById("wrtc-chat-input"),t=e?.value.trim();t&&(e.value="",e=Date.now(),this._sendWS({type:"chat",payload:{text:t,ts:e}}),this._renderMessage("You",t,e,!0))}_renderMessage(e,t,i,a=!1){var r=document.getElementById("wrtc-chat-empty"),r=(r&&(r.style.display="none"),document.getElementById("wrtc-chat-msgs")),i=new Date(i).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),n=document.createElement("div");n.className="wrtc-msg"+(a?" mine":""),n.innerHTML=`
      <div class="wrtc-msg-header">
        <span class="wrtc-msg-name${a?" mine":""}">${e}</span>
        <span class="wrtc-msg-time">${i}</span>
      </div>
      <span class="wrtc-msg-text">${t.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</span>`,r.appendChild(n),r.scrollTop=r.scrollHeight}_renderSystemMsg(e){var t,i=document.getElementById("wrtc-chat-msgs");i&&((t=document.createElement("div")).className="wrtc-msg-system",t.textContent=e,i.appendChild(t),i.scrollTop=i.scrollHeight)}_toggleHand(){this._handRaised=!this._handRaised,document.getElementById("wrtc-btn-hand").classList.toggle("active-feature",this._handRaised),document.getElementById("wrtc-pip-hand").classList.toggle("raised",this._handRaised),this._sendWS({type:"raise-hand",payload:{raised:this._handRaised}}),this._toast(this._handRaised?"You raised your hand ✋":"Hand lowered")}_updateHandUI(e,t){e=document.getElementById("wrtc-hand-"+e);e&&e.classList.toggle("raised",t)}_setupAudioAnalyser(e,t){try{this._audioCtx||(this._audioCtx=new(window.AudioContext||window.webkitAudioContext));var i=this._audioCtx.createMediaStreamSource(t),a=this._audioCtx.createAnalyser();a.fftSize=256,a.smoothingTimeConstant=.8,i.connect(a),this._analysers[e]=a}catch(e){this._log("AudioContext error: "+e.message,void 0,"warn")}}_getAudioLevel(e){var t=new Uint8Array(e.frequencyBinCount);return e.getByteFrequencyData(t),t.reduce((e,t)=>e+t,0)/t.length}_startSpeakerDetection(){this._speakerTimer=setInterval(()=>{var e,t;let i=8,a=null;for([e,t]of Object.entries(this._analysers)){var r=this._getAudioLevel(t);r>i&&(i=r,a=e)}a!==this._currentSpeaker&&(this._currentSpeaker&&("local"===this._currentSpeaker?document.getElementById("wrtc-pip"):document.getElementById("wrtc-tile-"+this._currentSpeaker))?.classList.remove("speaking"),a&&("local"===a?document.getElementById("wrtc-pip"):document.getElementById("wrtc-tile-"+a))?.classList.add("speaking"),this._currentSpeaker=a)},200)}_toast(e){let t=document.getElementById("wrtc-toast");t&&(t.textContent=e,t.classList.add("show"),clearTimeout(this._toastTimer),this._toastTimer=setTimeout(()=>t.classList.remove("show"),2400))}_updateGrid(){var e=document.getElementById("wrtc-grid"),t=document.getElementById("wrtc-waiting"),i=Object.keys(this._peerConnections).length;e&&(t.style.display=0===i?"flex":"none",0===i?(e.style.gridTemplateColumns="1fr",e.style.gridTemplateRows="1fr"):(e.style.gridTemplateColumns=`repeat(${t=1===i?1:i<=4?2:i<=9?3:4}, minmax(0, 1fr))`,e.style.gridTemplateRows=`repeat(${Math.ceil(i/t)}, minmax(0, 1fr))`))}_log(e,t,i="info"){var a=(new Date).toTimeString().slice(0,8),t=void 0!==t?e+" "+JSON.stringify(t):e;("error"===i?console.error:"warn"===i?console.warn:console.log)(`[${a}] `+t)}async _getUserMedia(){this._log("Requesting camera + microphone...");try{this._localStream=await navigator.mediaDevices.getUserMedia({video:!0,audio:!0}),this._log("getUserMedia OK",this._localStream.getTracks().map(e=>e.kind+":"+e.label),"ok"),document.getElementById("wrtc-local-video").srcObject=this._localStream,this._setupAudioAnalyser("local",this._localStream)}catch(e){throw this._log("getUserMedia FAILED: "+e.message,void 0,"error"),e}}_setupWebSocket(){var e=`${this.serverUrl}/ws/meetings/${this.roomName}?token=`+this.token;this._log("Connecting WebSocket: "+e),this._ws=new WebSocket(e),this._ws.onopen=()=>{this._log("WS connected",void 0,"ok"),this._setStatus("ok"),this._sendWS({type:"name",payload:{name:this._myName}})},this._ws.onclose=e=>{this._log("WS closed — code="+e.code,void 0,"warn"),this._setStatus("err")},this._ws.onerror=()=>{this._log("WS error",void 0,"error"),this._setStatus("err")},this._ws.onmessage=e=>this._handleMessages(e)}_setupPeerConnection(t){if(this._peerConnections[t])return this._peerConnections[t];this._log("Creating PeerConnection for "+t);let i=new RTCPeerConnection(this._iceConfig);return this._localStream?.getTracks().forEach(e=>i.addTrack(e,this._localStream)),i.ontrack=e=>{this._log(`Remote track from ${t}: `+e.track.kind,void 0,"ok"),this._addRemoteVideo(t,e.streams[0]),"audio"===e.track.kind&&this._setupAudioAnalyser(t,e.streams[0])},i.onicecandidate=e=>{e.candidate&&this._sendWS({type:"ice-candidate",to:t,payload:{candidate:e.candidate}})},i.oniceconnectionstatechange=()=>this._log(`ICE [${t}]: `+i.iceConnectionState),i.onconnectionstatechange=()=>{var e=i.connectionState;this._log(`PC [${t}]: `+e,void 0,"connected"===e?"ok":"failed"===e?"error":"info"),"failed"!==e&&"disconnected"!==e||this._cleanupPeer(t)},this._peerConnections[t]=i}async _handleMessages(e){let t;try{t=JSON.parse(e.data)}catch{return void this._log("Non-JSON frame",void 0,"warn")}let{type:i,from:a,payload:r}=t;switch(i){case"user-list":r.users.forEach(e=>{this._participants[e]=this._displayName(e)}),this._renderParticipants();break;case"join":this._participants[r.user_id]=this._displayName(r.user_id),this._renderParticipants(),this._sendWS({type:"name",payload:{name:this._myName}}),this._isSharing&&setTimeout(()=>this._sendWS({type:"presenting",payload:{active:!0}}),800),await this._initiateOffer(r.user_id);break;case"leave":var n=this._displayName(r.user_id);this._toast(n+" left the call"),this._renderSystemMsg(n+" left"),document.getElementById("wrtc-tile-"+r.user_id)?.classList.contains("presenter")&&this._clearPresenter(),this._removeParticipant(r.user_id),this._cleanupPeer(r.user_id);break;case"offer":var n=this._setupPeerConnection(a),s=("have-local-offer"===n.signalingState&&await n.setLocalDescription({type:"rollback"}),await n.setRemoteDescription(new RTCSessionDescription(r.sdp)),await this._flushCandidates(a),await n.createAnswer());await n.setLocalDescription(s),this._sendWS({type:"answer",to:a,payload:{sdp:n.localDescription}});break;case"answer":s=this._peerConnections[a];s&&"have-local-offer"===s.signalingState&&(await s.setRemoteDescription(new RTCSessionDescription(r.sdp)),await this._flushCandidates(a));break;case"ice-candidate":n=this._peerConnections[a];n&&r.candidate&&(n.remoteDescription?await n.addIceCandidate(new RTCIceCandidate(r.candidate)):(this._pendingCandidates[a]||(this._pendingCandidates[a]=[]),this._pendingCandidates[a].push(new RTCIceCandidate(r.candidate))));break;case"chat":s=this._displayName(a);if(this._renderMessage(s,r.text,r.ts||Date.now(),!1),"chat"!==this._panelTab){this._unread++;let t=9<this._unread?"9+":this._unread;["wrtc-chat-badge","wrtc-chat-badge-btn"].forEach(e=>{e=document.getElementById(e);e&&(e.textContent=t,e.classList.add("show"))}),this._toast(s+": "+r.text.slice(0,40)+(40<r.text.length?"…":""))}break;case"name":this._peerNames[a]=r.name;n=document.getElementById("wrtc-tile-"+a);n&&((s=n.querySelector(".wrtc-tile-label"))&&(s.textContent=r.name),n=document.querySelector(`#wrtc-avatar-${a} span`))&&(n.textContent=r.name.slice(0,2).toUpperCase()),this._addParticipant(a,r.name),this._renderSystemMsg(r.name+" joined");break;case"raise-hand":s=this._displayName(a),n=r.raised;n?(this._raisedHands.add(a),this._toast(s+" raised their hand ✋"),this._renderSystemMsg(s+" raised their hand ✋")):this._raisedHands.delete(a),this._updateHandUI(a,n);break;case"presenting":s=this._displayName(a);r.active?(this._toast(s+" is presenting"),setTimeout(()=>this._setPresenter(a),300)):(this._clearPresenter(),this._toast(s+" stopped presenting"));break;case"sfu:rtpCapabilities":case"sfu:transportCreated":case"sfu:transportConnected":case"sfu:produced":case"sfu:newProducer":case"sfu:consumed":case"sfu:consumerResumed":case"sfu:producers":this._log(i+" (SFU stub)");break;case"error":this._log("Server error: "+r.detail,void 0,"error")}}async _initiateOffer(e){var t=this._setupPeerConnection(e),i=await t.createOffer();await t.setLocalDescription(i),this._sendWS({type:"offer",to:e,payload:{sdp:t.localDescription}})}async _flushCandidates(e){var t=this._pendingCandidates[e];if(t?.length){for(var i of t)await this._peerConnections[e].addIceCandidate(i);delete this._pendingCandidates[e]}}_cleanupPeer(e){this._peerConnections[e]?.close(),delete this._peerConnections[e],delete this._pendingCandidates[e],delete this._analysers[e],this._raisedHands.delete(e),document.getElementById("wrtc-tile-"+e)?.remove(),this._updateUserCount(Object.keys(this._peerConnections).length+1),this._updateGrid()}_sendWS(e){this._ws?.readyState===WebSocket.OPEN?this._ws.send(JSON.stringify(e)):this._log("WS not open — dropped "+e.type,void 0,"warn")}_addRemoteVideo(e,i){var a=document.getElementById("wrtc-vid-"+e);if(a)a.srcObject=i;else{var a=document.createElement("div"),r=(a.id="wrtc-tile-"+e,a.className="wrtc-tile",document.createElement("video"));r.id="wrtc-vid-"+e,r.autoplay=!0,r.playsInline=!0,r.srcObject=i;let t=document.createElement("div");t.className="wrtc-tile-avatar",t.id="wrtc-avatar-"+e;var n=document.createElement("span"),n=(n.style.background=this._colorFromId(e),n.textContent=this._displayName(e).slice(0,2).toUpperCase()||"?",t.appendChild(n),i.getVideoTracks().forEach(e=>{e.addEventListener("mute",()=>t.classList.add("visible")),e.addEventListener("unmute",()=>t.classList.remove("visible"))}),document.createElement("div")),i=(n.className="wrtc-tile-label",n.textContent=this._displayName(e),document.createElement("div")),s=(i.className="wrtc-presenter-badge",i.textContent="Presenting",document.createElement("div"));s.className="wrtc-tile-hand",s.id="wrtc-hand-"+e,s.textContent="✋",this._raisedHands.has(e)&&s.classList.add("raised"),a.append(r,t,i,n,s),document.getElementById("wrtc-grid").appendChild(a),this._updateGrid()}}_colorFromId(t){var e=["#1a73e8","#0f9d58","#f4511e","#a142f4","#00897b","#e52592","#e37400","#1967d2"];let i=0;for(let e=0;e<t.length;e++)i=31*i+t.charCodeAt(e)>>>0;return e[i%e.length]}_displayName(e){return e?"local"===e?this._myName||"You":this._peerNames[e]||"User "+(e.split("_").pop()||e).slice(0,6):"Unknown"}_updateUserCount(e){var t=document.getElementById("wrtc-user-count");t&&(t.textContent=e)}_setStatus(e){var t=document.getElementById("wrtc-status");t&&(t.className="wrtc-status-dot "+e)}hangup(){this._sendWS({type:"leave",payload:{}}),Object.keys(this._peerConnections).forEach(e=>this._cleanupPeer(e)),this._ws?.close(),this._localStream?.getTracks().forEach(e=>e.stop()),this._shareStream?.getTracks().forEach(e=>e.stop()),this._isRecording&&this._mediaRecorder?.stop(),clearInterval(this._clockTimer),clearInterval(this._speakerTimer),this._audioCtx&&(this._audioCtx.close(),this._audioCtx=null),document.getElementById("wrtc-local-video").srcObject=null,this._setStatus("err"),this._toast("You left the call")}}