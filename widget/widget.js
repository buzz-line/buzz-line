// @ts-check
(function () {
	"use strict";

	const scriptTag = document.currentScript;
	const dataAttrs = {
		site: scriptTag?.getAttribute("data-site"),
		authEndpoint: scriptTag?.getAttribute("data-auth-endpoint"),
	};

	const DEFAULTS = {
		server: window.location.origin,
		color: "#22c55e",
		position: "right",
		title: "Support Team",
		subtitle: "",
		supportEmail: "support@example.com",
		launcherName: "Support Team",
		launcherRole: "Support",
		launcherCta: "Chat with us",
		launcherAvatarUrl: "",
	};

	const config = Object.assign({}, DEFAULTS, window["LiveChatConfig"] || {});
	const WS_URL = config.server.replace(/^http/, "ws");
	const notificationSoundUrl = String(config.notificationSoundUrl || `${config.server}/sounds/livechat-reply.mp3`);
	const launcherName = String(config.launcherName || "Support");
	const launcherRole = String(config.launcherRole || "Team");
	const launcherCta = String(config.launcherCta || "Chat with us");
	const launcherAvatarUrl = String(config.launcherAvatarUrl || "");
	const launcherInitial = (launcherName.trim().charAt(0) || "S").toUpperCase();

	const siteName = dataAttrs.site || config.siteName || window.location.hostname;
	const authEndpoint = dataAttrs.authEndpoint || config.authEndpoint || null;
	const collectEmail = !!config.collectEmail;
	const anonymousMode = !authEndpoint;

	// --- State ---
	let visitorId = localStorage.getItem("livechat_visitor_id") || null;
	let ws = null;
	let isOpen = false;
	let unread = 0;
	let messages = [];
	let reconnectTimer = null;
	let reconnectDelay = 1000;
	let typingTimer = null;
	let jwtToken = null; // stored in memory only
	let tokenRefreshTimer = null;
	let tokenRetryTimer = null;
	let tokenRetryDelay = 2000;
	let wsAuthed = false;
	let supportPresence = "online";
	let audioCtx = null;
	let notificationAudio = null;
	let audioFileFailed = false;
	let bodyOverflowBeforeOpen = "";

	// --- Shadow DOM ---
	const host = document.createElement("div");
	host.id = "livechat-widget-host";
	const shadow = host.attachShadow({ mode: "closed" });
	document.body.appendChild(host);

	// --- Styles ---
	const style = document.createElement("style");
	style.textContent = `
    :host {
      --lc-mobile-height: 100dvh;
      --lc-mobile-offset-top: 0px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .lc-card {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 16px;
      border-radius: 9999px;
      background: rgba(17,17,19,0.95);
      backdrop-filter: blur(40px); -webkit-backdrop-filter: blur(40px);
      border: 1px solid rgba(255,255,255,0.06);
      font-size: 13px; color: #e4e4e7; font-weight: 500;
      cursor: pointer; outline: none;
      transition: all 200ms ease-out;
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .lc-card:hover { transform: scale(1.05); }
    .lc-card:focus-visible { outline: 2px solid #e4e4e7; outline-offset: 2px; }
    .lc-card.lc-hidden { display: none !important; }

    .lc-dot-wrap {
      position: relative; display: flex; width: 8px; height: 8px; flex-shrink: 0;
    }
    .lc-dot-ping {
      position: absolute; width: 100%; height: 100%;
      border-radius: 9999px; background: #34d399; opacity: 0.75;
      animation: lc-ping 1s cubic-bezier(0,0,0.2,1) infinite;
    }
    .lc-status-dot {
      position: relative; width: 8px; height: 8px;
      border-radius: 9999px; background: #34d399; flex-shrink: 0;
    }
    .lc-label { line-height: 1; }
    .lc-arrow { opacity: 0.4; flex-shrink: 0; }

    .lc-unread-badge {
      position: absolute; top: -6px; right: -6px;
      background: #ef4444; color: #ffffff; font-size: 10px; font-weight: 700;
      min-width: 20px; height: 20px; border-radius: 999px;
      display: flex; align-items: center; justify-content: center;
      font-family: inherit;
    }

    @keyframes lc-ping {
      75%, 100% { transform: scale(2); opacity: 0; }
    }

    .lc-window {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      width: 380px; max-width: calc(100vw - 24px);
      border-radius: 16px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(17,17,19,0.95);
      backdrop-filter: blur(40px); -webkit-backdrop-filter: blur(40px);
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
      display: none; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      opacity: 0; transform: translateY(8px) scale(0.985);
      transition: opacity 200ms ease, transform 200ms ease;
    }
    .lc-window.lc-visible { display: flex; }
    .lc-window.lc-animate-in { opacity: 1; transform: translateY(0) scale(1); }

    .lc-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    .lc-header-left { display: flex; align-items: center; gap: 12px; }
    .lc-header-avatar {
      width: 32px; height: 32px; border-radius: 9999px;
      background: linear-gradient(to bottom right, #22c55e, #16a34a);
      display: flex; align-items: center; justify-content: center;
      color: #ffffff; font-size: 12px; font-weight: 700; flex-shrink: 0;
    }
    .lc-header-info h3 {
      font-size: 13px; font-weight: 600; color: #fafafa; line-height: 1.25;
    }
    .lc-header-status {
      display: flex; align-items: center; gap: 6px; margin-top: 2px;
    }
    .lc-header-dot {
      width: 6px; height: 6px; border-radius: 9999px; background: #34d399; flex-shrink: 0;
    }
    .lc-header-info p {
      font-size: 10px; color: #71717a; line-height: 1;
    }
    .lc-close {
      width: 28px; height: 28px; border-radius: 8px; border: none;
      background: transparent; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: #71717a;
      transition: color 150ms ease, background 150ms ease;
    }
    .lc-close:hover { color: #fafafa; background: rgba(255,255,255,0.06); }
    .lc-close:focus-visible { outline: 2px solid #e4e4e7; outline-offset: 2px; }
    .lc-close svg { width: 14px; height: 14px; stroke: currentColor; fill: none; }

	    .lc-messages {
	      height: 300px; overflow-y: auto;
	      padding: 16px 20px;
	      display: flex; flex-direction: column; gap: 12px;
	      flex: 1 1 auto; min-height: 0;
	    }
    .lc-messages::-webkit-scrollbar { width: 4px; }
    .lc-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

    .lc-msg-wrap {
      display: flex; flex-direction: column; align-items: flex-start;
    }
    .lc-msg-wrap.visitor { align-items: flex-end; }
    .lc-msg {
      max-width: 80%; padding: 8px 14px;
      border-radius: 16px;
      font-size: 13px; line-height: 1.625; word-wrap: break-word;
    }
    .lc-msg.visitor {
      background: #ffffff; color: #09090b;
      border-bottom-right-radius: 6px;
    }
    .lc-msg.agent {
      background: rgba(255,255,255,0.06); color: #d4d4d8;
      border: 1px solid rgba(255,255,255,0.04);
      border-bottom-left-radius: 6px;
    }
    .lc-msg img {
      max-width: 100%; border-radius: 8px; margin-top: 4px; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .lc-time {
      font-size: 10px; color: #3f3f46;
      margin-top: 4px; padding: 0 4px; display: block;
    }

    .lc-offline-banner {
      display: none; margin: 0 16px 8px;
      padding: 10px 12px; border-radius: 10px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
      font-size: 12px; color: #a1a1aa; line-height: 1.5;
      position: relative;
    }
    .lc-offline-banner.lc-visible { display: block; }
    .lc-offline-dismiss {
      position: absolute; top: 6px; right: 6px;
      width: 20px; height: 20px; border-radius: 6px;
      background: transparent; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: #71717a; transition: color 150ms ease;
    }
    .lc-offline-dismiss:hover { color: #fafafa; }
    .lc-offline-dismiss svg { width: 10px; height: 10px; }

    .lc-input-outer { padding: 0 16px 16px; }
    .lc-powered {
      text-align: center; font-size: 11px; color: #3f3f46;
      margin-top: 10px; line-height: 1;
    }
    .lc-powered a { color: #3f3f46; text-decoration: underline; transition: color 150ms ease; }
    .lc-powered a:hover { color: #fafafa; }
    .lc-input-area {
      display: flex; align-items: center; gap: 8px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      padding: 10px 12px;
      flex-shrink: 0;
    }
    .lc-input {
      flex: 1; border: none; background: transparent;
      font-size: 13px; color: #fafafa; outline: none;
      font-family: inherit; min-width: 0;
    }
    .lc-input::placeholder { color: #3f3f46; }
    .lc-send {
      width: 28px; height: 28px; border-radius: 8px;
      background: #ffffff; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: background 150ms ease;
    }
    .lc-send:hover { background: #e4e4e7; }
    .lc-send:focus-visible { outline: 2px solid #e4e4e7; outline-offset: 2px; }
    .lc-send svg { width: 13px; height: 13px; }
    .lc-send:disabled { opacity: 0.35; cursor: default; }
    .lc-attach {
      width: 28px; height: 28px; border-radius: 8px;
      background: transparent; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; color: #71717a;
      transition: color 150ms ease;
    }
    .lc-attach:hover:not(:disabled) { color: #fafafa; }
    .lc-attach:disabled { opacity: 0.35; cursor: default; }
    .lc-attach:focus-visible { outline: 2px solid #e4e4e7; outline-offset: 2px; }

    .lc-welcome {
      text-align: center; padding: 36px 20px;
      color: #71717a; font-size: 13px; line-height: 1.6;
    }
    .lc-welcome h4 {
      color: #fafafa; font-size: 16px; margin-bottom: 6px; font-weight: 600;
    }

    .lc-typing { display: flex; gap: 4px; padding: 10px 12px; align-self: flex-start; }
    .lc-typing span {
      width: 6px; height: 6px; background: #71717a; border-radius: 999px;
      animation: lc-bounce 1.2s infinite;
    }
    .lc-typing span:nth-child(2) { animation-delay: 0.2s; }
    .lc-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes lc-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-5px); }
    }

	    @media (max-width: 480px) {
	      .lc-window {
	        top: var(--lc-mobile-offset-top); bottom: auto; right: 0; left: 0;
	        width: 100%;
	        height: var(--lc-mobile-height);
	        max-width: 100%; max-height: var(--lc-mobile-height);
	        border-radius: 0; border: none;
	        box-shadow: none;
	      }
	      .lc-input-outer {
	        padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
	      }
	      .lc-card { bottom: 12px; right: 12px; }
	    }
	  `;
	shadow.appendChild(style);

	// --- Build DOM ---
	const bubble = document.createElement("div");
	bubble.className = "lc-card";
	bubble.setAttribute("role", "button");
	bubble.setAttribute("aria-label", "Open chat");
	bubble.tabIndex = 0;
	bubble.innerHTML = `
    <span class="lc-dot-wrap">
      <span class="lc-dot-ping"></span>
      <span class="lc-status-dot"></span>
    </span>
    <span class="lc-label">${launcherCta}</span>
    <svg class="lc-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 17L17 7M17 7H7M17 7V17" />
    </svg>
  `;
	const badge = document.createElement("span");
	badge.className = "lc-unread-badge";
	badge.style.display = "none";
	bubble.appendChild(badge);
	shadow.appendChild(bubble);

	const win = document.createElement("div");
	win.className = "lc-window";
	win.innerHTML = `
    <div class="lc-header">
      <div class="lc-header-left">
        <div class="lc-header-avatar">${launcherInitial}</div>
        <div class="lc-header-info">
          <h3>${esc(config.title)}</h3>
          <div class="lc-header-status">
            <span class="lc-header-dot"></span>
            <p class="lc-header-subtitle"></p>
          </div>
        </div>
      </div>
      <button class="lc-close" aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
    <div class="lc-messages"></div>
    <div class="lc-offline-banner">
      We're currently offline — we'll reply when we're back.
      <button class="lc-offline-dismiss" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
    <div class="lc-input-outer">
      <div class="lc-input-area">
        <button class="lc-attach" title="Attach image">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
        <input class="lc-input" placeholder="Type a message..." autocomplete="off" />
        <button class="lc-send" disabled>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#09090b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
      <p class="lc-powered">powered by <a href="https://www.buzz-line.com" target="_blank" rel="noopener noreferrer">buzz-line</a></p>
    </div>
  `;
	shadow.appendChild(win);

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "image/jpeg,image/png,image/gif,image/webp";
	fileInput.style.display = "none";
	shadow.appendChild(fileInput);

	const messagesEl = win.querySelector(".lc-messages");
	const inputEl = win.querySelector(".lc-input");
	const sendBtn = win.querySelector(".lc-send");
	const closeBtn = win.querySelector(".lc-close");
	const attachBtn = win.querySelector(".lc-attach");
	const inputArea = win.querySelector(".lc-input-outer");
	const statusDotEl = bubble.querySelector(".lc-status-dot");
	const headerDotEl = win.querySelector(".lc-header-dot");
	const headerSubtitleEl = win.querySelector(".lc-header-subtitle");
	const offlineBanner = win.querySelector(".lc-offline-banner");
	const offlineDismiss = win.querySelector(".lc-offline-dismiss");
	let offlineBannerDismissed = false;

	if (offlineDismiss) {
		offlineDismiss.addEventListener("click", () => {
			offlineBannerDismissed = true;
			if (offlineBanner) offlineBanner.classList.remove("lc-visible");
		});
	}

	function setLauncherStatus(label, state) {
		let headerText = label;
		if (state === "online" && label === "Online") {
			headerText = "Online now";
		} else if (state === "busy") {
			headerText = "Connecting...";
		} else if (state === "offline" && label === "Offline") {
			headerText = "Offline";
		}

		if (headerSubtitleEl) headerSubtitleEl.textContent = headerText;

		if (offlineBanner) {
			if (state === "offline" && label === "Offline" && !offlineBannerDismissed) {
				offlineBanner.classList.add("lc-visible");
			} else {
				offlineBanner.classList.remove("lc-visible");
				if (state === "online") offlineBannerDismissed = false;
			}
		}

		if (!statusDotEl) return;
		const pingEl = bubble.querySelector(".lc-dot-ping");
		const color = state === "online" ? "#34d399" : state === "busy" ? "#F59E0B" : "#9CA3AF";

		statusDotEl.style.background = color;
		if (headerDotEl) headerDotEl.style.background = color;

		if (state === "online" || state === "busy") {
			if (pingEl) {
				pingEl.style.display = "";
				pingEl.style.background = color;
			}
		} else {
			if (pingEl) pingEl.style.display = "none";
		}
	}

	function applyPresenceStatus() {
		if (!wsAuthed) {
			setLauncherStatus("Connecting", "busy");
			return;
		}
		if (supportPresence === "offline") {
			setLauncherStatus("Offline", "offline");
			return;
		}
		setLauncherStatus("Online", "online");
	}

	setLauncherStatus("Connecting", "busy");

	function ensureAudioContext() {
		if (audioCtx) return;
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return;
		audioCtx = new Ctx();
	}

	function ensureNotificationAudio() {
		if (audioFileFailed) return null;
		if (notificationAudio) return notificationAudio;

		try {
			const audio = new Audio(notificationSoundUrl);
			audio.preload = "auto";
			audio.volume = 0.3;
			audio.addEventListener("error", () => {
				audioFileFailed = true;
			});
			notificationAudio = audio;
			return notificationAudio;
		} catch (_) {
			audioFileFailed = true;
			return null;
		}
	}

	function playSynthReplySound() {
		try {
			ensureAudioContext();
			if (!audioCtx) return;
			if (audioCtx.state === "suspended") {
				void audioCtx.resume();
			}

			const osc = audioCtx.createOscillator();
			const gain = audioCtx.createGain();
			osc.type = "sine";
			osc.frequency.setValueAtTime(880, audioCtx.currentTime);
			osc.frequency.exponentialRampToValueAtTime(1240, audioCtx.currentTime + 0.2);
			gain.gain.value = 0.0001;
			osc.connect(gain);
			gain.connect(audioCtx.destination);

			const now = audioCtx.currentTime;
			gain.gain.exponentialRampToValueAtTime(0.055, now + 0.015);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
			osc.start(now);
			osc.stop(now + 0.26);
		} catch (_) {
			// Best effort only; never break chat flow on sound failures.
		}
	}

	function playReplySound() {
		const audio = ensureNotificationAudio();
		if (audio) {
			try {
				audio.currentTime = 0;
				const playPromise = audio.play();
				if (playPromise && typeof playPromise.catch === "function") {
					playPromise.catch(() => {
						playSynthReplySound();
					});
				}
				return;
			} catch (_) {
				audioFileFailed = true;
			}
		}

		playSynthReplySound();
	}

	function isMobileViewport() {
		return window.matchMedia("(max-width: 480px)").matches;
	}

	function updateMobileViewportVars() {
		const vv = window.visualViewport;
		const height = vv ? vv.height : window.innerHeight;
		const offsetTop = vv ? vv.offsetTop : 0;
		const nextHeight = `${Math.max(320, Math.round(height))}px`;
		const nextTop = `${Math.max(0, Math.round(offsetTop))}px`;
		host.style.setProperty("--lc-mobile-height", nextHeight);
		host.style.setProperty("--lc-mobile-offset-top", nextTop);

		// Safari fallback: explicitly set dimensions in case CSS custom props are ignored in computed layout.
		if (isMobileViewport()) {
			win.style.height = nextHeight;
			win.style.maxHeight = nextHeight;
			win.style.top = nextTop;
		} else {
			win.style.height = "";
			win.style.maxHeight = "";
			win.style.top = "";
		}
	}

	function lockBodyScroll() {
		if (!isMobileViewport()) return;
		bodyOverflowBeforeOpen = document.body.style.overflow;
		document.body.style.overflow = "hidden";
	}

	function unlockBodyScroll() {
		document.body.style.overflow = bodyOverflowBeforeOpen;
	}

	function scheduleTokenRetry() {
		if (tokenRetryTimer) return;
		tokenRetryTimer = setTimeout(async () => {
			tokenRetryTimer = null;
			const token = await refreshToken();
			if (token) {
				jwtToken = token;
				tokenRetryDelay = 2000;
				applyPresenceStatus();
				connectWS();
				scheduleTokenRefresh();
			} else {
				tokenRetryDelay = Math.min(tokenRetryDelay * 1.5, 30000);
				scheduleTokenRetry();
			}
		}, tokenRetryDelay);
	}

	// --- Events ---
	bubble.addEventListener("click", () => toggle(true));
	bubble.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggle(true);
		}
	});
	closeBtn.addEventListener("click", () => toggle(false));

	const unlockAudio = () => {
		ensureAudioContext();
		if (audioCtx && audioCtx.state === "suspended") {
			void audioCtx.resume();
		}
		const audio = ensureNotificationAudio();
		if (audio) audio.load();
	};
	window.addEventListener("pointerdown", unlockAudio, { passive: true });
	window.addEventListener("keydown", unlockAudio, { passive: true });
	window.addEventListener("resize", () => {
		if (!isOpen) return;
		updateMobileViewportVars();
	});
	window.addEventListener("orientationchange", () => {
		if (!isOpen) return;
		updateMobileViewportVars();
		scrollBottom();
	});
	window.addEventListener("focusin", () => {
		if (!isOpen) return;
		updateMobileViewportVars();
	});
	window.addEventListener("focusout", () => {
		if (!isOpen) return;
		updateMobileViewportVars();
	});
	if (window.visualViewport) {
		window.visualViewport.addEventListener("resize", () => {
			if (!isOpen) return;
			updateMobileViewportVars();
			scrollBottom();
		});
		window.visualViewport.addEventListener("scroll", () => {
			if (!isOpen) return;
			updateMobileViewportVars();
		});
	}

	inputEl.addEventListener("input", () => {
		sendBtn.disabled = !inputEl.value.trim();
		sendTyping();
	});

	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	});

	sendBtn.addEventListener("click", sendMessage);
	attachBtn.addEventListener("click", () => fileInput.click());

	fileInput.addEventListener("change", () => {
		const file = fileInput.files[0];
		if (!file) return;
		if (file.size > 5 * 1024 * 1024) {
			alert("Image too large (max 5MB)");
			fileInput.value = "";
			return;
		}
		uploadImage(file);
		fileInput.value = "";
	});

	inputEl.addEventListener("paste", (event) => {
		const items = event.clipboardData?.items;
		if (!items || items.length === 0) return;

		for (let i = 0; i < items.length; i += 1) {
			const item = items[i];
			if (!item.type || !item.type.startsWith("image/")) continue;
			const file = item.getAsFile();
			if (!file) continue;

			event.preventDefault();
			if (file.size > 5 * 1024 * 1024) {
				alert("Image too large (max 5MB)");
				return;
			}

			uploadImage(file);
			return;
		}
	});

	function toggle(open) {
		isOpen = open;
		bubble.classList.toggle("lc-hidden", open);
		if (open) {
			updateMobileViewportVars();
			lockBodyScroll();
			win.classList.add("lc-visible");
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					win.classList.add("lc-animate-in");
				});
			});
			unread = 0;
			updateBadge();
			scrollBottom();
			if (inputEl) {
				inputEl.focus();
				scrollBottom();
			}
		} else {
			unlockBodyScroll();
			win.classList.remove("lc-animate-in");
			const fallback = setTimeout(() => {
				win.classList.remove("lc-visible");
			}, 220);
			win.addEventListener(
				"transitionend",
				function handler() {
					clearTimeout(fallback);
					win.removeEventListener("transitionend", handler);
					win.classList.remove("lc-visible");
				},
				{ once: true },
			);
		}
	}

	function updateBadge() {
		badge.textContent = unread;
		badge.style.display = unread > 0 ? "flex" : "none";
	}

	function scrollBottom() {
		requestAnimationFrame(() => {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		});
	}

	function esc(s) {
		const d = document.createElement("div");
		d.textContent = s;
		return d.innerHTML;
	}

	function formatTime(iso) {
		const d = new Date(iso);
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function resolveUrl(url) {
		if (!url) return url;
		if (url.startsWith("/")) return config.server + url;
		return url;
	}

	let agentTypingEl = null;

	function showAgentTyping() {
		if (agentTypingEl) return;
		agentTypingEl = document.createElement("div");
		agentTypingEl.className = "lc-typing";
		agentTypingEl.innerHTML = "<span></span><span></span><span></span>";
		messagesEl.appendChild(agentTypingEl);
		scrollBottom();
	}

	function hideAgentTyping() {
		if (agentTypingEl) {
			agentTypingEl.remove();
			agentTypingEl = null;
		}
	}

	function renderMessage(msg) {
		const wrap = document.createElement("div");
		wrap.className = `lc-msg-wrap ${msg.sender}`;
		const el = document.createElement("div");
		el.className = `lc-msg ${msg.sender}`;
		const imageUrl = msg.file_url || (msg.type === "image" ? msg.content : null);
		if (msg.type === "image" && imageUrl) {
			const resolved = resolveUrl(imageUrl);
			el.innerHTML = `<img src="${esc(resolved)}" alt="Image" loading="lazy" />`;
		} else {
			el.textContent = msg.content;
		}
		wrap.appendChild(el);
		const time = document.createElement("span");
		time.className = "lc-time";
		time.textContent = formatTime(msg.created_at);
		wrap.appendChild(time);
		messagesEl.appendChild(wrap);
		scrollBottom();
	}

	function renderHistory(msgs) {
		messagesEl.innerHTML = "";
		if (msgs.length === 0) {
			messagesEl.innerHTML = `
        <div class="lc-welcome">
          <h4>👋 Welcome!</h4>
          <p>Send us a message and we'll get back to you as soon as we can.</p>
        </div>
      `;
		}
		msgs.forEach(renderMessage);
	}

	function sendTyping() {
		if (typingTimer) return;
		if (ws && ws.readyState === 1 && wsAuthed) {
			ws.send(JSON.stringify({ type: "typing" }));
		}
		typingTimer = setTimeout(() => {
			typingTimer = null;
		}, 3000);
	}

	// --- Auth ---
	async function fetchToken() {
		if (!authEndpoint) return null;
		try {
			const res = await fetch(authEndpoint, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
			});
			if (!res.ok) return null;
			const data = await res.json();
			return data.token || null;
		} catch {
			return null;
		}
	}

	async function fetchAnonymousToken() {
		try {
			const storedId = localStorage.getItem("livechat_visitor_id") || undefined;
			const storedEmail = localStorage.getItem("livechat_email") || undefined;
			const body = {};
			if (storedId) body.visitorId = storedId;
			if (storedEmail) body.email = storedEmail;

			const res = await fetch(`${config.server}/api/auth/anonymous`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return { error: err.error || "Something went wrong" };
			}
			const data = await res.json();
			if (data.visitorId) {
				visitorId = data.visitorId;
				localStorage.setItem("livechat_visitor_id", data.visitorId);
			}
			return data.token || null;
		} catch {
			return null;
		}
	}

	async function refreshToken() {
		if (authEndpoint) return fetchToken();
		return fetchAnonymousToken();
	}

	function scheduleTokenRefresh() {
		if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);

		tokenRefreshTimer = setTimeout(
			async () => {
				const newToken = await refreshToken();
				if (newToken) {
					jwtToken = newToken;
					setLauncherStatus("Reconnecting", "busy");
					if (ws && ws.readyState < 2) {
						ws.close();
					}
					connectWS();
					scheduleTokenRefresh();
				} else {
					jwtToken = null;
					if (ws && ws.readyState < 2) ws.close();
					scheduleTokenRetry();
				}
			},
			4 * 60 * 1000,
		);
	}

	function authHeaders(base = {}) {
		const headers = Object.assign({}, base);
		if (jwtToken) headers.Authorization = `Bearer ${jwtToken}`;
		return headers;
	}

	function notifyUploadFailure() {
		const message = `Image upload failed. Please email ${config.supportEmail} for help.`;
		alert(message);
		const localMsg = {
			id: `local-upload-failed-${Date.now()}`,
			visitor_id: visitorId || "local",
			sender: "agent",
			content: message,
			type: "text",
			file_url: null,
			created_at: new Date().toISOString(),
		};
		messages.push(localMsg);
		renderMessage(localMsg);
	}

	// --- Image Upload ---
	async function uploadImage(file) {
		if (!visitorId || !jwtToken) return false;

		try {
			const res = await fetch(`${config.server}/api/chat/${visitorId}/upload`, {
				method: "POST",
				headers: authHeaders({ "Content-Type": file.type }),
				body: file,
			});

			if (res.status === 401 || res.status === 403) {
				scheduleTokenRetry();
				return false;
			}

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				console.error("[LiveChat] Upload error:", err.error || res.statusText);
				notifyUploadFailure();
				return false;
			}
			return true;
		} catch (err) {
			console.error("[LiveChat] Upload error:", err);
			notifyUploadFailure();
			return false;
		}
	}

	// --- Messaging ---
	function sendMessage() {
		const text = inputEl.value.trim();
		if (!text) return;
		if (text.length > 2000) {
			alert("Message too long (max 2000 characters)");
			return;
		}
		inputEl.value = "";
		sendBtn.disabled = true;

		if (ws && ws.readyState === 1 && wsAuthed) {
			ws.send(JSON.stringify({ type: "message", content: text }));
			return;
		}

		if (!jwtToken || !visitorId) return;

		fetch(`${config.server}/api/chat/${visitorId}/message`, {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ content: text }),
		})
			.then((res) => {
				if (res.status === 401 || res.status === 403) scheduleTokenRetry();
			})
			.catch((err) => console.error("[LiveChat] REST fallback error:", err));
	}

	// --- WebSocket ---
	function connectWS() {
		if (!jwtToken) return;
		if (ws && ws.readyState < 2) return;

		wsAuthed = false;
		setLauncherStatus("Connecting", "busy");

		try {
			ws = new WebSocket(WS_URL);
		} catch {
			setLauncherStatus("Offline", "offline");
			scheduleReconnect();
			return;
		}

		ws.onopen = () => {
			reconnectDelay = 1000;
			ws.send(JSON.stringify({ type: "auth", token: jwtToken }));
		};

		ws.onmessage = (e) => {
			try {
				const data = JSON.parse(e.data);

				if (data.type === "auth_ok") {
					wsAuthed = true;
					applyPresenceStatus();
					ws.send(JSON.stringify({ type: "init", visitorId, site: siteName }));
					return;
				}

				if (data.type === "init") {
					visitorId = data.visitorId;
					localStorage.setItem("livechat_visitor_id", visitorId);
					loadHistory();
					return;
				}

				if (data.type === "error") {
					console.warn("[LiveChat]", data.message);
					return;
				}

				if (data.type === "presence" && data.presence && typeof data.presence.state === "string") {
					if (data.presence.state === "online" || data.presence.state === "offline") {
						supportPresence = data.presence.state;
						applyPresenceStatus();
					}
					return;
				}

				if (data.type === "message" && data.message) {
					const exists = messages.find((m) => m.id === data.message.id);
					if (!exists) {
						if (data.message.sender === "agent") {
							showAgentTyping();
							setTimeout(() => {
								hideAgentTyping();
								messages.push(data.message);
								renderMessage(data.message);
								playReplySound();
								if (!isOpen) {
									unread += 1;
									updateBadge();
								}
							}, 1500);
						} else {
							messages.push(data.message);
							renderMessage(data.message);
						}
					}
				}
			} catch (err) {
				console.error("[LiveChat] WS parse error:", err);
			}
		};

		ws.onclose = (e) => {
			wsAuthed = false;
			if (e.code === 4001) {
				scheduleTokenRetry();
				return;
			}
			setLauncherStatus("Offline", "offline");
			scheduleReconnect();
		};

		ws.onerror = () => {
			wsAuthed = false;
			setLauncherStatus("Offline", "offline");
		};
	}

	function scheduleReconnect() {
		if (reconnectTimer) return;
		setLauncherStatus("Reconnecting", "busy");
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
			connectWS();
		}, reconnectDelay);
	}

	async function loadHistory() {
		if (!visitorId || !jwtToken) return;
		try {
			const res = await fetch(`${config.server}/api/chat/${visitorId}/history`, {
				headers: authHeaders(),
			});

			if (res.status === 401 || res.status === 403) {
				scheduleTokenRetry();
				return;
			}

			const data = await res.json();
			messages = data.messages || [];
			renderHistory(messages);
		} catch (err) {
			console.error("[LiveChat] History load error:", err);
		}
	}

	// --- Email Collection ---
	let emailCollected = false;

	function isValidEmail(value) {
		if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(value)) return false;
		const el = document.createElement("input");
		el.type = "email";
		el.value = value;
		return el.validity.valid;
	}

	function showEmailForm() {
		if (!messagesEl) return;
		const existing = messagesEl.querySelector(".lc-email-form");
		if (existing) return;

		const form = document.createElement("div");
		form.className = "lc-email-form";

		const label = document.createElement("p");
		label.textContent = "Enter your email to start chatting";
		label.style.cssText = "color:#a1a1aa;font-size:13px;margin:0 0 10px;text-align:center;";

		const input = document.createElement("input");
		input.type = "email";
		input.placeholder = "your@email.com";
		input.style.cssText = "width:100%;padding:10px 12px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;background:rgba(255,255,255,0.05);color:#fff;font-size:14px;outline:none;box-sizing:border-box;";

		const btn = document.createElement("button");
		btn.textContent = "Start Chat";
		btn.style.cssText = `width:100%;padding:10px;margin-top:8px;border:none;border-radius:10px;background:${config.color};color:#fff;font-size:14px;font-weight:600;cursor:pointer;`;

		const errMsg = document.createElement("p");
		errMsg.style.cssText = "color:#ef4444;font-size:12px;margin-top:6px;text-align:center;display:none;";

		async function submit() {
			const email = input.value.trim();
			if (!isValidEmail(email)) {
				input.style.borderColor = "#ef4444";
				errMsg.textContent = "Please enter a valid email";
				errMsg.style.display = "block";
				return;
			}
			errMsg.style.display = "none";
			input.style.borderColor = "rgba(255,255,255,0.1)";
			btn.disabled = true;
			btn.textContent = "Verifying...";
			localStorage.setItem("livechat_email", email);
			const error = await connectAnonymous();
			if (error) {
				btn.disabled = false;
				btn.textContent = "Start Chat";
				localStorage.removeItem("livechat_email");
				input.style.borderColor = "#ef4444";
				errMsg.textContent = error === "Invalid email domain" ? "Please enter a valid email address" : error;
				errMsg.style.display = "block";
				return;
			}
			emailCollected = true;
			form.remove();
			inputEl.disabled = false;
			inputEl.placeholder = "Type a message...";
			attachBtn.disabled = false;
		}

		btn.addEventListener("click", submit);
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

		form.appendChild(label);
		form.appendChild(input);
		form.appendChild(errMsg);
		form.appendChild(btn);
		form.style.cssText = "padding:24px 16px;display:flex;flex-direction:column;align-items:stretch;";

		messagesEl.innerHTML = "";
		messagesEl.appendChild(form);

		inputEl.disabled = true;
		inputEl.placeholder = "Enter your email above to start chatting";
		attachBtn.disabled = true;
	}

	async function connectAnonymous() {
		const result = await fetchAnonymousToken();
		if (result && typeof result === "object" && result.error) {
			return result.error;
		}
		jwtToken = result;
		if (!jwtToken) {
			scheduleTokenRetry();
			return;
		}
		applyPresenceStatus();
		scheduleTokenRefresh();
		connectWS();
	}

	// --- Init ---
	async function init() {
		if (authEndpoint) {
			jwtToken = await fetchToken();
			if (!jwtToken) {
				scheduleTokenRetry();
				return;
			}
			applyPresenceStatus();
			scheduleTokenRefresh();
			connectWS();
			return;
		}

		if (anonymousMode) {
			if (collectEmail && !localStorage.getItem("livechat_email")) {
				showEmailForm();
				return;
			}
			await connectAnonymous();
			return;
		}
	}

	init();
})();
