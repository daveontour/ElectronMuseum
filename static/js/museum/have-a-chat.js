'use strict';

// --- Have A Chat Module ---
// Orchestrates an autonomous voice-to-voice conversation. Each voice can be powered
// independently by Claude or Gemini, including both voices using the same LLM.
const HaveAChat = (() => {

    // ── State ────────────────────────────────────────────────────────────────
    let _isRunning      = false;
    let _isPaused       = false;
    let _stopRequested  = false;
    let _currentSlot    = null;   // 'a' or 'b'
    let _chatHistory    = [];     // [{speaker: 'a'|'b'|'user', text}]
    let _voiceA         = 'expert';
    let _voiceB         = 'expert';
    let _providerA      = 'claude';
    let _providerB      = 'gemini';
    let _banterMode     = false;
    let _allowExplicit  = false;
    let _topic          = '';
    let _temperature    = 0.7;
    let _pendingInjection = null;
    let _voiceNames     = {};  // { key: displayName } populated when voices load
    let _turnCount      = 0;   // incremented after each completed turn; prompt shown every 2 turns

    // ── DOM helpers ──────────────────────────────────────────────────────────
    const _el = (id) => document.getElementById(id);

    function _llmDisplayName(provider) {
        if (provider === 'claude') return 'Claude';
        if (provider === 'deepseek') return 'DeepSeek';
        if (provider === 'localai') return 'Local AI';
        return 'Gemini';
    }

    function _populateVoiceSelects() {
        ApiService.fetchVoices()
            .then(voices => {
                const voiceASel = _el('have-a-chat-voice-a');
                const voiceBSel = _el('have-a-chat-voice-b');
                if (!voiceASel || !voiceBSel || !voices || !voices.length) return;
                voiceASel.innerHTML = '';
                voiceBSel.innerHTML = '';
                voices.forEach(v => {
                    const key  = v.key  || v.value || '';
                    const name = v.name || key;
                    _voiceNames[key] = name;
                    const label = v.description ? `${name} - ${v.description}` : name;
                    const displayText = label + (v.is_custom ? ' *' : '');
                    const o1 = document.createElement('option');
                    o1.value = key;
                    o1.textContent = displayText;
                    voiceASel.appendChild(o1);
                    const o2 = document.createElement('option');
                    o2.value = key;
                    o2.textContent = displayText;
                    voiceBSel.appendChild(o2);
                });
                // Default voice B to a different voice to keep them distinct
                if (voiceBSel.options.length > 1) voiceBSel.selectedIndex = 1;
            })
            .catch(() => { /* leave the default option */ });
    }

    async function _getLLMAvailability() {
        try {
            const res = await fetch('/chat/availability', { credentials: 'same-origin' });
            if (!res.ok) return { localai: false };
            const av = await res.json();
            return { localai: !!av.localai_available };
        } catch (_) {
            return { localai: false };
        }
    }

    async function _applyHaveAChatProviderDefaults() {
        const providerAEl = _el('have-a-chat-provider-a');
        const providerBEl = _el('have-a-chat-provider-b');
        if (!providerAEl || !providerBEl) return;

        const av = await _getLLMAvailability();
        if (!av.localai) return;

        const userSelectedA = providerAEl.dataset.userSelectedProvider === 'true';
        const userSelectedB = providerBEl.dataset.userSelectedProvider === 'true';
        if (!userSelectedA) providerAEl.value = 'localai';
        if (!userSelectedB) providerBEl.value = 'localai';
    }

    // ── Setup modal ──────────────────────────────────────────────────────────
    async function open() {
        _populateVoiceSelects();
        await _applyHaveAChatProviderDefaults();
        const haveAChatExplicit = _el('have-a-chat-allow-explicit');
        const globalExplicit = _el('allow-explicit-content');
        if (haveAChatExplicit && globalExplicit) {
            haveAChatExplicit.checked = !!globalExplicit.checked;
        }
        const modal = _el('have-a-chat-setup-modal');
        if (modal) modal.style.display = 'flex';
    }

    function _closeSetupModal() {
        const modal = _el('have-a-chat-setup-modal');
        if (modal) modal.style.display = 'none';
    }

    function _closeInjectModal() {
        const modal = _el('have-a-chat-inject-modal');
        if (modal) modal.style.display = 'none';
    }

    // ── Message rendering ────────────────────────────────────────────────────
    // slot: 'a' or 'b'; provider: which LLM actually responded;
    // voiceKey: voice personality key; text: markdown string
    function _addHaveAChatMessage(slot, provider, voiceKey, text) {
        const msgEl = document.createElement('div');
        // Slot A always renders with blue styling, slot B with purple —
        // regardless of which LLM is powering the voice.
        const slotClass = slot === 'a' ? 'have-a-chat-claude' : 'have-a-chat-gemini';
        msgEl.classList.add('have-a-chat-message', slotClass);

        // Header: voice image + voice name + LLM badge
        const header = document.createElement('div');
        header.className = 'have-a-chat-header';

        const img = document.createElement('img');
        img.className = 'have-a-chat-voice-image';
        img.src = `/static/images/${typeof VoiceSelector !== 'undefined' ? VoiceSelector.getVoiceImage(voiceKey, true) : voiceKey + '_sm.png'}`;
        img.alt = voiceKey;
        img.onerror = () => { img.style.display = 'none'; };

        // Voice name (primary identity)
        const nameLabel = document.createElement('span');
        nameLabel.className = 'have-a-chat-label';
        nameLabel.textContent = _voiceNames[voiceKey] || voiceKey;

        // LLM badge (secondary — shows which model is speaking)
        const llmBadge = document.createElement('span');
        llmBadge.className = 'have-a-chat-llm-badge have-a-chat-llm-' + provider;
        llmBadge.textContent = _llmDisplayName(provider);

        header.appendChild(img);
        header.appendChild(nameLabel);
        header.appendChild(llmBadge);
        msgEl.appendChild(header);

        // Content with markdown render
        const contentEl = document.createElement('div');
        contentEl.className = 'have-a-chat-content';
        if (typeof marked !== 'undefined') {
            const sanitized = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            contentEl.innerHTML = marked.parse(sanitized || '');
        } else {
            contentEl.textContent = text;
        }
        msgEl.appendChild(contentEl);

        if (DOM && DOM.chatBox) {
            DOM.chatBox.appendChild(msgEl);
            if (typeof UI !== 'undefined' && UI.scrollToBottom) UI.scrollToBottom();
        }
    }

    function _addUserInjectionMessage(text) {
        const msgEl = document.createElement('div');
        msgEl.className = 'have-a-chat-user-comment';
        msgEl.textContent = `You: ${text}`;
        if (DOM && DOM.chatBox) {
            DOM.chatBox.appendChild(msgEl);
            if (typeof UI !== 'undefined' && UI.scrollToBottom) UI.scrollToBottom();
        }
    }

    // ── Control bar helpers ──────────────────────────────────────────────────
    function _syncContextStatusBar() {
        if (typeof UI !== 'undefined' && UI.syncChatContextStatusBarVisibility) {
            UI.syncChatContextStatusBarVisibility();
        }
    }

    function _showControlBar() {
        const bar = _el('have-a-chat-control-bar');
        if (bar) bar.style.display = 'flex';
        _syncContextStatusBar();
    }

    function _hideControlBar() {
        const bar = _el('have-a-chat-control-bar');
        if (bar) bar.style.display = 'none';
        _syncContextStatusBar();
    }

    function _showRoundPrompt() {
        const bar    = _el('have-a-chat-control-bar');
        const prompt = _el('have-a-chat-round-prompt');
        if (bar)    bar.style.display    = 'none';
        if (prompt) prompt.style.display = 'flex';
        _syncContextStatusBar();
    }

    function _hideRoundPrompt() {
        const bar    = _el('have-a-chat-control-bar');
        const prompt = _el('have-a-chat-round-prompt');
        if (prompt) prompt.style.display = 'none';
        if (bar)    bar.style.display    = 'flex';
        _syncContextStatusBar();
    }

    function _setStatus(text) {
        const el = _el('have-a-chat-status-text');
        if (el) el.textContent = text;
    }

    function _setPauseButtonLabel(paused) {
        const btn = _el('have-a-chat-pause-btn');
        if (!btn) return;
        btn.innerHTML = paused
            ? '<i class="fas fa-play"></i> Resume'
            : '<i class="fas fa-pause"></i> Pause';
    }

    function _disableChatForm(disabled) {
        const sendBtn = _el('send-button');
        const input   = _el('user-input');
        const micBtn  = _el('chat-voice-input-btn');
        if (sendBtn) sendBtn.disabled = disabled;
        if (input)   input.disabled   = disabled;
        if (micBtn)  micBtn.disabled  = disabled;
        if (disabled && typeof ChatVoiceInput !== 'undefined' && ChatVoiceInput.stop) {
            ChatVoiceInput.stop();
        }
        const form = _el('chat-form');
        if (form) form.style.opacity = disabled ? '0.45' : '1';
    }

    // ── API call ─────────────────────────────────────────────────────────────
    async function _callTurnEndpoint() {
        const url = (typeof CONSTANTS !== 'undefined' && CONSTANTS.API_PATHS && CONSTANTS.API_PATHS.HAVE_A_CHAT_TURN)
            ? CONSTANTS.API_PATHS.HAVE_A_CHAT_TURN
            : '/chat/have-a-chat/turn';

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                speaking_slot: _currentSlot,
                voice_a:       _voiceA,
                voice_b:       _voiceB,
                provider_a:    _providerA,
                provider_b:    _providerB,
                topic:         _topic,
                history:       _chatHistory,
                temperature:   _temperature,
                banter_mode:   _banterMode,
                allowExplicitContent: _allowExplicit,
            })
        });

        if (!resp.ok) {
            let msg = `HTTP ${resp.status}`;
            try {
                const d = await resp.json();
                msg = d.detail || d.error || msg;
            } catch (_) { /* ignore */ }
            throw new Error(msg);
        }
        return resp.json();
    }

    // ── Core loop ────────────────────────────────────────────────────────────
    async function _loop() {
        while (_isRunning && !_stopRequested) {
            // Pause: spin until resumed or stopped
            while (_isPaused && !_stopRequested) {
                await _sleep(500);
            }
            if (_stopRequested) break;

            // Handle pending user injection before next turn
            if (_pendingInjection) {
                const injected = _pendingInjection;
                _pendingInjection = null;
                _addUserInjectionMessage(injected);
                _chatHistory.push({ speaker: 'user', text: injected });
            }

            const voiceKey  = _currentSlot === 'a' ? _voiceA : _voiceB;
            const provider  = _currentSlot === 'a' ? _providerA : _providerB;
            const voiceName = _voiceNames[voiceKey] || voiceKey;
            const llmLabel  = _llmDisplayName(provider);
            _setStatus(`${voiceName} (${llmLabel}) is thinking…`);

            try {
                const result = await _callTurnEndpoint();
                if (_stopRequested) break;

                // Use provider from response (handles fallback cases)
                const actualProvider = result.provider || provider;
                _addHaveAChatMessage(_currentSlot, actualProvider, voiceKey, result.response);
                _chatHistory.push({ speaker: _currentSlot, text: result.response });

                _turnCount++;

                // Alternate slot
                _currentSlot = _currentSlot === 'a' ? 'b' : 'a';
                _setStatus('');

                // After every complete round (both voices have spoken), pause and prompt
                if (_turnCount % 2 === 0) {
                    _isPaused = true;
                    _showRoundPrompt();
                    while (_isPaused && !_stopRequested) {
                        await _sleep(200);
                    }
                    if (_stopRequested) break;
                } else {
                    // Natural pause between turns within a round (shorter in banter mode)
                    await _sleep(_banterMode ? 900 : 1500);
                }

            } catch (err) {
                _setStatus(`Error: ${err.message} — conversation paused.`);
                _isPaused = true;
                _setPauseButtonLabel(true);
                console.error('[HaveAChat] Turn error:', err);
            }
        }

        if (!_stopRequested) stop();
    }

    // ── Public controls ──────────────────────────────────────────────────────
    function start() {
        _voiceA      = (_el('have-a-chat-voice-a')?.value)     || 'expert';
        _voiceB      = (_el('have-a-chat-voice-b')?.value)     || 'expert';
        _providerA   = (_el('have-a-chat-provider-a')?.value)  || 'claude';
        _providerB   = (_el('have-a-chat-provider-b')?.value)  || 'gemini';
        _banterMode  = (_el('have-a-chat-banter-mode')?.checked) || false;
        _allowExplicit = (_el('have-a-chat-allow-explicit')?.checked) || false;
        _topic       = (_el('have-a-chat-topic')?.value?.trim()) || '';
        _temperature = parseFloat(_el('have-a-chat-temperature')?.value || '0.7');
        _chatHistory   = [];
        _turnCount     = 0;
        _isRunning     = true;
        _isPaused      = false;
        _stopRequested = false;
        _pendingInjection = null;

        // Randomly decide who goes first
        _currentSlot = Math.random() < 0.5 ? 'a' : 'b';

        _closeSetupModal();
        _showControlBar();
        _disableChatForm(true);
        _setPauseButtonLabel(false);

        const firstVoice = _currentSlot === 'a' ? (_voiceNames[_voiceA] || _voiceA) : (_voiceNames[_voiceB] || _voiceB);
        const firstLLM   = _currentSlot === 'a' ? _providerA : _providerB;
        const firstLLMLabel = _llmDisplayName(firstLLM);
        _setStatus(`Starting — ${firstVoice} (${firstLLMLabel}) goes first…`);

        _loop();
    }

    function pause() {
        if (!_isRunning || _isPaused) return;
        _isPaused = true;
        _setPauseButtonLabel(true);
        _setStatus('Paused — click Resume to continue.');
    }

    function resume() {
        if (!_isRunning || !_isPaused) return;
        _hideRoundPrompt();
        _isPaused = false;
        _setPauseButtonLabel(false);
        _setStatus('Resuming…');
    }

    function stop() {
        _isRunning     = false;
        _isPaused      = false;
        _stopRequested = true;
        _hideControlBar();
        const prompt = _el('have-a-chat-round-prompt');
        if (prompt) prompt.style.display = 'none';
        _disableChatForm(false);
        _setStatus('');
        _syncContextStatusBar();
    }

    function injectComment() {
        if (!_isRunning) return;
        const modal = _el('have-a-chat-inject-modal');
        if (modal) modal.style.display = 'flex';
        const ta = _el('have-a-chat-inject-text');
        if (ta) { ta.value = ''; ta.focus(); }
    }

    function _submitInjection() {
        const textarea = _el('have-a-chat-inject-text');
        const text = textarea?.value?.trim();
        if (!text) return;
        _pendingInjection = text;
        _closeInjectModal();
        if (_isPaused) resume();
    }

    // ── Init: wire all DOM events ────────────────────────────────────────────
    function init() {
        const sidebarBtn = _el('have-a-chat-sidebar-btn');
        if (sidebarBtn) sidebarBtn.addEventListener('click', open);

        // Setup modal
        const closeSetup = _el('close-have-a-chat-setup-modal');
        if (closeSetup) closeSetup.addEventListener('click', _closeSetupModal);
        const cancelBtn = _el('have-a-chat-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', _closeSetupModal);

        // Temperature slider label
        const tempSlider  = _el('have-a-chat-temperature');
        const tempDisplay = _el('have-a-chat-temperature-display');
        if (tempSlider && tempDisplay) {
            tempSlider.addEventListener('input', () => {
                tempDisplay.textContent = parseFloat(tempSlider.value).toFixed(1);
            });
        }

        const startBtn = _el('have-a-chat-start-btn');
        if (startBtn) startBtn.addEventListener('click', start);

        const providerAEl = _el('have-a-chat-provider-a');
        const providerBEl = _el('have-a-chat-provider-b');
        if (providerAEl) {
            providerAEl.addEventListener('change', () => {
                providerAEl.dataset.userSelectedProvider = 'true';
            });
        }
        if (providerBEl) {
            providerBEl.addEventListener('change', () => {
                providerBEl.dataset.userSelectedProvider = 'true';
            });
        }

        // Control bar
        const pauseBtn  = _el('have-a-chat-pause-btn');
        const injectBtn = _el('have-a-chat-inject-btn');
        const stopBtn   = _el('have-a-chat-stop-btn');
        if (pauseBtn)  pauseBtn.addEventListener('click', () => _isPaused ? resume() : pause());
        if (injectBtn) injectBtn.addEventListener('click', injectComment);
        if (stopBtn)   stopBtn.addEventListener('click', stop);

        // Round-end prompt
        const continueBtn       = _el('have-a-chat-continue-btn');
        const injectRoundBtn    = _el('have-a-chat-inject-round-btn');
        const stopRoundBtn      = _el('have-a-chat-stop-round-btn');
        if (continueBtn)    continueBtn.addEventListener('click', () => {
            _hideRoundPrompt();
            resume();
        });
        if (injectRoundBtn) injectRoundBtn.addEventListener('click', () => {
            injectComment();
            // injectComment resumes automatically when the injection is submitted
        });
        if (stopRoundBtn)   stopRoundBtn.addEventListener('click', stop);

        // Inject comment modal
        const closeInject  = _el('close-have-a-chat-inject-modal');
        const injectCancel = _el('have-a-chat-inject-cancel-btn');
        const injectSubmit = _el('have-a-chat-inject-submit-btn');
        if (closeInject)  closeInject.addEventListener('click', _closeInjectModal);
        if (injectCancel) injectCancel.addEventListener('click', _closeInjectModal);
        if (injectSubmit) injectSubmit.addEventListener('click', _submitInjection);

        const injectText = _el('have-a-chat-inject-text');
        if (injectText) {
            injectText.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    _submitInjection();
                }
            });
        }
    }

    // ── Utility ──────────────────────────────────────────────────────────────
    function _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    return { init, open, start, pause, resume, stop, injectComment };
})();

// have-a-chat.js is deferred after app.js, so Modals.initAll() has already run.
// Self-initialize here instead.
HaveAChat.init();
