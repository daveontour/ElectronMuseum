'use strict';

window.__visitorAccess = window.__visitorAccess || { restricted: false };

function installVisitorFeatureGateCapture() {
    if (window.__visitorFeatureGateCaptureInstalled) return;
    window.__visitorFeatureGateCaptureInstalled = true;
    document.addEventListener(
        'click',
        function visitorFeatureGateCapture(e) {
            const t = e.target;
            const el = t && typeof t.closest === 'function' ? t.closest('[data-visitor-gate]') : null;
            if (!el) return;
            const va = window.__visitorAccess;
            if (!va || !va.restricted) return;
            const g = el.getAttribute('data-visitor-gate');
            let ok = true;
            if (g === 'messages_chat') ok = !!va.can_messages_chat;
            else if (g === 'emails') ok = !!va.can_emails;
            else if (g === 'contacts') ok = !!va.can_contacts;
            else if (g === 'relationship') ok = !!va.can_relationships;
            else if (g === 'sensitive_private') ok = !!va.can_sensitive_private;
            else return;
            if (!ok) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        },
        true
    );
}

const AppActions = {
    // [CONSTANTS.FUNCTION_NAMES.FirstFunction]: async () => { // getFacebookChatters
    //     UI.clearError();
    //     DOM.infoBox.classList.add('hidden');
    //     UI.setControlsEnabled(false);
    //     UI.showLoadingIndicator();
    //     try {
    //         const data = await ApiService.fetchFacebookChatters();
    //         let markdownText = '# Facebook Chat Statistics\n\n|Participant|Number of Messages|\n|-----|---|\n';
    //         for (const message of Object.values(data)) { // Iterate over values if data is an object
    //             markdownText += `| ${message.participant[0].name} |${message.number_of_messages}|\n`;
    //         }
    //         Chat.addMessage('assistant', markdownText, true);
    //     } catch (error) {
    //         console.error('Error in getFacebookChatters:', error);
    //         UI.displayError("Failed to get FB chatters: " + error.message);
    //     } finally {
    //         UI.setControlsEnabled(true);
    //         UI.hideLoadingIndicator();
    //     }
    // },
    ["showFBAlbumsOptions"]: () => Modals.FBAlbums.open(),    // showFBAlbumsOptions
    ["openGeoModal"]: () => Modals.Locations.open(), // showGeoMetadataOptions
    ["showEmailGallery"]: () => Modals.EmailGallery.open(), // showEmailGalleryOptions
    //[CONSTANTS.FUNCTION_NAMES.FifthFunction]: () => SSE.browserFunctions.showLocationInfo(), // showTileAlbumOptions
    ["showImageGallery"]: () => Modals.ImageGallery.open(),
    //[CONSTANTS.FUNCTION_NAMES.SeventhFunction]: () => SSE.browserFunctions.testEmail(), // showImageGalleryOptions
 // showEmailGalleryOptions
    ["listContacts"]: () => Modals.Contacts.open(),

};
window.customObject = AppActions; // Expose for Suggestions.json if it relies on global `customObject`


const App = (() => {
    async function getLLMProviderAvailabilityPair() {
        try {
            const res = await fetch('/chat/availability', { credentials: 'same-origin' });
            if (!res.ok) return { gemini: true, claude: true, deepseek: true, localai: false };
            const av = await res.json();
            return {
                gemini: !!av.gemini_available,
                claude: !!av.claude_available,
                deepseek: !!av.deepseek_available,
                localai: !!av.localai_available
            };
        } catch (e) {
            return { gemini: true, claude: true, deepseek: true, localai: false };
        }
    }

    function otherLLMProvider(p) {
        if (p === 'localai') return 'gemini';
        if (p === 'gemini') return 'claude';
        if (p === 'claude') return 'gemini';
        if (p === 'deepseek') return 'gemini';
        return 'gemini';
    }

    async function postJsonChatEndpoint(url, payload) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            credentials: 'same-origin'
        });
        let data = null;
        try {
            data = await res.json();
        } catch (e) {
            return { ok: false, error: 'Could not read response', httpStatus: res.status };
        }
        const detail = data && (data.detail || data.error);
        if (!res.ok) {
            return { ok: false, data, error: detail ? String(detail) : `HTTP ${res.status}`, httpStatus: res.status };
        }
        if (data && data.error) {
            return { ok: false, data, error: String(data.error) };
        }
        return { ok: true, data };
    }

    /** On LLM error, retry once with the other provider if it is available; update AI Provider selector on success.
     *  LocalAI is never used as an automatic failover target, and selecting it disables cloud failover
     *  (the user explicitly chose a local model and should not be silently routed to a cloud provider). */
    async function runChatWithProviderFailover(url, buildPayload) {
        const select = typeof DOM !== 'undefined' ? DOM.llmProviderSelect : null;
        const primary = (select && select.value) ? select.value : 'gemini';
        const first = await postJsonChatEndpoint(url, buildPayload(primary));
        if (first.ok) {
            return { ok: true, data: first.data, switched: false };
        }
        // Never failover away from an explicitly chosen local provider.
        if (primary === 'localai') {
            return { ok: false, error: first.error || 'Local AI request failed', data: first.data };
        }
        const alt = otherLLMProvider(primary);
        // Also never failover TO localai automatically.
        if (alt === 'localai') {
            return { ok: false, error: first.error || 'Request failed', data: first.data };
        }
        const av = await getLLMProviderAvailabilityPair();
        const altAvailable = alt === 'gemini' ? av.gemini : alt === 'claude' ? av.claude : alt === 'deepseek' ? av.deepseek : false;
        if (!altAvailable) {
            return { ok: false, error: first.error || 'Request failed', data: first.data };
        }
        if (typeof UI !== 'undefined' && UI.setChatProviderFailoverNotice) {
            UI.setChatProviderFailoverNotice(primary, alt);
        }
        if (select) select.value = alt;
        const second = await postJsonChatEndpoint(url, buildPayload(alt));
        if (second.ok) {
            return { ok: true, data: second.data, switched: true };
        }
        if (select) select.value = primary;
        if (typeof UI !== 'undefined' && UI.clearChatProviderFailoverNotice) {
            UI.clearChatProviderFailoverNotice();
        }
        return { ok: false, error: second.error || first.error || 'Request failed', data: second.data };
    }

    async function processFormSubmit(userPrompt, category = null, title = null, supplementary_prompt = null) {
        if (!userPrompt && !category && !title) return;

 //       Check and show reference documents notification before proceeding
        await Modals.ReferenceDocumentsNotification.checkAndShow(async () => {
            // This callback is called when user proceeds
            UI.clearError();
            UI.setControlsEnabled(false);
            UI.showLoadingIndicator();

            const selectedVoice = VoiceSelector.getSelectedVoice();
            const selectedMood = (selectedVoice === 'owner' && DOM.ownerMood) ? DOM.ownerMood.value : null;
            
            try {
                const finalMessage = UI.getWorkModePrefix() + userPrompt;

                if (category && title) Chat.addMessage('suggestion', `**${category}:** ${title}`, true);
                else Chat.addMessage('user', userPrompt, false); // User messages are not markdown by default
                
                DOM.userInput.value = '';

                const currentUserId = localStorage.getItem('userId') || 'default';
                // Get current conversation ID if available
                const conversationId = Modals.ConversationManager ? Modals.ConversationManager.getCurrentConversationId() : null;
                
                const itsMeVisitorSwitch = document.getElementById('its-me-visitor-switch');
                const whosAsking = itsMeVisitorSwitch?.querySelector('.its-me-visitor-option.active')?.dataset?.value || 'visitor';

                const result = await runChatWithProviderFailover(CONSTANTS.API_PATHS.CHAT, (provider) => ({
                    prompt: finalMessage,
                    voice: selectedVoice,
                    mood: selectedMood,
                    companionMode: DOM.companionModeCheckbox ? DOM.companionModeCheckbox.checked : false,
                    allowExplicitContent: DOM.allowExplicitContentCheckbox ? DOM.allowExplicitContentCheckbox.checked : false,
                    supplementary_prompt: supplementary_prompt,
                    temperature: parseFloat(DOM.creativityLevel ? DOM.creativityLevel.value : '0'),
                    conversation_id: conversationId,
                    clientId: AppState.clientId,
                    userId: currentUserId,
                    provider,
                    whos_asking: whosAsking,
                }));

                UI.hideLoadingIndicator();
                if (!result.ok) {
                    UI.displayError(result.error || 'Request failed.');
                } else {
                    const data = result.data;
                    Chat.addMessage('assistant', data.response, true, null, data.embedded_json);
                    if (typeof UI !== 'undefined' && UI.setChatLastRequestStatsFromEmbedded) {
                        UI.setChatLastRequestStatsFromEmbedded(data.embedded_json);
                    }
                }

            } catch (error) {
                console.error('Form submit error:', error);
                UI.displayError(error.message || 'An unknown error occurred.');
                // UI.hideLoadingIndicator(); // Already handled in displayError or finally
            } finally {
                UI.setControlsEnabled(true);
                UI.hideLoadingIndicator(); // Ensure it's hidden
            }
        });
    }
    async function processQuestionSubmit() {
        
        var userPrompt = CONSTANTS.RANDOM_QUESTION_PROMPT;
        var title = "Generate a random question about " + CONSTANTS.OWNER_NAME + "'s life.";

        if (!userPrompt && !category && !title) return;

        // Check and show reference documents notification before proceeding
        await Modals.ReferenceDocumentsNotification.checkAndShow(async () => {
            // This callback is called when user proceeds
            UI.clearError();
            UI.setControlsEnabled(false);
            UI.showLoadingIndicator();

            const selectedVoice = VoiceSelector.getSelectedVoice();
            const selectedMood = (selectedVoice === 'owner' && DOM.ownerMood) ? DOM.ownerMood.value : null;
            
            try {
                const finalMessage = UI.getWorkModePrefix() + userPrompt;

                Chat.addMessage('suggestion', `**Random Question:** ${title}`, true); // User messages are not markdown by default
                
                DOM.userInput.value = '';

                const currentUserId = localStorage.getItem('userId') || 'default';
                // Get current conversation ID if available
                const conversationId = Modals.ConversationManager ? Modals.ConversationManager.getCurrentConversationId() : null;
                
                const itsMeVisitorSwitch = document.getElementById('its-me-visitor-switch');
                const whosAsking = itsMeVisitorSwitch?.querySelector('.its-me-visitor-option.active')?.dataset?.value || 'visitor';

                const result = await runChatWithProviderFailover(CONSTANTS.API_PATHS.RANDOM_QUESTION, (provider) => ({
                    prompt: finalMessage,
                    voice: selectedVoice,
                    mood: selectedMood,
                    companionMode: false,
                    allowExplicitContent: DOM.allowExplicitContentCheckbox ? DOM.allowExplicitContentCheckbox.checked : false,
                    provider,
                    whos_asking: whosAsking,
                }));

                UI.hideLoadingIndicator();
                if (!result.ok) {
                    UI.displayError(result.error || 'Request failed.');
                } else {
                    const data = result.data;
                    Chat.addMessage('assistant', data.response, true, null, data.embedded_json);
                    if (typeof UI !== 'undefined' && UI.setChatLastRequestStatsFromEmbedded) {
                        UI.setChatLastRequestStatsFromEmbedded(data.embedded_json);
                    }
                }

            } catch (error) {
                console.error('Form submit error:', error);
                UI.displayError(error.message || 'An unknown error occurred.');
                // UI.hideLoadingIndicator(); // Already handled in displayError or finally
            } finally {
                UI.setControlsEnabled(true);
                UI.hideLoadingIndicator(); // Ensure it's hidden
            }
        });
    }
    async function processAnswerSubmit(userPrompt) {


        // Check and show reference documents notification before proceeding
        await Modals.ReferenceDocumentsNotification.checkAndShow(async () => {
            // This callback is called when user proceeds
            UI.clearError();
            UI.setControlsEnabled(false);
            UI.showLoadingIndicator();

            const selectedVoice = VoiceSelector.getSelectedVoice();
            const selectedMood = (selectedVoice === 'owner' && DOM.ownerMood) ? DOM.ownerMood.value : null;
            
            try {
                const finalMessage = UI.getWorkModePrefix() + userPrompt;

                const category = "Answer";
                const title = "Answer the question";

                if (category && title) Chat.addMessage('suggestion', `**${category}:** ${title}`, true);
                else Chat.addMessage('user', userPrompt, false); // User messages are not markdown by default
                
                DOM.userInput.value = '';

                const currentUserId = localStorage.getItem('userId') || 'default';
                // Get current conversation ID if available
                const conversationId = Modals.ConversationManager ? Modals.ConversationManager.getCurrentConversationId() : null;
                
                const itsMeVisitorSwitch = document.getElementById('its-me-visitor-switch');
                const whosAsking = itsMeVisitorSwitch?.querySelector('.its-me-visitor-option.active')?.dataset?.value || 'visitor';

                const result = await runChatWithProviderFailover(CONSTANTS.API_PATHS.CHAT, (provider) => ({
                    prompt: finalMessage,
                    voice: selectedVoice,
                    mood: selectedMood,
                    companionMode: false,
                    allowExplicitContent: DOM.allowExplicitContentCheckbox ? DOM.allowExplicitContentCheckbox.checked : false,
                    temperature: parseFloat(DOM.creativityLevel ? DOM.creativityLevel.value : '0'),
                    conversation_id: conversationId,
                    clientId: AppState.clientId,
                    userId: currentUserId,
                    provider,
                    whos_asking: whosAsking,
                    repeat_question: true,
                }));

                UI.hideLoadingIndicator();
                if (!result.ok) {
                    UI.displayError(result.error || 'Request failed.');
                } else {
                    const data = result.data;
                    Chat.addMessage('assistant', data.response, true, null, data.embedded_json);
                    if (typeof UI !== 'undefined' && UI.setChatLastRequestStatsFromEmbedded) {
                        UI.setChatLastRequestStatsFromEmbedded(data.embedded_json);
                    }
                }

            } catch (error) {
                console.error('Form submit error:', error);
                UI.displayError(error.message || 'An unknown error occurred.');
                // UI.hideLoadingIndicator(); // Already handled in displayError or finally
            } finally {
                UI.setControlsEnabled(true);
                UI.hideLoadingIndicator(); // Ensure it's hidden
            }
        });
    }

    /** True only when the owner master key was used for this session (visitor unlock does not count). */
    async function fetchMasterUnlockedForDataImport() {
        try {
            const st = await fetch('/api/session/master-key/status', { credentials: 'same-origin' });
            if (!st.ok) return false;
            const sj = await st.json();
            return !!sj.master_unlocked;
        } catch (e) {
            return false;
        }
    }

    /** True when the session has any keyring unlock (master or visitor). */
    async function fetchSessionKeyringUnlocked() {
        try {
            const st = await fetch('/api/session/master-key/status', { credentials: 'same-origin' });
            if (!st.ok) return false;
            const sj = await st.json();
            return !!sj.unlocked;
        } catch (e) {
            return false;
        }
    }

    async function ensureMasterKeyForDataImport() {
        if (await fetchMasterUnlockedForDataImport()) return true;
        if (typeof Modals !== 'undefined' && Modals.ConfirmationModal && Modals.ConfirmationModal.open) {
            Modals.ConfirmationModal.open(
                'Owner master key required',
                'Data Import requires the owner master key. Use Unlock Encryption and choose Unlock with Master Key (a visitor key is not enough).',
                () => {
                    const m = document.getElementById('master-key-unlock-modal');
                    if (m) {
                        m.style.display = 'flex';
                        const inp = document.getElementById('master-key-unlock-input');
                        if (inp) inp.focus();
                    }
                }
            );
        } else if (typeof AppDialogs !== 'undefined' && AppDialogs.showAppAlert) {
            await AppDialogs.showAppAlert('Unlock with the owner master key before opening Data Import (visitor key is not sufficient).');
        }
        return false;
    }

    function refreshDataImportMasterKeyAccessUI() {
        void (async () => {
            const [masterOk, keyringUnlocked] = await Promise.all([
                fetchMasterUnlockedForDataImport(),
                fetchSessionKeyringUnlocked(),
            ]);
            const sidebarBtn = document.getElementById('data-import-sidebar-btn');
            const sensitiveSidebarBtn = document.getElementById('sensitive-data-sidebar-btn');
            const tiles = document.querySelectorAll('.import-data-dialog-tile[data-open-modal="data-import-modal"]');
            if (sidebarBtn) {
                sidebarBtn.style.display = masterOk ? '' : 'none';
                sidebarBtn.disabled = false;
                sidebarBtn.title = masterOk ? '' : 'Owner master key required — use Unlock with Master Key (visitor key is not enough).';
                sidebarBtn.style.opacity = '';
                sidebarBtn.style.cursor = '';
            }
            if (sensitiveSidebarBtn) {
                sensitiveSidebarBtn.style.display = keyringUnlocked ? '' : 'none';
            }
            tiles.forEach((tile) => {
                if (masterOk) {
                    tile.classList.remove('data-import-entry-blocked');
                    tile.removeAttribute('aria-disabled');
                    if (tile.hasAttribute('data-title-when-unlocked')) {
                        const orig = tile.getAttribute('data-title-when-unlocked');
                        tile.title = orig || 'Click to open';
                    }
                } else {
                    tile.classList.add('data-import-entry-blocked');
                    tile.setAttribute('aria-disabled', 'true');
                    if (!tile.hasAttribute('data-title-when-unlocked')) {
                        tile.setAttribute('data-title-when-unlocked', tile.getAttribute('title') || 'Click to open');
                    }
                    tile.title = 'Owner master key required for Data Import (visitor key is not enough).';
                }
            });

            // Settings & Data Import modal: without owner master unlock, only Settings tab is available.
            const configOverlay = document.getElementById('config-modal-overlay');
            if (configOverlay) {
                configOverlay.classList.toggle('config-modal-master-unlock-required', !masterOk);
            }
            document.querySelectorAll('.config-sidebar-requires-master').forEach((el) => {
                el.style.display = masterOk ? '' : 'none';
            });
            if (!masterOk) {
                document.querySelectorAll('.config-tab-button').forEach((btn) => btn.classList.remove('active'));
                document.querySelectorAll('.config-tab-content').forEach((c) => c.classList.remove('active'));
                const settingsBtn = document.querySelector('.config-tab-button[data-tab="settings"]');
                const settingsTab = document.getElementById('settings-tab');
                if (settingsBtn) settingsBtn.classList.add('active');
                if (settingsTab) settingsTab.classList.add('active');
            }
        })();
    }

    function initEventListeners() {
        if (typeof CONSTANTS !== 'undefined' && CONSTANTS.DEPLOYMENT_NATURE_LOCAL !== 'True') {
            document.body.classList.add('deployment-hide-path-import-tiles');
        }

        function refreshSettingsDataImportModalLLM() {
            if (typeof Modals !== 'undefined' && Modals.UserLLMSettings && Modals.UserLLMSettings.load) {
                void Modals.UserLLMSettings.load();
            }
            void loadLLMProviderAvailability();
        }
        window.refreshSettingsDataImportModalLLM = refreshSettingsDataImportModalLLM;

        /** Set by loadArchiveOverviewLLMStatus when /auth/me succeeded and no LLM provider is available. */
        let archiveOverviewMeForKeys = null;

        DOM.chatForm.addEventListener('submit', (event) => {
            event.preventDefault();
            if (typeof InterviewerMode !== 'undefined' && InterviewerMode.isActive()) return;
            const userPrompt = DOM.userInput.value.trim();
            if (!userPrompt) return;
            processFormSubmit(userPrompt);
        });
        
        DOM.userInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                // dispatchEvent on form seems more robust than calling submit() directly
                DOM.chatForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            }
        });

        const chatMessagesVisToggle = document.getElementById('chat-messages-visibility-toggle');
        const chatBoxWrapper = document.querySelector('.chat-box-wrapper');
        if (chatMessagesVisToggle && chatBoxWrapper && DOM.chatBox) {
            const icon = chatMessagesVisToggle.querySelector('i');
            const applyMessagesHidden = (hidden) => {
                chatBoxWrapper.classList.toggle('chat-pane-messages-hidden', hidden);
                chatMessagesVisToggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
                chatMessagesVisToggle.title = hidden ? 'Show messages' : 'Hide messages to see background';
                chatMessagesVisToggle.setAttribute('aria-label', hidden ? 'Show chat messages' : 'Hide chat messages');
                if (icon) {
                    icon.className = hidden ? 'fas fa-eye' : 'fas fa-eye-slash';
                }
            };
            chatMessagesVisToggle.addEventListener('click', () => {
                applyMessagesHidden(!chatBoxWrapper.classList.contains('chat-pane-messages-hidden'));
            });
            applyMessagesHidden(false);
        }

        // It's Me / Visitor switch - visual toggle only (no mode-change handler yet)
        const itsMeVisitorSwitch = document.getElementById('its-me-visitor-switch');
        if (itsMeVisitorSwitch) {
            itsMeVisitorSwitch.querySelectorAll('.its-me-visitor-option').forEach(opt => {
                opt.addEventListener('click', () => {
                    itsMeVisitorSwitch.querySelectorAll('.its-me-visitor-option').forEach(o => o.classList.remove('active'));
                    opt.classList.add('active');
                    itsMeVisitorSwitch.setAttribute('aria-checked', opt.dataset.value === 'its-me');
                });
            });
        }

        // Hamburger menu for config page (guard — if these elements are missing, do not skip the rest of init)
        if (DOM.hamburgerMenu && DOM.configPage) {
            DOM.hamburgerMenu.addEventListener('click', () => {
                DOM.configPage.style.display = 'flex';
                loadControlDefaults();
                refreshSettingsDataImportModalLLM();
            });
        }
        if (DOM.closeConfigBtn && DOM.configPage) {
            DOM.closeConfigBtn.addEventListener('click', () => {
                DOM.configPage.style.display = 'none';
            });
        }
        if (DOM.configPage) {
            DOM.configPage.addEventListener('click', (e) => {
                if (e.target === DOM.configPage) DOM.configPage.style.display = 'none';
            });
        }

        // Voice settings modal (opened by clicking voice image)
        if (DOM.voiceSettingsTrigger) {
            DOM.voiceSettingsTrigger.addEventListener('click', () => {
                if (DOM.voiceSettingsModal) DOM.voiceSettingsModal.style.display = 'flex';
            });
        }
        if (DOM.closeVoiceSettingsBtn) {
            DOM.closeVoiceSettingsBtn.addEventListener('click', () => {
                if (DOM.voiceSettingsModal) DOM.voiceSettingsModal.style.display = 'none';
            });
        }
        if (DOM.voiceSettingsModal) {
            DOM.voiceSettingsModal.addEventListener('click', (e) => {
                if (e.target === DOM.voiceSettingsModal) DOM.voiceSettingsModal.style.display = 'none';
            });
        }
        if (DOM.clearVoiceConversationHistoryBtn) {
            DOM.clearVoiceConversationHistoryBtn.addEventListener('click', async () => {
                if (Modals.ConversationManager && Modals.ConversationManager.clearCurrentConversationHistoryWithConfirm) {
                    await Modals.ConversationManager.clearCurrentConversationHistoryWithConfirm();
                }
            });
        }

        // Guide modal
        const guideModal = document.getElementById('guide-modal');
        const guideSidebarBtn = document.getElementById('guide-sidebar-btn');
        const closeGuideModalBtn = document.getElementById('close-guide-modal');
        if (guideSidebarBtn && guideModal) {
            guideSidebarBtn.addEventListener('click', () => {
                const topicsContainer = document.getElementById('guide-topics-list');
                if (typeof Guide !== 'undefined' && Guide.renderTopicList && topicsContainer && !topicsContainer.querySelector('.guide-topic-btn')) {
                    try { Guide.renderTopicList(); } catch (_) {}
                }
                if (typeof Guide !== 'undefined' && Guide.openGuideModal) Guide.openGuideModal();
                else guideModal.style.display = 'flex';
            });
        }
        const closeGuideModal = () => {
            if (typeof Guide !== 'undefined' && Guide.closeAll) Guide.closeAll();
            else guideModal.style.display = 'none';
        };
        if (closeGuideModalBtn && guideModal) {
            closeGuideModalBtn.addEventListener('click', closeGuideModal);
        }
        if (guideModal) {
            guideModal.addEventListener('click', (e) => {
                if (e.target === guideModal) closeGuideModal();
            });
        }
        if (guideModal) {
            guideModal.addEventListener('click', (e) => {
                const btn = e.target && e.target.closest ? e.target.closest('.guide-topic-btn') : null;
                if (!btn) return;
                e.stopPropagation();
                const topic = btn.dataset.topic || '';
                if (typeof Guide !== 'undefined' && Guide.onTopicSelected) {
                    Guide.onTopicSelected(topic, btn);
                }
            });
        }

        // Load control defaults from API
        let controlDefaults = {};
        let controlDefaultsListenersSetup = false;
        
        async function loadControlDefaults() {
            try {
                const response = await fetch('/api/control-defaults');
                if (response.ok) {
                    controlDefaults = await response.json();
                    populateControlDefaults();
                    if (!controlDefaultsListenersSetup) {
                        setupControlDefaultsListeners();
                        controlDefaultsListenersSetup = true;
                    }
                }
            } catch (error) {
                console.error('Error loading control defaults:', error);
            }
        }

        // Helper function to get value from localStorage or defaults
        function getControlValue(key, defaultValue) {
            const stored = localStorage.getItem(`control_defaults_${key}`);
            if (stored !== null) {
                // Try to parse as boolean or number, otherwise return as string
                if (stored === 'true') return true;
                if (stored === 'false') return false;
                if (!isNaN(stored) && stored !== '') return stored; // Return as string for numbers
                return stored;
            }
            return defaultValue;
        }

        // Helper function to save value to localStorage
        function saveControlValue(key, value) {
            if (value === null || value === undefined) {
                localStorage.removeItem(`control_defaults_${key}`);
            } else {
                localStorage.setItem(`control_defaults_${key}`, String(value));
            }
        }

        // Populate control inputs with localStorage values (preferred) or defaults
        function populateControlDefaults() {
            // Email Controls
            const processAllFoldersCheckbox = document.getElementById('process-all-folders');
            const newOnlyOption = document.getElementById('new-only-option');
            if (processAllFoldersCheckbox) {
                const value = getControlValue('process_all_folders', controlDefaults.process_all_folders);
                if (value !== undefined && value !== null) {
                    processAllFoldersCheckbox.checked = value === true || value === 'true';
                }
            }
            if (newOnlyOption) {
                const value = getControlValue('new_only_option', controlDefaults.new_only_option);
                if (value !== undefined && value !== null) {
                    newOnlyOption.checked = value === true || value === 'true';
                }
            }

            // WhatsApp Import
            const whatsappImportDirectory = document.getElementById('whatsapp-import-directory');
            if (whatsappImportDirectory) {
                const value = getControlValue('whatsapp_import_directory', controlDefaults.whatsapp_import_directory);
                if (value) {
                    whatsappImportDirectory.value = value;
                }
            }

            // Facebook Messenger Import
            const facebookImportDirectory = document.getElementById('facebook-import-directory');
            const facebookUserName = document.getElementById('facebook-user-name');
            if (facebookImportDirectory) {
                const value = getControlValue('facebook_import_directory', controlDefaults.facebook_import_directory);
                if (value) {
                    facebookImportDirectory.value = value;
                }
            }
            if (facebookUserName) {
                const value = getControlValue('facebook_user_name', controlDefaults.facebook_user_name);
                if (value) {
                    facebookUserName.value = value;
                }
            }

            // Instagram Import
            const instagramImportDirectory = document.getElementById('instagram-import-directory');
            const instagramUserName = document.getElementById('instagram-user-name');
            if (instagramImportDirectory) {
                const value = getControlValue('instagram_import_directory', controlDefaults.instagram_import_directory);
                if (value) {
                    instagramImportDirectory.value = value;
                }
            }
            if (instagramUserName) {
                const value = getControlValue('instagram_user_name', controlDefaults.instagram_user_name);
                if (value) {
                    instagramUserName.value = value;
                }
            }

            // iMessage Import
            const imessageDirectoryPath = document.getElementById('imessage-directory-path');
            if (imessageDirectoryPath) {
                const value = getControlValue('imessage_directory_path', controlDefaults.imessage_directory_path);
                if (value) {
                    imessageDirectoryPath.value = value;
                }
            }

            // Facebook Albums Import
            const facebookAlbumsImportDirectory = document.getElementById('facebook-albums-import-directory');
            if (facebookAlbumsImportDirectory) {
                const value = getControlValue('facebook_albums_import_directory', controlDefaults.facebook_albums_import_directory);
                if (value) {
                    facebookAlbumsImportDirectory.value = value;
                }
            }

            // Filesystem Image Import
            const filesystemImportDirectory = document.getElementById('filesystem-import-directory');
            const filesystemImportMaxImages = document.getElementById('filesystem-import-max-images');
            if (filesystemImportDirectory) {
                const value = getControlValue('filesystem_import_directory', controlDefaults.filesystem_import_directory);
                if (value) {
                    filesystemImportDirectory.value = value;
                }
            }
            if (filesystemImportMaxImages) {
                const value = getControlValue('filesystem_import_max_images', controlDefaults.filesystem_import_max_images);
                if (value) {
                    filesystemImportMaxImages.value = value;
                }
            }
        }

        // Setup event listeners to save changes to localStorage
        function setupControlDefaultsListeners() {
            // Email Controls
            const processAllFoldersCheckbox = document.getElementById('process-all-folders');
            const newOnlyOption = document.getElementById('new-only-option');
            if (processAllFoldersCheckbox) {
                processAllFoldersCheckbox.addEventListener('change', (e) => {
                    saveControlValue('process_all_folders', e.target.checked);
                });
            }
            if (newOnlyOption) {
                newOnlyOption.addEventListener('change', (e) => {
                    saveControlValue('new_only_option', e.target.checked);
                });
            }

            // WhatsApp Import
            const whatsappImportDirectory = document.getElementById('whatsapp-import-directory');
            if (whatsappImportDirectory) {
                whatsappImportDirectory.addEventListener('change', (e) => {
                    saveControlValue('whatsapp_import_directory', e.target.value);
                });
                whatsappImportDirectory.addEventListener('blur', (e) => {
                    saveControlValue('whatsapp_import_directory', e.target.value);
                });
            }

            // Facebook Messenger Import
            const facebookImportDirectory = document.getElementById('facebook-import-directory');
            const facebookUserName = document.getElementById('facebook-user-name');
            if (facebookImportDirectory) {
                facebookImportDirectory.addEventListener('change', (e) => {
                    saveControlValue('facebook_import_directory', e.target.value);
                });
                facebookImportDirectory.addEventListener('blur', (e) => {
                    saveControlValue('facebook_import_directory', e.target.value);
                });
            }
            if (facebookUserName) {
                facebookUserName.addEventListener('change', (e) => {
                    saveControlValue('facebook_user_name', e.target.value);
                });
                facebookUserName.addEventListener('blur', (e) => {
                    saveControlValue('facebook_user_name', e.target.value);
                });
            }

            // Instagram Import
            const instagramImportDirectory = document.getElementById('instagram-import-directory');
            const instagramUserName = document.getElementById('instagram-user-name');
            if (instagramImportDirectory) {
                instagramImportDirectory.addEventListener('change', (e) => {
                    saveControlValue('instagram_import_directory', e.target.value);
                });
                instagramImportDirectory.addEventListener('blur', (e) => {
                    saveControlValue('instagram_import_directory', e.target.value);
                });
            }
            if (instagramUserName) {
                instagramUserName.addEventListener('change', (e) => {
                    saveControlValue('instagram_user_name', e.target.value);
                });
                instagramUserName.addEventListener('blur', (e) => {
                    saveControlValue('instagram_user_name', e.target.value);
                });
            }

            // iMessage Import
            const imessageDirectoryPath = document.getElementById('imessage-directory-path');
            if (imessageDirectoryPath) {
                imessageDirectoryPath.addEventListener('change', (e) => {
                    saveControlValue('imessage_directory_path', e.target.value);
                });
                imessageDirectoryPath.addEventListener('blur', (e) => {
                    saveControlValue('imessage_directory_path', e.target.value);
                });
            }

            // Facebook Albums Import
            const facebookAlbumsImportDirectory = document.getElementById('facebook-albums-import-directory');
            if (facebookAlbumsImportDirectory) {
                facebookAlbumsImportDirectory.addEventListener('change', (e) => {
                    saveControlValue('facebook_albums_import_directory', e.target.value);
                });
                facebookAlbumsImportDirectory.addEventListener('blur', (e) => {
                    saveControlValue('facebook_albums_import_directory', e.target.value);
                });
            }

            // Filesystem Image Import
            const filesystemImportDirectory = document.getElementById('filesystem-import-directory');
            const filesystemImportMaxImages = document.getElementById('filesystem-import-max-images');
            if (filesystemImportDirectory) {
                filesystemImportDirectory.addEventListener('change', (e) => {
                    saveControlValue('filesystem_import_directory', e.target.value);
                });
                filesystemImportDirectory.addEventListener('blur', (e) => {
                    saveControlValue('filesystem_import_directory', e.target.value);
                });
            }
            if (filesystemImportMaxImages) {
                filesystemImportMaxImages.addEventListener('change', (e) => {
                    saveControlValue('filesystem_import_max_images', e.target.value);
                });
                filesystemImportMaxImages.addEventListener('blur', (e) => {
                    saveControlValue('filesystem_import_max_images', e.target.value);
                });
            }
        }

        // Load defaults when config page opens
        const configBtn = document.getElementById('config-btn');
        if (configBtn) {
            configBtn.addEventListener('click', () => {
                loadControlDefaults();
            });
        }

        // Config tab switching
        const configTabButtons = document.querySelectorAll('.config-tab-button');
        const configTabContents = document.querySelectorAll('.config-tab-content');
        
        configTabButtons.forEach(button => {
            button.addEventListener('click', () => {
                if (button.classList.contains('config-sidebar-requires-master')) {
                    const st = window.getComputedStyle(button);
                    if (st.display === 'none' || st.visibility === 'hidden') return;
                }
                const targetTab = button.getAttribute('data-tab');
                
                // Remove active class from all buttons and contents
                configTabButtons.forEach(btn => btn.classList.remove('active'));
                configTabContents.forEach(content => content.classList.remove('active'));
                
                // Add active class to clicked button and corresponding content
                button.classList.add('active');
                const targetContent = document.getElementById(`${targetTab}-tab`);
                    if (targetContent) {
                    targetContent.classList.add('active');
                }
                
                // Load email matches and classifications when Manage Contacts tab is opened
                if (targetTab === 'manage-contacts') {
                    if (Modals.EmailMatches && Modals.EmailMatches.load) Modals.EmailMatches.load();
                    if (Modals.EmailClassifications && Modals.EmailClassifications.load) Modals.EmailClassifications.load();
                    if (Modals.EmailExclusions && Modals.EmailExclusions.load) Modals.EmailExclusions.load();
                }
                // Load subject configuration when Subject Configuration tab is opened
                if (targetTab === 'subject-configuration') {
                    if (Modals.SubjectConfiguration && Modals.SubjectConfiguration.loadAndPopulateForm) {
                        Modals.SubjectConfiguration.loadAndPopulateForm();
                    }
                    if (Modals.Interests && Modals.Interests.load) Modals.Interests.load();
                }
                if (targetTab === 'custom-voices') {
                    if (Modals.CustomVoices && Modals.CustomVoices.load) Modals.CustomVoices.load();
                }
                if (targetTab === 'tools-access') {
                    if (Modals.LLMToolsAccess && Modals.LLMToolsAccess.load) void Modals.LLMToolsAccess.load();
                }
                if (targetTab === 'background-jobs') {
                    if (Modals.BackgroundJobs && Modals.BackgroundJobs.load) void Modals.BackgroundJobs.load();
                }
                if (targetTab === 'settings') {
                    if (Modals.UserLLMSettings && Modals.UserLLMSettings.load) void Modals.UserLLMSettings.load();
                    void loadLLMProviderAvailability();
                }
            });
        });

        function openReferenceDocumentsManageModalFromUI() {
            const modal = document.getElementById('reference-documents-manage-modal');
            if (!modal) return;
            modal.style.display = 'flex';
            const dataImportModalEl = document.getElementById('data-import-modal');
            if (dataImportModalEl) dataImportModalEl.style.display = 'none';
            if (Modals.ReferenceDocuments && Modals.ReferenceDocuments.loadDocuments) {
                Modals.ReferenceDocuments.loadDocuments();
            }
        }

        async function openConfigurationToTab(tabName) {
            if (!DOM.configPage) return;
            DOM.configPage.style.display = 'flex';
            if (typeof loadControlDefaults === 'function') {
                await loadControlDefaults();
            }
            const tabBtn = document.querySelector(`.config-tab-button[data-tab="${tabName}"]`);
            if (tabBtn) tabBtn.click();
            if (typeof refreshSettingsDataImportModalLLM === 'function') refreshSettingsDataImportModalLLM();
        }

        async function onChatStatusBarConfigClick(tabName) {
            if (!(await fetchMasterUnlockedForDataImport())) {
                await ensureMasterKeyForDataImport();
                return;
            }
            await openConfigurationToTab(tabName);
        }

        async function onChatStatusBarRefsClick() {
            if (!(await fetchMasterUnlockedForDataImport())) {
                await ensureMasterKeyForDataImport();
                return;
            }
            openReferenceDocumentsManageModalFromUI();
        }

        const chatStatusToolsSeg = document.getElementById('chat-context-status-tools-seg');
        const chatStatusRefsSeg = document.getElementById('chat-context-status-refs-seg');
        if (chatStatusToolsSeg) {
            chatStatusToolsSeg.addEventListener('click', (e) => {
                e.preventDefault();
                void onChatStatusBarConfigClick('tools-access');
            });
            chatStatusToolsSeg.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void onChatStatusBarConfigClick('tools-access');
                }
            });
        }
        if (chatStatusRefsSeg) {
            chatStatusRefsSeg.addEventListener('click', (e) => {
                e.preventDefault();
                void onChatStatusBarRefsClick();
            });
            chatStatusRefsSeg.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void onChatStatusBarRefsClick();
                }
            });
        }

        // Manage Contacts inner tabs: switch table (Email Matches / Exclusions / Classifications)
        document.querySelectorAll('.manage-contacts-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabName = btn.getAttribute('data-manage-contacts-tab');
                if (!tabName) return;
                const container = document.getElementById('manage-contacts-tab');
                if (!container) return;
                container.querySelectorAll('.manage-contacts-tab-btn').forEach(b => b.classList.remove('active'));
                container.querySelectorAll('.manage-contacts-tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const content = document.getElementById(`${tabName}-tab-content`);
                if (content) content.classList.add('active');
            });
        });

        // Dashboard: load stats and render. prefix: '' for config modal, 'stats-' for Statistics modal
        async function loadDashboard(prefix) {
            prefix = prefix || '';
            const includeCharts = prefix !== 'overview-';
            const container = document.getElementById(prefix + 'dashboard-stats');
            const loadingEl = document.getElementById(prefix + 'dashboard-loading');
            const errorEl = document.getElementById(prefix + 'dashboard-load-error');
            if (!container) return;
            if (loadingEl) loadingEl.style.display = 'inline';
            if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
            try {
                const response = await fetch('/api/dashboard', { credentials: 'same-origin' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (loadingEl) loadingEl.style.display = 'none';
                renderDashboardStats(container, data);
                if (includeCharts) {
                    renderDashboardMessagesByYearChart(data, prefix);
                    renderDashboardEmailsByYearChart(data, prefix);
                    renderDashboardContactsByCategoryChart(data, prefix);
                    renderDashboardImagesByRegionChart(data, prefix);
                    renderDashboardMessagesByContactChart(data, prefix);
                }
            } catch (err) {
                if (loadingEl) loadingEl.style.display = 'none';
                if (errorEl) {
                    errorEl.style.display = 'block';
                    errorEl.textContent = err.message || 'Failed to load dashboard';
                }
                container.innerHTML = '';
                if (includeCharts) {
                    const yearChart = document.getElementById(prefix + 'dashboard-messages-by-year-chart');
                    const emailsYearChart = document.getElementById(prefix + 'dashboard-emails-by-year-chart');
                    const contactsCatChart = document.getElementById(prefix + 'dashboard-contacts-by-category-chart');
                    const imagesRegionChart = document.getElementById(prefix + 'dashboard-images-by-region-chart');
                    const contactChart = document.getElementById(prefix + 'dashboard-messages-by-contact-chart');
                    if (yearChart) yearChart.innerHTML = '';
                    if (emailsYearChart) emailsYearChart.innerHTML = '';
                    if (contactsCatChart) contactsCatChart.innerHTML = '';
                    if (imagesRegionChart) imagesRegionChart.innerHTML = '';
                    if (contactChart) contactChart.innerHTML = '';
                }
            }
        }

        function renderDashboardMessagesByYearChart(data, prefix) {
            prefix = prefix || '';
            const chartEl = document.getElementById(prefix + 'dashboard-messages-by-year-chart');
            if (!chartEl) return;
            const byYear = data.messages_by_year || {};
            const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
            if (years.length === 0) {
                chartEl.innerHTML = '<h4 style="margin:0 0 8px 0; font-size:14px; color:#64748b;">Messages by Year</h4><p style="color:#94a3b8; font-size:13px;">No message data by year</p>';
                return;
            }
            const maxCount = Math.max(...years.map(y => byYear[y]), 1);
            const barHeight = 28;
            const bars = years.map(y => {
                const count = byYear[y];
                const pct = Math.round((count / maxCount) * 100);
                return `<div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
                    <span style="width:48px; font-weight:600; color:#334155;">${y}</span>
                    <div style="flex:1; height:${barHeight}px; background:#e2e8f0; border-radius:4px; overflow:hidden; position:relative;">
                        <div style="height:100%; width:${pct}%; background:#3b82f6; border-radius:4px; transition:width 0.3s;"></div>
                    </div>
                    <span style="width:72px; text-align:right; font-size:13px; color:#64748b;">${count.toLocaleString()}</span>
                </div>`;
            }).join('');
            chartEl.innerHTML = '<h4 style="margin:0 0 12px 0; font-size:14px; color:#64748b;">Messages by Year</h4>' + bars;
        }

        function renderDashboardEmailsByYearChart(data, prefix) {
            prefix = prefix || '';
            const chartEl = document.getElementById(prefix + 'dashboard-emails-by-year-chart');
            if (!chartEl) return;
            const byYear = data.emails_by_year || {};
            const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
            if (years.length === 0) {
                chartEl.innerHTML = '<h4 style="margin:0 0 8px 0; font-size:14px; color:#64748b;">Emails by Year</h4><p style="color:#94a3b8; font-size:13px;">No email data by year</p>';
                return;
            }
            const maxCount = Math.max(...years.map(y => byYear[y]), 1);
            const barHeight = 28;
            const barColor = '#60a5fa';
            const bars = years.map(y => {
                const count = byYear[y];
                const pct = Math.round((count / maxCount) * 100);
                return `<div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
                    <span style="width:48px; font-weight:600; color:#334155;">${y}</span>
                    <div style="flex:1; height:${barHeight}px; background:#e2e8f0; border-radius:4px; overflow:hidden; position:relative;">
                        <div style="height:100%; width:${pct}%; background:${barColor}; border-radius:4px; transition:width 0.3s;"></div>
                    </div>
                    <span style="width:72px; text-align:right; font-size:13px; color:#64748b;">${count.toLocaleString()}</span>
                </div>`;
            }).join('');
            chartEl.innerHTML = '<h4 style="margin:0 0 12px 0; font-size:14px; color:#64748b;">Emails by Year</h4>' + bars;
        }

        function renderDashboardMessagesByContactChart(data, prefix) {
            prefix = prefix || '';
            const chartEl = document.getElementById(prefix + 'dashboard-messages-by-contact-chart');
            if (!chartEl) return;
            const items = data.messages_by_contact || [];
            if (items.length === 0) {
                chartEl.innerHTML = '<h4 style="margin:0 0 8px 0; font-size:14px; color:#64748b;">Messages by Contact (Top 20)</h4><p style="color:#94a3b8; font-size:13px;">No message data by contact</p>';
                return;
            }
            const maxCount = Math.max(...items.map(i => i.count), 1);
            const barHeight = 28;
            const barColor = '#22c55e';
            const bars = items.map(i => {
                const pct = Math.round((i.count / maxCount) * 100);
                const name = (i.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
                    <span style="min-width:0; flex:1; max-width:200px; font-weight:600; color:#334155; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${name}">${name}</span>
                    <div style="flex:1; min-width:80px; height:${barHeight}px; background:#e2e8f0; border-radius:4px; overflow:hidden; position:relative;">
                        <div style="height:100%; width:${pct}%; background:${barColor}; border-radius:4px; transition:width 0.3s;"></div>
                    </div>
                    <span style="width:72px; text-align:right; font-size:13px; color:#64748b;">${i.count.toLocaleString()}</span>
                </div>`;
            }).join('');
            chartEl.innerHTML = '<h4 style="margin:0 0 12px 0; font-size:14px; color:#64748b;">Messages by Contact (Top 20)</h4>' + bars;
        }

        function renderDashboardContactsByCategoryChart(data, prefix) {
            prefix = prefix || '';
            const chartEl = document.getElementById(prefix + 'dashboard-contacts-by-category-chart');
            if (!chartEl) return;
            const byCat = data.contacts_by_category || {};
            const unknownCount = byCat['unknown'] ?? byCat['Unknown'] ?? 0;
            const categories = Object.entries(byCat)
                .filter(([k]) => (k || '').toLowerCase() !== 'unknown')
                .sort((a, b) => b[1] - a[1]);
            const barColor = '#8b5cf6';
            let html = '<h4 style="margin:0 0 12px 0; font-size:14px; color:#64748b;">Contacts by Category</h4>';
            if (categories.length === 0 && unknownCount === 0) {
                html += '<p style="color:#94a3b8; font-size:13px;">No contact data by category</p>';
            } else {
                const maxCount = categories.length ? Math.max(...categories.map(([, n]) => n), 1) : 1;
                const barHeight = 28;
                const bars = categories.map(([name, count]) => {
                    const pct = Math.round((count / maxCount) * 100);
                    const safeName = (name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    return `<div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
                        <span style="min-width:0; flex:1; max-width:180px; font-weight:600; color:#334155; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeName}">${safeName}</span>
                        <div style="flex:1; min-width:80px; height:${barHeight}px; background:#e2e8f0; border-radius:4px; overflow:hidden; position:relative;">
                            <div style="height:100%; width:${pct}%; background:${barColor}; border-radius:4px; transition:width 0.3s;"></div>
                        </div>
                        <span style="width:72px; text-align:right; font-size:13px; color:#64748b;">${count.toLocaleString()}</span>
                    </div>`;
                }).join('');
                html += bars;
                if (unknownCount > 0) {
                    html += `<p style="margin:12px 0 0 0; font-size:13px; color:#64748b;">Unknown: ${unknownCount.toLocaleString()} contacts</p>`;
                }
            }
            chartEl.innerHTML = html;
        }

        const REGION_NAME_MAP = {
            eur: 'Europe', dxb: 'Dubai', af: 'Africa', me: 'Middle East',
            aus: 'Australia', asia: 'Asia', usa: 'USA', south_america: 'South America',
            oth: 'Other', carribean: 'Caribbean', nz: 'New Zealand'
        };
        function regionDisplayName(key) {
            if (key == null || key === '') return 'Unknown';
            const k = String(key).toLowerCase().trim();
            return REGION_NAME_MAP[k] ?? key;
        }

        function renderDashboardImagesByRegionChart(data, prefix) {
            prefix = prefix || '';
            const chartEl = document.getElementById(prefix + 'dashboard-images-by-region-chart');
            if (!chartEl) return;
            const byRegion = data.images_by_region || {};
            const unknownCount = byRegion['Unknown'] ?? byRegion['unknown'] ?? 0;
            const regions = Object.entries(byRegion)
                .filter(([k]) => (k || '').toLowerCase() !== 'unknown')
                .sort((a, b) => b[1] - a[1]);
            const barColor = '#0ea5e9';
            let html = '<h4 style="margin:0 0 12px 0; font-size:14px; color:#64748b;">Images by Region</h4>';
            if (regions.length === 0 && unknownCount === 0) {
                html += '<p style="color:#94a3b8; font-size:13px;">No image data by region</p>';
            } else {
                const maxCount = regions.length ? Math.max(...regions.map(([, n]) => n), 1) : 1;
                const barHeight = 28;
                const bars = regions.map(([name, count]) => {
                    const pct = Math.round((count / maxCount) * 100);
                    const displayName = regionDisplayName(name);
                    const safeName = displayName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    return `<div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
                        <span style="min-width:0; flex:1; max-width:180px; font-weight:600; color:#334155; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeName}">${safeName}</span>
                        <div style="flex:1; min-width:80px; height:${barHeight}px; background:#e2e8f0; border-radius:4px; overflow:hidden; position:relative;">
                            <div style="height:100%; width:${pct}%; background:${barColor}; border-radius:4px; transition:width 0.3s;"></div>
                        </div>
                        <span style="width:72px; text-align:right; font-size:13px; color:#64748b;">${count.toLocaleString()}</span>
                    </div>`;
                }).join('');
                html += bars;
                if (unknownCount > 0) {
                    html += `<p style="margin:12px 0 0 0; font-size:13px; color:#64748b;">Unknown: ${unknownCount.toLocaleString()} images</p>`;
                }
            }
            chartEl.innerHTML = html;
        }

        function renderDashboardStats(container, data) {
            const cards = [];
            const add = (label, value, num) => cards.push({ label, value: value ?? 0, num: num ?? (typeof value === 'number' ? value : null) });
            add('Total Messages', data.total_messages);
            const ebs = data.emails_by_source && typeof data.emails_by_source === 'object' ? data.emails_by_source : {};
            const gmailN = ebs.gmail != null ? Number(ebs.gmail) : 0;
            let otherN = 0;
            Object.entries(ebs).forEach(([k, v]) => {
                if (k !== 'gmail') otherN += v != null ? Number(v) : 0;
            });
            const emailLabelExtra = Object.keys(ebs).length
                ? ` — Gmail ${gmailN.toLocaleString()}, other ${otherN.toLocaleString()}`
                : '';
            add('Total Emails' + emailLabelExtra, data.emails_count);
            const counts = data.message_counts || {};
            Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([service, n]) => {
                add(`Messages (${service})`, n);
            });
            add('Contacts', data.contacts_count);
            add('Images (total)', data.total_images);
            add('Images (imported)', data.imported_images);
            add('Images (reference)', data.reference_images);
            const thumbVal = `${data.thumbnail_count || 0} (${data.thumbnail_percentage ?? 0}%)`;
            const thumbPct = data.thumbnail_percentage ?? 0;
            const thumbBorder = thumbPct >= 100 ? '#22c55e' : (thumbPct < 80 ? '#dc3545' : (thumbPct < 95 ? '#eab308' : null));
            cards.push({ label: 'Images with thumbnails', value: thumbVal, num: data.thumbnail_count ?? 0, borderColor: thumbBorder });
            add('Facebook albums', data.facebook_albums_count);
            add('Facebook posts', data.facebook_posts_count);
            add('Locations', data.locations_count);
            add('Places', data.places_count);
            add('Artefacts', data.artefacts_count);
            add('Reference docs (enabled)', data.reference_docs_enabled);
            add('Reference docs (disabled)', data.reference_docs_disabled);
            add('Complete profiles', data.complete_profiles_count);
            const subjName = data.subject_full_name || 'Subject';
            const subjHasProfile = data.subject_has_complete_profile === true;
            cards.push({
                label: subjName,
                value: subjHasProfile ? 'Complete profile: Yes' : 'Complete profile: No',
                num: null,
                borderColor: subjHasProfile ? '#22c55e' : '#dc3545'
            });
            container.innerHTML = cards.map(c => {
                let borderColor = c.borderColor;
                if (borderColor == null) borderColor = (c.num !== null && c.num === 0) ? '#dc3545' : '#3b82f6';
                const displayVal = typeof c.value === 'number' ? c.value.toLocaleString() : c.value;
                return `<div style="padding:12px; background:#f5f7fa; border-radius:8px; border-left:4px solid ${borderColor};">
                    <div style="font-size:12px; color:#64748b; text-transform:uppercase;">${c.label}</div>
                    <div style="font-size:18px; font-weight:600; color:#1e293b; margin-top:4px;">${displayVal}</div>
                </div>`;
            }).join('');
        }

        async function loadArchiveOverviewLLMStatus() {
            const body = document.getElementById('overview-llm-status-body');
            if (!body) return;
            function esc(s) {
                return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }
            function row2(leftHtml, rightHtml) {
                return `<div style="display:grid;grid-template-columns:minmax(160px,auto) 1fr;gap:8px 16px;margin-bottom:8px;align-items:start;">${leftHtml}${rightHtml}</div>`;
            }
            body.innerHTML = '<span style="color:#64748b;">Loading…</span>';
            try {
                const [avRes, meRes] = await Promise.all([
                    fetch('/chat/availability', { credentials: 'same-origin' }),
                    fetch('/auth/me', { credentials: 'same-origin' })
                ]);
                let av = {};
                if (avRes.ok) {
                    try { av = await avRes.json(); } catch (_) { /* ignore */ }
                }
                let me = null;
                if (meRes.ok) {
                    try { me = await meRes.json(); } catch (_) { /* ignore */ }
                }
                const gOk = !!av.gemini_available;
                const cOk = !!av.claude_available;
                const dOk = !!av.deepseek_available;
                const lOk = !!av.localai_available;
                const gemVal = gOk
                    ? '<strong style="color:#15803d;">Ready</strong> — Gemini can be selected as AI Provider'
                    : '<strong style="color:#b91c1c;">Not available</strong> — configure a Gemini API key';
                const claVal = cOk
                    ? '<strong style="color:#15803d;">Ready</strong> — Claude can be selected as AI Provider'
                    : '<strong style="color:#b91c1c;">Not available</strong> — configure an Anthropic API key';
                const deepVal = dOk
                    ? '<strong style="color:#15803d;">Ready</strong> — DeepSeek can be selected as AI Provider'
                    : '<strong style="color:#b91c1c;">Not available</strong> — configure DEEPSEEK_API_KEY in server config';
                const localVal = lOk
                    ? '<strong style="color:#15803d;">Ready</strong> — Local AI can be selected as AI Provider'
                    : '<strong style="color:#b91c1c;">Not available</strong> — set LOCALAI_BASE_URL in server config';
                const parts = [];
                parts.push(row2('<span style="color:#64748b;">Gemini</span>', `<span>${gemVal}</span>`));
                parts.push(row2('<span style="color:#64748b;">Claude</span>', `<span>${claVal}</span>`));
                parts.push(row2('<span style="color:#64748b;">DeepSeek</span>', `<span>${deepVal}</span>`));
                parts.push(row2('<span style="color:#64748b;">Local AI</span>', `<span>${localVal}</span>`));
                if (me && me.llm_settings) {
                    const ls = me.llm_settings;
                    const sess = !!ls.session_scoped;
                    const scope = sess ? '<span style="color:#64748b;font-weight:normal;"> — session</span>' : '<span style="color:#64748b;font-weight:normal;"> — saved on account</span>';
                    if (ls.gemini_model) {
                        parts.push(row2(`<span style="color:#64748b;">Gemini model${scope}</span>`, `<code style="background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:0.85rem;">${esc(ls.gemini_model)}</code>`));
                    }
                    if (ls.claude_model) {
                        parts.push(row2(`<span style="color:#64748b;">Claude model${scope}</span>`, `<code style="background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:0.85rem;">${esc(ls.claude_model)}</code>`));
                    }
                    const tavVal = ls.tavily_api_key_set
                        ? '<strong style="color:#15803d;">Key set</strong> — search tool can use your Tavily key' + (sess ? ' <span style="color:#64748b;font-weight:normal;">(this session)</span>' : '')
                        : '<span style="color:#64748b;">No personal Tavily key in Settings — server default or none</span>';
                    parts.push(row2('<span style="color:#64748b;">Tavily (web search)</span>', `<span>${tavVal}</span>`));
                    // if (sess) {
                    //     parts.push('<div style="margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:0.85rem;color:#64748b;">Visitor session: keys you leave blank use the archive owner’s saved keys when available, then server defaults.</div>');
                    // }
                } else if (meRes.status === 401 || !meRes.ok) {
                    parts.push('<p style="margin:12px 0 0;font-size:0.85rem;color:#64748b;">Sign in to save personal API keys under <strong>Settings → Your API keys &amp; models</strong>.</p>');
                }
                body.innerHTML = parts.join('');
                const wrap = document.getElementById('overview-llm-keys-button-wrap');
                const lbl = document.getElementById('overview-llm-keys-open-btn-label');
                archiveOverviewMeForKeys = null;
                if (wrap) {
                    if (!gOk && !cOk && !dOk && !lOk && me) {
                        wrap.style.display = 'block';
                        archiveOverviewMeForKeys = me;
                        if (lbl) {
                            lbl.textContent = (me.llm_settings && me.llm_settings.session_scoped)
                                ? 'Add keys for this session'
                                : 'Add your API keys';
                        }
                    } else {
                        wrap.style.display = 'none';
                    }
                }
            } catch (e) {
                body.textContent = 'Could not load AI configuration status.';
                archiveOverviewMeForKeys = null;
                const wrap = document.getElementById('overview-llm-keys-button-wrap');
                if (wrap) wrap.style.display = 'none';
            }
        }

        function setupArchiveOverviewLLMKeysModal() {
            const modal = document.getElementById('archive-overview-llm-modal');
            const openBtn = document.getElementById('overview-llm-keys-open-btn');
            const cancelBtn = document.getElementById('archive-overview-llm-cancel-btn');
            const saveBtn = document.getElementById('archive-overview-llm-save-btn');
            if (!modal || !openBtn) return;

            function closeArchiveOverviewLLMModal() {
                modal.style.display = 'none';
                const st = document.getElementById('archive-overview-llm-save-status');
                if (st) st.textContent = '';
            }

            function openArchiveOverviewLLMModal() {
                const me = archiveOverviewMeForKeys;
                if (!me) return;
                const ls = me.llm_settings || {};
                const sess = !!ls.session_scoped;
                const introEl = document.getElementById('archive-overview-llm-modal-intro');
                const titleEl = document.getElementById('archive-overview-llm-modal-title');
                if (titleEl) titleEl.textContent = sess ? 'API keys for this visit' : 'Add your API keys';
                if (introEl) {
                    introEl.textContent = sess
                        ? 'Keys are stored on this browser session only and clear when the session ends. Enter at least a Gemini or Anthropic API key to use chat.'
                        : 'Keys are saved to your account. Enter at least a Gemini or Anthropic API key when no server key is available for you.';
                }
                const gk = document.getElementById('overview-llm-gemini-key');
                const ak = document.getElementById('overview-llm-anthropic-key');
                const tk = document.getElementById('overview-llm-tavily-key');
                const gm = document.getElementById('overview-llm-gemini-model');
                const cm = document.getElementById('overview-llm-claude-model');
                if (gk) {
                    gk.value = '';
                    gk.placeholder = sess ? 'Leave blank to use owner or server default' : 'Paste key to save';
                }
                if (ak) {
                    ak.value = '';
                    ak.placeholder = sess ? 'Leave blank to use owner or server default' : 'Paste key to save';
                }
                if (tk) {
                    tk.value = '';
                    tk.placeholder = 'Optional — web search';
                }
                if (gm) gm.value = ls.gemini_model || '';
                if (cm) cm.value = ls.claude_model || '';
                const st = document.getElementById('archive-overview-llm-save-status');
                if (st) st.textContent = '';
                modal.style.display = 'flex';
            }

            openBtn.addEventListener('click', openArchiveOverviewLLMModal);
            if (cancelBtn) cancelBtn.addEventListener('click', closeArchiveOverviewLLMModal);
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeArchiveOverviewLLMModal();
            });

            if (saveBtn) {
                saveBtn.addEventListener('click', async () => {
                    const st = document.getElementById('archive-overview-llm-save-status');
                    const gkEl = document.getElementById('overview-llm-gemini-key');
                    const akEl = document.getElementById('overview-llm-anthropic-key');
                    const tkEl = document.getElementById('overview-llm-tavily-key');
                    const gmEl = document.getElementById('overview-llm-gemini-model');
                    const cmEl = document.getElementById('overview-llm-claude-model');
                    const gk = (gkEl && gkEl.value.trim()) || '';
                    const ak = (akEl && akEl.value.trim()) || '';
                    const tk = (tkEl && tkEl.value.trim()) || '';
                    if (!gk && !ak) {
                        if (st) {
                            st.textContent = 'Enter a Gemini and/or Anthropic API key.';
                            st.style.color = '#b91c1c';
                        }
                        return;
                    }
                    const body = {};
                    if (gk) body.gemini_api_key = gk;
                    if (ak) body.anthropic_api_key = ak;
                    if (tk) body.tavily_api_key = tk;
                    body.gemini_model = (gmEl && gmEl.value.trim()) || '';
                    body.claude_model = (cmEl && cmEl.value.trim()) || '';
                    saveBtn.disabled = true;
                    if (st) {
                        st.textContent = 'Saving…';
                        st.style.color = '#64748b';
                    }
                    try {
                        const res = await fetch('/auth/me/llm-settings', {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'same-origin',
                            body: JSON.stringify(body),
                        });
                        if (!res.ok) {
                            let detail = await res.text();
                            try {
                                const j = JSON.parse(detail);
                                if (j && j.error) detail = j.error;
                            } catch (_) { /* keep */ }
                            throw new Error(detail || res.statusText);
                        }
                        closeArchiveOverviewLLMModal();
                        void loadArchiveOverviewLLMStatus();
                        void loadLLMProviderAvailability();
                        refreshSettingsDataImportModalLLM();
                    } catch (err) {
                        if (st) {
                            st.textContent = err.message || 'Save failed';
                            st.style.color = '#b91c1c';
                        }
                    } finally {
                        saveBtn.disabled = false;
                    }
                });
            }
        }
        setupArchiveOverviewLLMKeysModal();

        // Format date/time in local timezone, 24-hour format (dd/mm/yyyy HH:mm)
        function formatImportLastRunLocal(isoString) {
            if (!isoString) return '';
            try {
                const date = new Date(isoString);
                if (isNaN(date.getTime())) return '';
                return new Intl.DateTimeFormat('en-AU', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }).format(date);
            } catch (e) {
                return '';
            }
        }

        async function loadDataImportModalCounts() {
            const modalRoot = document.getElementById('data-import-modal');
            if (!modalRoot) return;
            try {
                const response = await fetch('/api/dashboard');
                if (!response.ok) return;
                const d = await response.json();
                const mc = d.message_counts || {};
                const n = (k) => {
                    const v = mc[k];
                    return v != null ? Number(v) : 0;
                };
                const imessageMsg = n('iMessage') + n('SMS') + n('MMS');
                const fbZipTotal = n('Facebook Messenger') + (d.facebook_albums_count || 0) + (d.facebook_posts_count || 0) + (d.locations_count || 0);
                const setCell = (key, value) => {
                    const num = typeof value === 'number' && !Number.isNaN(value) ? value : Number(value);
                    const safe = Number.isNaN(num) ? 0 : num;
                    const isZero = safe === 0;
                    modalRoot.querySelectorAll(`[data-import-count-key="${key}"]`).forEach((el) => {
                        el.textContent = String(safe);
                        const row = el.closest('.data-import-row');
                        if (row) {
                            row.classList.toggle('data-import-row-zero-count', isZero);
                        }
                    });
                };
                const ebs = d.emails_by_source && typeof d.emails_by_source === 'object' ? d.emails_by_source : {};
                const gmailOnly = ebs.gmail != null ? Number(ebs.gmail) : 0;
                let imapLike = 0;
                Object.entries(ebs).forEach(([k, v]) => {
                    if (k !== 'gmail') imapLike += v != null ? Number(v) : 0;
                });
                setCell('email_processing', gmailOnly);
                setCell('imap_processing', imapLike);
                setCell('zip_whatsapp', n('WhatsApp'));
                setCell('zip_instagram', n('Instagram'));
                setCell('zip_imessage', imessageMsg);
                setCell('zip_facebook', fbZipTotal);
                // Image rows: prefer filesystem-scoped split from API (matches DB is_referenced for source=filesystem).
                // If the server predates those fields, use imported_images / reference_images so the table matches
                // the Statistics dialog (media_type image/*, is_referenced).
                const hasFsSplit = Object.prototype.hasOwnProperty.call(d, 'filesystem_images_embedded_count')
                    && Object.prototype.hasOwnProperty.call(d, 'filesystem_images_referenced_count');
                let uploadPhotosCount;
                let folderScanCount;
               
                if (hasFsSplit) {
                    uploadPhotosCount = Number(d.filesystem_images_embedded_count) || 0;
                    folderScanCount = Number(d.filesystem_images_referenced_count) || 0;
                } else {
                    uploadPhotosCount = d.imported_images != null ? Number(d.imported_images) : 0;
                    folderScanCount = d.reference_images != null ? Number(d.reference_images) : 0;
                }
                setCell('upload_photos', uploadPhotosCount);
                setCell('filesystem', folderScanCount);
                setCell('filesystem_reference', folderScanCount);
                setCell('imported_images', uploadPhotosCount);
                setCell('thumbnails', d.thumbnail_count != null ? Number(d.thumbnail_count) : 0);
                setCell('reference_docs', d.reference_docs_count != null ? Number(d.reference_docs_count) : 0);
                setCell('contacts', d.contacts_count != null ? Number(d.contacts_count) : 0);
                setCell('reference_import_entries', d.reference_images != null ? Number(d.reference_images) : 0);
                setCell('image_export_entries', d.total_images != null ? Number(d.total_images) : 0);
            } catch (e) {
                console.warn('Failed to load data import counts:', e);
            }
        }

        async function loadImportControlLastRun() {
            try {
                const response = await fetch('/api/import-control-last-run');
                if (!response.ok) return;
                const data = await response.json();
                const importTypes = ['email_processing', 'imap_processing', 'filesystem', 'imported_images', 'filesystem_reference', 'reference_import', 'email_embeddings', 'message_embeddings', 'message_context_embeddings', 'image_tag_embeddings', 'image_export', 'contacts', 'image_ai_gemma_unclassified', 'zip_whatsapp', 'zip_instagram', 'zip_imessage', 'zip_facebook', 'upload_photos', 'upload_zip'];
                for (const importType of importTypes) {
                    const els = document.querySelectorAll(`[data-import-last-run="${importType}"]`);
                    const info = data[importType];
                    const formatted = (info && info.last_run_at) ? formatImportLastRunLocal(info.last_run_at) : null;
                    const resultLabel = (info && info.result) ? ((info.result === 'success' || info.result === 'completed') ? 'success' : (info.result === 'cancelled' ? 'cancelled' : 'error')) : null;
                    const text = formatted ? (resultLabel ? `${formatted} (${resultLabel})` : `${formatted}`) : '';
                    const title = (info && info.result_message) ? info.result_message : '';
                    els.forEach(el => {
                        el.textContent = text;
                        el.title = title;
                    });
                }
                const thumbLR = data.thumbnails;
                const asyncLR = data.thumbnails_async;
                let mergedLR = (thumbLR && thumbLR.last_run_at) ? thumbLR : null;
                if (asyncLR && asyncLR.last_run_at) {
                    const tAt = mergedLR && mergedLR.last_run_at ? String(mergedLR.last_run_at) : '';
                    const aAt = String(asyncLR.last_run_at);
                    if (!mergedLR || !mergedLR.last_run_at || aAt > tAt) {
                        mergedLR = asyncLR;
                    }
                }
                let thumbText = '';
                let thumbTitle = '';
                if (mergedLR && mergedLR.last_run_at) {
                    const formatted = formatImportLastRunLocal(mergedLR.last_run_at);
                    const resultLabel = (mergedLR.result) ? ((mergedLR.result === 'success' || mergedLR.result === 'completed') ? 'success' : (mergedLR.result === 'cancelled' ? 'cancelled' : 'error')) : null;
                    thumbText = formatted ? (resultLabel ? `${formatted} (${resultLabel})` : `${formatted}`) : '';
                    thumbTitle = mergedLR.result_message ? mergedLR.result_message : '';
                }
                document.querySelectorAll('[data-import-last-run="thumbnails"]').forEach(el => {
                    el.textContent = thumbText;
                    el.title = thumbTitle;
                });
            } catch (e) {
                console.warn('Failed to load import control last run:', e);
            }
        }

        // Empty Media Tables Button
        const emptyMediaTablesBtn = document.getElementById('empty-media-tables-btn');
        const emptyTablesStatus = document.getElementById('empty-tables-status');
        
        if (emptyMediaTablesBtn) {
            emptyMediaTablesBtn.addEventListener('click', async () => {
                const confirmed = await AppDialogs.showAppConfirm(
                    'Empty media tables',
                    'WARNING: This will permanently delete ALL data from:\n\n' +
                    '- attachments\n' +
                    '- media_blob\n' +
                    '- media_items\n' +
                    '- messages\n' +
                    '- message_attachments\n\n' +
                    'This action cannot be undone!\n\n' +
                    'Are you absolutely sure you want to continue?',
                    { danger: true }
                );
                
                if (!confirmed) {
                    return;
                }
                
                const doubleConfirmed = await AppDialogs.showAppConfirm(
                    'Final warning',
                    'FINAL WARNING: This will DELETE ALL messages and media data.\n\n',
                    { danger: true }
                );
                
                if (!doubleConfirmed) {
                    return;
                }
                const userInput = "DELETE";
                if (userInput !== 'DELETE') {
                    if (emptyTablesStatus) {
                        emptyTablesStatus.style.display = 'block';
                        emptyTablesStatus.style.backgroundColor = '#fff3cd';
                        emptyTablesStatus.style.color = '#856404';
                        emptyTablesStatus.style.border = '1px solid #ffc107';
                        emptyTablesStatus.textContent = 'Operation cancelled. Tables were not emptied.';
                    }
                    return;
                }
                
                // Disable button and show loading
                emptyMediaTablesBtn.disabled = true;
                emptyMediaTablesBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Emptying tables...';
                
                if (emptyTablesStatus) {
                    emptyTablesStatus.style.display = 'block';
                    emptyTablesStatus.style.backgroundColor = '#d1ecf1';
                    emptyTablesStatus.style.color = '#0c5460';
                    emptyTablesStatus.style.border = '1px solid #bee5eb';
                    emptyTablesStatus.textContent = 'Emptying tables...';
                }
                
                try {
                    const response = await fetch('/admin/empty-media-tables', {
                        method: 'DELETE'
                    });
                    
                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
                        throw new Error(errorData.detail || `HTTP ${response.status}`);
                    }
                    
                    const result = await response.json();
                    
                    // Show success message
                    if (emptyTablesStatus) {
                        emptyTablesStatus.style.backgroundColor = '#d4edda';
                        emptyTablesStatus.style.color = '#155724';
                        emptyTablesStatus.style.border = '1px solid #c3e6cb';
                        
                        const counts = result.deleted_counts || {};
                        emptyTablesStatus.innerHTML = `
                            <strong>Tables emptied successfully!</strong><br>
                            Deleted counts:<br>
                            • Messages: ${counts.messages || 0}<br>
                            • Message Attachments: ${counts.message_attachments || 0}<br>
                            • Media Items: ${counts.media_items || 0}<br>
                            • Media Blobs: ${counts.media_blob || 0}<br>
                            • Attachments: ${counts.attachments || 0}<br>
                            • Facebook Album Images: ${counts.facebook_album_images || 0}<br>
                            • Facebook Albums: ${counts.facebook_albums || 0}<br>
                        `;
                    }
                    
                    // Re-enable button
                    emptyMediaTablesBtn.disabled = false;
                    emptyMediaTablesBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Empty Media and Message Tables';
                    
                } catch (error) {
                    console.error('Error emptying tables:', error);
                    
                    if (emptyTablesStatus) {
                        emptyTablesStatus.style.backgroundColor = '#f8d7da';
                        emptyTablesStatus.style.color = '#721c24';
                        emptyTablesStatus.style.border = '1px solid #f5c6cb';
                        emptyTablesStatus.textContent = `Error: ${error.message}`;
                    }
                    
                    // Re-enable button
                    emptyMediaTablesBtn.disabled = false;
                    emptyMediaTablesBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Empty Media and Message Tables';
                }
            });
        }

        // Email Processing Controls
        const processAllFoldersCheckbox = document.getElementById('process-all-folders');
        const folderSelect = document.getElementById('folder-select');
        const folderSelectionGroup = document.getElementById('folder-selection-group');
        const newOnlyOption = document.getElementById('new-only-option');
        const startProcessingBtn = document.getElementById('start-processing-btn');
        const cancelProcessingBtn = document.getElementById('cancel-processing-btn');
        const processingStatus = document.getElementById('processing-status');
        const processingStatusMessage = document.getElementById('processing-status-message');
        const processingStatusDetails = document.getElementById('processing-status-details');
        const processingProgressContainer = document.getElementById('processing-progress-container');
        const currentLabelName = document.getElementById('current-label-name');
        const labelProgressText = document.getElementById('label-progress-text');
        const processingProgressBar = document.getElementById('processing-progress-bar');
        const progressBarText = document.getElementById('progress-bar-text');
        const emailsProcessedCount = document.getElementById('emails-processed-count');
        let eventSource = null;

        // Toggle folder selection based on "Process All" checkbox
        if (processAllFoldersCheckbox) {
            // Set initial state
            if (processAllFoldersCheckbox.checked) {
                folderSelectionGroup.style.display = 'none';
            }
            
            processAllFoldersCheckbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    folderSelectionGroup.style.display = 'none';
                } else {
                    folderSelectionGroup.style.display = 'block';
                }
            });
        }

        // Load folders from API
        async function loadFolders() {
            if (!folderSelect) return;
            
            try {
                const response = await fetch('/emails/folders');
                if (!response.ok) {
                    throw new Error(`Failed to load folders: ${response.statusText}`);
                }
                const folders = await response.json();
                
                folderSelect.innerHTML = '';
                folders.forEach(folder => {
                    const option = document.createElement('option');
                    option.value = folder.name;
                    option.textContent = folder.name;
                    folderSelect.appendChild(option);
                });
            } catch (error) {
                folderSelect.innerHTML = '<option value="">Error loading folders</option>';
                showProcessingStatus('error', 'Failed to load folders', error.message);
            }
        }

        // Close SSE connection if open
        function closeEventSource() {
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
        }

        // Request browser notification permission
        async function requestNotificationPermission() {
            if ('Notification' in window && Notification.permission === 'default') {
                await Notification.requestPermission();
            }
        }

        // Show browser notification
        function showNotification(title, body, icon = null) {
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification(title, {
                    body: body,
                    icon: icon || '/static/images/expert.png',
                    tag: 'email-processing'
                });
            }
        }

        // Update progress display
        function updateProgressDisplay(progressData) {
            if (!processingProgressContainer) return;

            const {
                current_label,
                current_label_index,
                total_labels,
                emails_processed,
                status
            } = progressData;

            // Show progress container when processing starts
            if (status === 'in_progress') {
                processingProgressContainer.style.display = 'block';
            }

            // Update current label
            if (currentLabelName) {
                currentLabelName.textContent = current_label || 'Waiting...';
            }

            // Update label progress
            if (labelProgressText) {
                labelProgressText.textContent = `${current_label_index} / ${total_labels}`;
            }

            // Update progress bar
            if (total_labels > 0 && processingProgressBar && progressBarText) {
                const percentage = Math.round((current_label_index / total_labels) * 100);
                processingProgressBar.style.width = `${percentage}%`;
                progressBarText.textContent = `${percentage}%`;
            }

            // Update emails processed count
            if (emailsProcessedCount) {
                emailsProcessedCount.textContent = emails_processed || 0;
            }
        }

        // Connect to SSE stream
        function connectToProgressStream() {
            // Close existing connection if any
            closeEventSource();

            // Request notification permission
            requestNotificationPermission();

            // Create EventSource connection
            eventSource = new EventSource('/emails/process/stream');

            eventSource.onmessage = (event) => {
                try {
                    const eventData = JSON.parse(event.data);
                    handleProgressEvent(eventData);
                } catch (error) {
                    console.error('Error parsing SSE event:', error);
                }
            };

            eventSource.onerror = (error) => {
                console.error('SSE connection error:', error);
                // Don't close on error - EventSource will attempt to reconnect
            };

            // Clean up on page unload
            window.addEventListener('beforeunload', () => {
                closeEventSource();
            });
        }

        // Handle progress events from SSE
        function handleProgressEvent(eventData) {
            const { type, data } = eventData;

            switch (type) {
                case 'progress':
                    updateProgressDisplay(data);
                    if (data.status === 'in_progress') {
                        cancelProcessingBtn.style.display = 'inline-block';
                        startProcessingBtn.disabled = true;
                        showProcessingStatus('info', 'Processing in progress...', `Processing label ${data.current_label_index} of ${data.total_labels}`);
                    }
                    break;

                case 'completed':
                    updateProgressDisplay(data);
                    cancelProcessingBtn.style.display = 'none';
                    startProcessingBtn.disabled = false;
                    showProcessingStatus('success', 'Processing completed', `Successfully processed ${data.emails_processed} emails from ${data.total_labels} label(s).`);
                    showNotification('Email Processing Complete', `Processed ${data.emails_processed} emails from ${data.total_labels} label(s).`);
                    closeEventSource();
                    break;

                case 'error':
                    updateProgressDisplay(data);
                    cancelProcessingBtn.style.display = 'none';
                    startProcessingBtn.disabled = false;
                    showProcessingStatus('error', 'Processing error', data.error_message || 'An error occurred during processing.');
                    showNotification('Email Processing Error', data.error_message || 'An error occurred during processing.');
                    closeEventSource();
                    break;

                case 'cancelled':
                    updateProgressDisplay(data);
                    cancelProcessingBtn.style.display = 'none';
                    startProcessingBtn.disabled = false;
                    showProcessingStatus('info', 'Processing cancelled', data.error_message || 'Processing was cancelled.');
                    showNotification('Email Processing Cancelled', 'Processing was cancelled by user.');
                    closeEventSource();
                    break;

                case 'heartbeat':
                    // Keep connection alive - no UI update needed
                    break;

                default:
                    console.log('Unknown event type:', type);
            }
        }

        // Check initial processing status
        async function checkInitialStatus() {
            if (!processingStatus) return;
            
            try {
                const response = await fetch('/emails/process/status');
                if (!response.ok) {
                    return;
                }
                const status = await response.json();
                
                if (status.in_progress) {
                    cancelProcessingBtn.style.display = 'inline-block';
                    startProcessingBtn.disabled = true;
                    // Connect to stream to get updates
                    connectToProgressStream();
                } else {
                    cancelProcessingBtn.style.display = 'none';
                    startProcessingBtn.disabled = false;
                }
            } catch (error) {
                console.error('Error checking initial status:', error);
            }
        }

        // Show processing status message
        function showProcessingStatus(type, message, details = '') {
            if (!processingStatus) return;
            
            // Remove all status classes
            processingStatus.classList.remove('success', 'error', 'info');
            // Add the new status class
            processingStatus.classList.add(type);
            processingStatus.style.display = 'block';
            processingStatusMessage.textContent = message;
            processingStatusDetails.textContent = details;
        }

        // Start processing
        if (startProcessingBtn) {
            startProcessingBtn.addEventListener('click', async () => {
                const allFolders = processAllFoldersCheckbox?.checked || false;
                const newOnly = newOnlyOption?.checked || false;
                let labels = null;
                
                if (!allFolders) {
                    const selectedOptions = Array.from(folderSelect?.selectedOptions || []);
                    labels = selectedOptions.map(opt => opt.value);
                    
                    if (labels.length === 0) {
                        showProcessingStatus('error', 'No folders selected', 'Please select at least one folder or check "Process All Folders".');
                        return;
                    }
                }
                
                const requestBody = {
                    all_folders: allFolders,
                    new_only: newOnly,
                    labels: labels
                };
                
                try {
                    startProcessingBtn.disabled = true;
                    showProcessingStatus('info', 'Starting processing...', 'Sending request to server...');
                    
                    const response = await fetch('/emails/process', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(requestBody)
                    });
                    
                    const result = await response.json();
                    
                    if (response.ok) {
                        showProcessingStatus('info', 'Processing started', result.message || 'Email processing has been initiated.');
                        cancelProcessingBtn.style.display = 'inline-block';
                        
                        // Connect to SSE stream for real-time updates
                        connectToProgressStream();
                    } else {
                        showProcessingStatus('error', 'Failed to start processing', result.detail || 'An error occurred while starting processing.');
                        startProcessingBtn.disabled = false;
                    }
                } catch (error) {
                    showProcessingStatus('error', 'Error starting processing', error.message);
                    startProcessingBtn.disabled = false;
                }
            });
        }

        // Cancel processing
        if (cancelProcessingBtn) {
            cancelProcessingBtn.addEventListener('click', async () => {
                try {
                    cancelProcessingBtn.disabled = true;
                    showProcessingStatus('info', 'Cancelling processing...', 'Sending cancellation request...');
                    
                    const response = await fetch('/emails/process/cancel', {
                        method: 'POST'
                    });
                    
                    const result = await response.json();
                    
                    if (result.cancelled) {
                        showProcessingStatus('info', 'Cancellation requested', result.message || 'Processing cancellation has been requested.');
                        // The SSE stream will send the cancelled event
                    } else {
                        showProcessingStatus('info', 'No processing in progress', result.message || 'No email processing is currently in progress.');
                        closeEventSource();
                    }
                } catch (error) {
                    showProcessingStatus('error', 'Error cancelling processing', error.message);
                } finally {
                    cancelProcessingBtn.disabled = false;
                }
            });
        }

        // Unified Import Controls (table layout, modal inputs, shared status box in both tabs)
        const importStatusTextEls = () => document.querySelectorAll('.import-controls-status-text');

        const importInputModal = document.getElementById('import-input-modal');
        const importInputModalTitle = document.getElementById('import-input-modal-title');
        const importInputModalBody = document.getElementById('import-input-modal-body');
        const importInputModalCancel = document.getElementById('import-input-modal-cancel');
        const importInputModalSubmit = document.getElementById('import-input-modal-submit');

        /** @type {Map<string, { importType: string, zipArchiveType: string|null, label: string, lines: string[], eventSource: EventSource|null, cancelPending?: boolean }>} */
        const runningJobs = new Map();
        let selectedJobKey = null;

        function makeJobKey(importType, extra = {}) {
            if (importType === 'upload_zip' && extra.zipArchiveType) {
                return 'upload_zip:' + extra.zipArchiveType;
            }
            return importType;
        }

        function jobTabLabel(importType, extra = {}) {
            if (importType === 'upload_zip' && extra.zipArchiveType) {
                const z = extra.zipArchiveType;
                const names = { whatsapp: 'WhatsApp', instagram: 'Instagram', imessage: 'iMessage & SMS', facebook: 'Facebook' };
                return names[z] || ('ZIP · ' + z);
            }
            const SHORT = {
                email_processing: 'Gmail',
                imap_processing: 'IMAP',
                upload_zip: 'ZIP',
                filesystem: 'Filesystem Upload',
                filesystem_reference: 'Filesystem References',
                thumbnails: 'Thumbnails',
                thumbnails_async: 'Thumbnails',
                reference_import: 'Reference Images',
                email_embeddings: 'Email Embeddings',
                message_embeddings: 'Message Embeddings',
                message_context_embeddings: 'Message Context Embeddings',
                image_export: 'Export Images',
                contacts: 'ProcessContacts',
                image_ai_gemma_unclassified: 'Image AI Classification',
                image_tag_embeddings: 'Image Tag Embeddings'
            };
            return SHORT[importType] || importType;
        }

        function dataImportStatusEls() {
            const modal = document.getElementById('data-import-modal');
            if (!modal) return { tabsStrip: null, logPre: null, idleWrap: null };
            return {
                tabsStrip: modal.querySelector('.import-job-tabs-strip'),
                logPre: modal.querySelector('.import-job-log-display'),
                idleWrap: modal.querySelector('.import-job-status-idle-wrap')
            };
        }

        function syncLegacyConfigStatusLine() {
            const el = document.querySelector('#config-modal-overlay .import-controls-status-text');
            if (!el) return;
            if (runningJobs.size === 0) return;
            const job = selectedJobKey && runningJobs.get(selectedJobKey);
            const last = job && job.lines && job.lines.length ? job.lines[job.lines.length - 1] : '';
            el.textContent = last ? String(last).slice(0, 140) : (runningJobs.size + ' job(s) running');
        }

        function setImportStatusAllIdle(text, isError = false) {
            importStatusTextEls().forEach(el => {
                el.textContent = text || 'Idle';
                el.style.color = isError ? '#ff6b6b' : '';
            });
            const { logPre, idleWrap, tabsStrip } = dataImportStatusEls();
            if (logPre) {
                logPre.hidden = true;
                logPre.textContent = '';
                logPre.style.color = '';
            }
            if (idleWrap) idleWrap.hidden = false;
            if (tabsStrip) {
                tabsStrip.innerHTML = '';
                tabsStrip.hidden = true;
            }
        }

        function appendJobLine(jobKey, text) {
            const job = runningJobs.get(jobKey);
            if (!job) return;
            const line = (text || '').trim();
            if (!line) return;
            if (!job.lines) job.lines = [];
            job.lines.push(line);
            if (job.lines.length > 100) job.lines = job.lines.slice(-100);
            if (selectedJobKey === jobKey) {
                renderJobLogDisplay();
            }
            syncLegacyConfigStatusLine();
        }

        function scrollImportJobLogToBottom() {
            const modal = document.getElementById('data-import-modal');
            if (!modal) return;
            const outer = modal.querySelector('.import-job-log-outer');
            if (!outer) return;
            requestAnimationFrame(() => {
                outer.scrollTop = outer.scrollHeight;
            });
        }

        function renderJobLogDisplay() {
            const { logPre, idleWrap } = dataImportStatusEls();
            if (!logPre || !idleWrap) return;
            if (runningJobs.size === 0) {
                logPre.hidden = true;
                idleWrap.hidden = false;
                logPre.textContent = '';
                return;
            }
            idleWrap.hidden = true;
            logPre.hidden = false;
            logPre.style.color = '';
            const job = selectedJobKey && runningJobs.get(selectedJobKey);
            logPre.textContent = job && job.lines && job.lines.length ? job.lines.join('\n') : '';
            scrollImportJobLogToBottom();
        }

        function selectJobTab(jobKey) {
            if (!runningJobs.has(jobKey)) return;
            selectedJobKey = jobKey;
            const { tabsStrip } = dataImportStatusEls();
            if (tabsStrip) {
                tabsStrip.querySelectorAll('.import-job-tab').forEach(btn => {
                    const active = btn.getAttribute('data-job-key') === jobKey;
                    btn.classList.toggle('import-job-tab--active', active);
                    btn.setAttribute('aria-selected', active ? 'true' : 'false');
                });
            }
            renderJobLogDisplay();
            syncLegacyConfigStatusLine();
        }

        function addJobTab(jobKey, label) {
            const { tabsStrip } = dataImportStatusEls();
            if (!tabsStrip) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'import-job-tab';
            btn.setAttribute('data-job-key', jobKey);
            btn.setAttribute('role', 'tab');
            btn.textContent = label;
            btn.addEventListener('click', () => selectJobTab(jobKey));
            tabsStrip.appendChild(btn);
            tabsStrip.hidden = false;
        }

        function removeJobTab(jobKey) {
            const { tabsStrip } = dataImportStatusEls();
            if (!tabsStrip) return;
            const btn = tabsStrip.querySelector('[data-job-key="' + String(jobKey).replace(/"/g, '\\"') + '"]');
            if (btn) btn.remove();
            if (!tabsStrip.querySelector('.import-job-tab')) tabsStrip.hidden = true;
        }

        function registerRunningJob(jobKey, importType, extra, labelText) {
            const ex = extra || {};
            runningJobs.set(jobKey, {
                importType,
                zipArchiveType: ex.zipArchiveType || null,
                runReferenceImportAfterLink: !!ex.runReferenceImportAfterLink,
                label: labelText || jobTabLabel(importType, ex),
                lines: [],
                eventSource: null,
                cancelPending: false
            });
            addJobTab(jobKey, runningJobs.get(jobKey).label);
            if (!selectedJobKey || !runningJobs.has(selectedJobKey)) {
                selectedJobKey = jobKey;
            }
            selectJobTab(selectedJobKey);
            syncLegacyConfigStatusLine();
        }

        function closeEventSourceForJob(jobKey) {
            const job = runningJobs.get(jobKey);
            if (job && job.eventSource) {
                try {
                    job.eventSource.close();
                } catch (_) { /* ignore */ }
                job.eventSource = null;
            }
        }

        /** Per-user suffix for email import exclusion cache (AuthModule is available when modals open). */
        function emailImportCurrentUserSuffix() {
            try {
                if (typeof AuthModule !== 'undefined' && AuthModule.getUser) {
                    const u = AuthModule.getUser();
                    if (u && u.id != null) return String(u.id);
                }
            } catch (_) { /* ignore */ }
            return '0';
        }

        function emailImportLocalExcludeKey(kind) {
            return `dm_email_import_exclude_${kind}_u${emailImportCurrentUserSuffix()}`;
        }

        function loadEmailExcludeLinesFromLocal(kind) {
            try {
                const raw = localStorage.getItem(emailImportLocalExcludeKey(kind));
                if (!raw) return null;
                const arr = JSON.parse(raw);
                return Array.isArray(arr) ? arr : null;
            } catch (_) {
                return null;
            }
        }

        function saveEmailExcludeLinesToLocal(kind, lines) {
            try {
                if (!Array.isArray(lines)) return;
                localStorage.setItem(emailImportLocalExcludeKey(kind), JSON.stringify(lines));
            } catch (_) { /* ignore quota */ }
        }

        async function gmailLoadSavedExcludeLabels(excludeLabelsEl) {
            if (!excludeLabelsEl) return;
            let lines = null;
            try {
                const res = await fetch('/api/import-saved-settings/gmail');
                if (res.ok) {
                    const data = await res.json();
                    if (data.ok && data.saved && data.settings && Array.isArray(data.settings.exclude_labels)) {
                        lines = data.settings.exclude_labels;
                    }
                }
            } catch (e) {
                console.debug('Gmail saved exclude labels load skipped:', e);
            }
            if (lines == null) {
                lines = loadEmailExcludeLinesFromLocal('gmail');
            }
            if (lines && lines.length) {
                excludeLabelsEl.value = lines.join('\n');
            }
        }

        async function gmailPersistExcludeLabels(excludeLabelsEl) {
            const lines = excludeLabelsEl
                ? excludeLabelsEl.value.split('\n').map((s) => s.trim()).filter(Boolean)
                : [];
            saveEmailExcludeLinesToLocal('gmail', lines);
            try {
                const res = await fetch('/api/import-saved-settings/gmail', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ exclude_labels: lines })
                });
                if (!res.ok && res.status !== 403) {
                    console.warn('Gmail exclude labels not saved to private store:', res.status);
                }
            } catch (e) {
                console.warn('Gmail exclude labels private store save failed:', e);
            }
        }

        const GMAIL_FORM_IDS_STANDALONE = {
            authWrap: 'gmail-auth-status-wrap',
            authText: 'gmail-auth-status-text',
            authLink: 'gmail-auth-link',
            importControls: 'gmail-import-controls',
            allLabels: 'import-modal-email-all-labels',
            excludeLabelsWrap: 'import-modal-email-exclude-labels-wrap',
            excludeLabels: 'import-modal-email-exclude-labels',
            labelsWrap: 'import-modal-email-labels-wrap',
            labelsSelect: 'import-modal-email-labels',
            newOnly: 'import-modal-email-new-only'
        };

        function gmailImportFormHTML(ids) {
            return `
                <div id="${ids.authWrap}" style="margin-bottom: 15px; padding: 10px; border-radius: 6px; background: #f0f4ff; border: 1px solid #c7d4f0; display: flex; align-items: center; justify-content: space-between; gap: 10px;">
                    <span id="${ids.authText}" style="font-size: 0.95em;">Checking Gmail authentication…</span>
                    <a id="${ids.authLink}" href="/gmail/auth/start" style="display: none; padding: 5px 12px; background: #4285f4; color: #fff; border-radius: 4px; text-decoration: none; font-size: 0.9em; font-weight: 500;">Connect Gmail</a>
                </div>
                <div id="${ids.importControls}" style="display: none;">
                    <div class="setting-group" style="margin-bottom: 15px;">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="${ids.allLabels}" style="cursor: pointer;">
                            <span>Process All Labels</span>
                        </label>
                    </div>
                    <div id="${ids.excludeLabelsWrap}" class="setting-group" style="margin-bottom: 15px; display: none;">
                        <label for="${ids.excludeLabels}" style="display: block; margin-bottom: 5px; font-weight: 500;">Exclude Labels (one regex per line)</label>
                        <textarea id="${ids.excludeLabels}" rows="4" placeholder="e.g.&#10;^Spam$&#10;^Trash.*&#10;.*Promotions.*" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da; font-family: monospace; font-size: 0.9em; resize: vertical; box-sizing: border-box;"></textarea>
                        <small style="color: #666; margin-top: 4px; display: block;">Labels matching any pattern will be skipped.</small>
                    </div>
                    <div id="${ids.labelsWrap}" class="setting-group import-dialog-labels-folders-section" style="margin-bottom: 15px;">
                        <label for="${ids.labelsSelect}" style="display: block; margin-bottom: 5px; font-weight: 500;">Select Labels</label>
                        <select id="${ids.labelsSelect}" class="import-dialog-folders-pane" multiple style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da;">
                            <option value="">Loading labels…</option>
                        </select>
                        <small style="color: #666; margin-top: 4px; display: block;">Hold Ctrl/Cmd to select multiple</small>
                    </div>
                    <div class="setting-group" style="margin-bottom: 15px;">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="${ids.newOnly}" style="cursor: pointer;">
                            <span>New Only (skip already imported emails)</span>
                        </label>
                    </div>
                </div>`;
        }

        function imapImportFormHTML(ids) {
            return `
                <div class="setting-group" style="margin-bottom: 15px;">
                    <label for="${ids.host}" style="display: block; margin-bottom: 5px; font-weight: 500;">IMAP Host</label>
                    <input type="text" id="${ids.host}" placeholder="e.g., imap.outlook.com" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da;">
                </div>
                <div class="setting-group" style="margin-bottom: 15px; display: flex; gap: 10px; align-items: flex-end;">
                    <div style="flex: 1;">
                        <label for="${ids.port}" style="display: block; margin-bottom: 5px; font-weight: 500;">Port</label>
                        <input type="number" id="${ids.port}" placeholder="993" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da;">
                    </div>
                    <div style="margin-bottom: 9px;">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="${ids.useSsl}" style="cursor: pointer;">
                            <span>SSL/TLS</span>
                        </label>
                    </div>
                </div>
                <div class="setting-group" style="margin-bottom: 15px;">
                    <label for="${ids.username}" style="display: block; margin-bottom: 5px; font-weight: 500;">Username</label>
                    <input type="text" id="${ids.username}" placeholder="your@email.com" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da;">
                </div>
                <div class="setting-group" style="margin-bottom: 15px;">
                    <label for="${ids.password}" style="display: block; margin-bottom: 5px; font-weight: 500;">Password</label>
                    <input type="password" id="${ids.password}" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da;">
                </div>
                <div class="setting-group" style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
                    <button type="button" id="${ids.fetchBtn}" style="padding: 6px 14px; border-radius: 4px; border: 1px solid #bfc9da; cursor: pointer; background: #e8f0fe; font-weight: 500;">Fetch Folders</button>
                    <span id="${ids.fetchStatus}" style="font-size: 0.9em; color: #666;"></span>
                </div>
                <div class="setting-group" style="margin-bottom: 15px;">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="${ids.allFolders}" style="cursor: pointer;">
                        <span>Process All Folders</span>
                    </label>
                </div>
                <div id="${ids.excludeFoldersWrap}" class="setting-group" style="margin-bottom: 15px; display: none;">
                    <label for="${ids.excludeFolders}" style="display: block; margin-bottom: 5px; font-weight: 500;">Exclude Folders (one regex per line)</label>
                    <textarea id="${ids.excludeFolders}" rows="4" placeholder="e.g.&#10;^Spam$&#10;^Trash&#10;.*Junk.*" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da; font-family: monospace; font-size: 0.9em; resize: vertical; box-sizing: border-box;"></textarea>
                    <small style="color: #666; margin-top: 4px; display: block;">Folders matching any pattern will be skipped.</small>
                </div>
                <div id="${ids.foldersWrap}" class="setting-group import-dialog-labels-folders-section" style="margin-bottom: 15px; display: none;">
                    <label for="${ids.foldersSelect}" style="display: block; margin-bottom: 5px; font-weight: 500;">Select Folders</label>
                    <select id="${ids.foldersSelect}" class="import-dialog-folders-pane" multiple style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da;"></select>
                    <small style="color: #666; margin-top: 4px; display: block;">Hold Ctrl/Cmd to select multiple</small>
                </div>
                <div class="setting-group" style="margin-bottom: 15px;">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="${ids.newOnly}" style="cursor: pointer;">
                        <span>New Only (skip already imported emails)</span>
                    </label>
                </div>`;
        }

        const IMAP_FORM_IDS_STANDALONE = {
            host: 'imap-modal-host',
            port: 'imap-modal-port',
            useSsl: 'imap-modal-use-ssl',
            username: 'imap-modal-username',
            password: 'imap-modal-password',
            fetchBtn: 'imap-modal-fetch-folders',
            fetchStatus: 'imap-modal-fetch-status',
            allFolders: 'imap-modal-all-folders',
            excludeFoldersWrap: 'imap-modal-exclude-folders-wrap',
            excludeFolders: 'imap-modal-exclude-folders',
            foldersWrap: 'imap-modal-folders-wrap',
            foldersSelect: 'imap-modal-folders',
            newOnly: 'imap-modal-new-only'
        };

        const cancelEndpoints = {
            /* ZIP/TUS archive import (single shared uploadJob on server) */
            upload_zip: '/import/upload/cancel',
            /* Gmail uses gmail_handler job — not the /emails/process stub */
            email_processing: '/gmail/process/cancel',
            imap_processing: '/imap/process/cancel',
            filesystem: '/images/import/cancel',
            reference_import: '/images/import-reference/cancel',
            email_embeddings: '/emails/embeddings/backfill/cancel',
            message_embeddings: '/messages/embeddings/backfill/cancel',
            message_context_embeddings: '/messages/context-embeddings/backfill/cancel',
            image_export: '/images/export/cancel',
            thumbnails: '/images/process-thumbnails/cancel',
            contacts: '/contacts/extract/cancel',
            image_ai_gemma_unclassified: '/image/ai-classification/cancel',
            image_tag_embeddings: '/images/tag-embeddings/backfill/cancel'
        };

        function setImportStatus(text, isError = false) {
            if (runningJobs.size === 0) {
                setImportStatusAllIdle(text, isError);
            } else if (selectedJobKey && runningJobs.has(selectedJobKey)) {
                appendJobLine(selectedJobKey, text);
                const { logPre } = dataImportStatusEls();
                if (logPre) logPre.style.color = isError ? '#ff6b6b' : '';
            }
        }

        /** Resolve running job key + cancel endpoint from a Data Import table row. */
        function rowToJobCancelTarget(row) {
            if (!row) return null;
            const t = row.getAttribute('data-import');
            if (t === 'upload_zip') {
                const z = row.getAttribute('data-zip-archive-type');
                const extra = z ? { zipArchiveType: z } : {};
                return { jobKey: makeJobKey('upload_zip', extra), importType: 'upload_zip' };
            }
            // Reference documents row only opens the manage modal — not the /images/import-reference job.
            if (t === 'reference_modal') {
                return null;
            }
            if (t === 'filesystem_reference' || t === 'upload_photos') {
                return { jobKey: 'filesystem', importType: 'filesystem' };
            }
            if (t === 'thumbnails') {
                if (runningJobs.has('thumbnails_async')) {
                    return { jobKey: 'thumbnails_async', importType: 'thumbnails_async' };
                }
            }
            const importType = t || '';
            return { jobKey: makeJobKey(importType, {}), importType };
        }

        function markJobCancelPending(jobKey) {
            const job = runningJobs.get(jobKey);
            if (!job) return;
            job.cancelPending = true;
            syncDataImportModalRowsFromRunningJobs();
            document.querySelectorAll('.import-execute-btn').forEach(btn => {
                const type = btn.getAttribute('data-import');
                if (type !== job.importType) return;
                btn.classList.add('import-cancel-pending');
                btn.classList.remove('import-executing');
                btn.style.backgroundColor = '';
                btn.innerHTML = '<i class="fas fa-hourglass-half"></i> Stopping';
            });
        }

        async function cancelImportJobForDataImportRow(row) {
            if (!row || !row.classList.contains('import-executing')) return;
            const target = rowToJobCancelTarget(row);
            if (!target) return;
            const job = runningJobs.get(target.jobKey);
            if (!job) return;
            const endpoint = cancelEndpoints[job.importType];
            if (!endpoint) return;
            try {
                const res = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                if (!res.ok) {
                    console.warn('Row cancel HTTP', res.status, await res.text().catch(() => ''));
                    return;
                }
                markJobCancelPending(target.jobKey);
            } catch (e) {
                console.warn('Row cancel error:', e);
            }
        }

        /** Drive Data Import table rows (Processing / per-row Cancel) from runningJobs — required for parallel jobs. */
        function syncDataImportModalRowsFromRunningJobs() {
            const dim = document.getElementById('data-import-modal');
            if (!dim) return;
            dim.querySelectorAll('.data-import-row').forEach(row => {
                const target = rowToJobCancelTarget(row);
                const job = target ? runningJobs.get(target.jobKey) : null;
                const busy = !!job;

                row.classList.toggle('import-executing', busy);

                const rowCancel = row.querySelector('.data-import-row-cancel-btn');
                if (rowCancel) {
                    const showCancel = !!(target && job && cancelEndpoints[job.importType] && !job.cancelPending);
                    rowCancel.hidden = !showCancel;
                    rowCancel.disabled = !showCancel;
                    rowCancel.setAttribute('aria-hidden', showCancel ? 'false' : 'true');
                }

                row.querySelectorAll('.data-import-start-btn, .data-import-zip-start-btn').forEach(b => {
                    b.classList.remove('data-import-start-btn--cancel-pending', 'data-import-btn--processing');
                    if (busy) {
                        if (!b.dataset.importOriginalHtml) b.dataset.importOriginalHtml = b.innerHTML;
                        if (job.cancelPending) {
                            b.innerHTML = '<i class="fas fa-hourglass-half"></i> Stopping';
                            b.classList.add('data-import-start-btn--cancel-pending');
                            b.style.backgroundColor = '';
                            b.disabled = true;
                        } else {
                            b.classList.add('data-import-btn--processing');
                            b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing';
                            b.disabled = true;
                        }
                    } else {
                        b.innerHTML = b.dataset.importOriginalHtml || b.innerHTML;
                        delete b.dataset.importOriginalHtml;
                        b.style.backgroundColor = '';
                        b.disabled = false;
                    }
                });

                row.querySelectorAll('.data-import-open-modal-btn').forEach(b => {
                    const isUploadPhotos = b.getAttribute('data-open-modal') === 'upload-photos-modal';
                    if (isUploadPhotos) {
                        b.disabled = false;
                        return;
                    }
                    b.classList.remove('data-import-start-btn--cancel-pending', 'data-import-btn--processing');
                    if (busy) {
                        if (!b.dataset.importOriginalHtml) b.dataset.importOriginalHtml = b.innerHTML;
                        if (job.cancelPending) {
                            b.innerHTML = '<i class="fas fa-hourglass-half"></i> Stopping';
                            b.classList.add('data-import-start-btn--cancel-pending');
                            b.style.backgroundColor = '';
                            b.disabled = true;
                        } else {
                            b.classList.add('data-import-btn--processing');
                            b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing';
                            b.disabled = true;
                        }
                    } else {
                        b.innerHTML = b.dataset.importOriginalHtml || b.innerHTML;
                        delete b.dataset.importOriginalHtml;
                        b.style.backgroundColor = '';
                        b.disabled = false;
                    }
                });
            });
        }

        function setExecuting(importType, executing, extra = {}) {
            document.querySelectorAll('.import-execute-btn').forEach(btn => {
                const type = btn.getAttribute('data-import');
                if (type === importType) {
                    btn.disabled = executing;
                    if (executing) {
                        btn.classList.remove('import-cancel-pending');
                        if (!btn.dataset.importOriginalHtml) btn.dataset.importOriginalHtml = btn.innerHTML;
                        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing';
                        btn.style.backgroundColor = '#ffc107';
                    } else {
                        btn.innerHTML = btn.dataset.importOriginalHtml || '<i class="fas fa-play"></i> Execute';
                        delete btn.dataset.importOriginalHtml;
                        btn.style.backgroundColor = '';
                        btn.classList.remove('import-cancel-pending');
                    }
                    btn.classList.toggle('import-executing', executing);
                }
            });
            document.querySelectorAll('.import-control-tile').forEach(tile => {
                const type = tile.getAttribute('data-import');
                tile.classList.toggle('import-executing', type === importType && executing);
            });
            syncDataImportModalRowsFromRunningJobs();
        }

        function formatProgressLine(importType, data) {
            if (!data) return '';
            if (data.status_line) return data.status_line;
            if (data.error_message) return data.error_message;
            switch (importType) {
                case 'email_processing':
                    return `Label: ${data.current_label || '-'} | ${data.current_label_index || 0}/${data.total_labels || 0} | ${data.emails_processed || 0} emails processed`;
                case 'imap_processing':
                    return `Folder: ${data.current_folder || '-'} | ${data.current_folder_index || 0}/${data.total_folders || 0} | ${data.emails_processed || 0} emails processed`;
                case 'filesystem':
                    return `File: ${data.current_file || '-'} | ${data.files_processed || 0}/${data.total_files || 0} | ${data.images_imported || 0} imported, ${data.images_referenced || 0} referenced, ${data.images_updated || 0} updated | ${data.errors || 0} errors`;
                case 'reference_import':
                    return `Item: ${data.processed || 0}/${data.total || 0} | ${data.imported || 0} imported, ${data.skipped || 0} skipped | ${data.errors || 0} errors`;
                case 'email_embeddings':
                    return `Email: ${data.processed || 0}/${data.total || 0} | ${data.embedded || 0} embedded, ${data.skipped || 0} skipped | ${data.errors || 0} errors`;
                case 'message_embeddings':
                    return `Message: ${data.processed || 0}/${data.total || 0} | ${data.embedded || 0} embedded, ${data.skipped || 0} skipped | ${data.errors || 0} errors`;
                case 'message_context_embeddings':
                    return `Message: ${data.processed || 0}/${data.total || 0} | ${data.embedded || 0} embedded, ${data.skipped || 0} skipped | ${data.errors || 0} errors`;
                case 'image_export':
                    return `Item: ${data.processed || 0}/${data.total || 0} | ${data.exported || 0} exported, ${data.skipped || 0} skipped | ${data.errors || 0} errors`;
                case 'thumbnails':
                    const p1 = `Phase 1: ${data.phase1_scanned || 0} scanned, ${data.phase1_updated || 0} updated`;
                    const p2 = `Phase 2: ${data.phase2_scanned || 0}/${data.phase2_total || 0} scanned, ${data.phase2_processed || 0} processed, ${data.phase2_errors || 0} errors`;
                    return data.phase === '2' ? `${p1} | ${p2}` : p1;
                case 'contacts':
                    return data.status_line || 'Processing contacts...';
                case 'image_ai_gemma_unclassified':
                    return data.status_line || 'Classifying untagged images...';
                case 'image_tag_embeddings':
                    if (data.status_line) return data.status_line;
                    return `Image tag embeddings: ${data.processed || 0}/${data.total || 0} | ${data.embedded || 0} embedded, ${data.skipped_unchanged || 0} skipped (unchanged), ${data.skipped || 0} skipped (empty), ${data.errors || 0} errors`;
                default:
                    return JSON.stringify(data).substring(0, 100);
            }
        }

        function closeAllImportEventSources() {
            runningJobs.forEach((job, jobKey) => {
                closeEventSourceForJob(jobKey);
            });
        }

        const autoContactsExtractImports = new Set([
            'upload_zip',
            'email_processing',
            'imap_processing'
        ]);

        async function maybeAutoRunContactsExtract(finishedImportType) {
            if (!autoContactsExtractImports.has(finishedImportType)) return;
            if (finishedImportType === 'contacts') return;
            if (runningJobs.has('contacts')) return;

            try {
                const res = await fetch('/contacts/extract/status');
                if (!res.ok) return;
                const status = await res.json();
                if (status && status.in_progress) return;
            } catch (e) {
                console.warn('Auto contacts extract status check failed:', e);
                return;
            }

            try {
                await runImport('contacts', {});
            } catch (e) {
                console.warn('Auto contacts extract start failed:', e);
            }
        }

        function finishImport(jobKey, success, message) {
            const rec = runningJobs.get(jobKey);
            const importType = rec ? rec.importType : null;
            const runRefAfterLink = !!(rec && rec.runReferenceImportAfterLink);
            const extra = rec && rec.zipArchiveType ? { zipArchiveType: rec.zipArchiveType } : {};
            if (message && !success) {
                appendJobLine(jobKey, message);
            }
            closeEventSourceForJob(jobKey);
            runningJobs.delete(jobKey);
            removeJobTab(jobKey);
            if (selectedJobKey === jobKey) {
                selectedJobKey = runningJobs.size ? Array.from(runningJobs.keys())[0] : null;
                if (selectedJobKey) selectJobTab(selectedJobKey);
            }
            if (importType) {
                setExecuting(importType, false, extra);
            }
            if (runningJobs.size === 0) {
                selectedJobKey = null;
                setImportStatusAllIdle(message || 'Idle', !success);
            } else {
                renderJobLogDisplay();
                syncLegacyConfigStatusLine();
            }
            if (typeof loadImportControlLastRun === 'function') loadImportControlLastRun();
            if (typeof loadDataImportModalCounts === 'function') void loadDataImportModalCounts();

            void maybeAutoRunContactsExtract(importType || '');

            if (success && importType === 'filesystem' && runRefAfterLink && !runningJobs.has('reference_import')) {
                void runImport('reference_import', {}).catch((e) => {
                    console.warn('Import Linked Images to Database after filesystem import failed:', e);
                });
            }
        }

        const importConfigs = {
            upload_zip: { needsInput: false, title: 'Upload Archive Import', stream: '/import/upload/stream' },
            email_processing: { needsInput: true, title: 'Email Processing (Gmail)', run: async (vals) => { const body = { all_labels: vals.all_folders || false, label_ids: vals.all_folders ? [] : (vals.label_ids || []), new_only: vals.new_only || false, exclude_labels: vals.exclude_labels || [] }; const r = await fetch('/gmail/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r; }, stream: '/gmail/process/stream' },
            filesystem: { needsInput: true, title: 'Filesystem Image Import', fields: [{ id: 'root_directory', key: 'filesystem_import_directory', label: 'Folder to scan', placeholder: 'Choose a folder or type a full path', required: true, type: 'folder', folderDialogTitle: 'Select folder to import (reference only)' }, { id: 'max_images', key: 'filesystem_import_max_images', label: 'Max Images (Optional)', placeholder: 'Leave empty for all', required: false, type: 'number' }, { id: 'import_db_after_link', key: 'filesystem_import_db_after_link', label: 'Import to Database After Linking', required: false, type: 'checkbox' }], run: async (vals) => { const body = { root_directory: vals.root_directory, create_thumb_and_get_exif: false, reference_mode: true }; if (vals.max_images) body.max_images = parseInt(vals.max_images, 10); const r = await fetch('/images/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r; }, stream: '/images/import/stream' },
            filesystem_reference: { needsInput: true, title: 'Reference images on filesystem (local)', fields: [{ id: 'root_directory', key: 'filesystem_reference_import_directory', label: 'Folder(s) on this machine — separate with semicolons. Each folder is scanned recursively; only paths are stored in the archive (images stay on disk).', placeholder: 'e.g., C:\\Photos\\Vacation; D:\\Pictures', required: true }, { id: 'max_images', key: 'filesystem_reference_import_max_images', label: 'Max images (optional)', placeholder: 'Leave empty for all', required: false, type: 'number' }], run: async (vals) => { const body = { root_directory: vals.root_directory, create_thumb_and_get_exif: false, reference_mode: true }; if (vals.max_images) body.max_images = parseInt(vals.max_images, 10); const r = await fetch('/images/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r; }, stream: '/images/import/stream' },
            reference_import: { needsInput: false, title: 'Import Reference Images to Database', run: async () => { const r = await fetch('/images/import-reference', { method: 'POST' }); return r; }, stream: '/images/import-reference/stream' },
            email_embeddings: { needsInput: false, title: 'Generate missing email embedding vectors', run: async () => { const r = await fetch('/emails/embeddings/backfill', { method: 'POST' }); return r; }, stream: '/emails/embeddings/backfill/stream' },
            message_embeddings: { needsInput: false, title: 'Generate missing message embedding vectors', run: async () => { const r = await fetch('/messages/embeddings/backfill', { method: 'POST' }); return r; }, stream: '/messages/embeddings/backfill/stream' },
            message_context_embeddings: { needsInput: false, title: 'Build message context embeddings', run: async () => { const r = await fetch('/messages/context-embeddings/backfill', { method: 'POST' }); return r; }, stream: '/messages/context-embeddings/backfill/stream' },
            image_export: { needsInput: true, title: 'Export Images to Filesystem', fields: [{ id: 'target_directory', key: 'image_export_directory', label: 'Target Directory', placeholder: 'e.g., C:\\Users\\Dave\\Exports\\images', required: true }], run: async (vals) => { const r = await fetch('/images/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_directory: vals.target_directory }) }); return r; }, stream: '/images/export/stream' },
            thumbnails: { needsInput: false, title: 'Image Processing', run: async () => { const r = await fetch('/images/process-thumbnails', { method: 'POST' }); return r; }, stream: '/images/process-thumbnails/stream' },
            thumbnails_async: { needsInput: false, title: 'Image Processing (Async)', run: async () => { const r = await fetch('/images/process-thumbnails/async', { method: 'POST' }); return r; }, stream: null },
            contacts: { needsInput: false, title: 'Contacts Merge', run: async () => { const r = await fetch('/contacts/extract', { method: 'POST' }); return r; }, stream: '/contacts/extract/stream' },
            image_ai_gemma_unclassified: { needsInput: false, title: 'AI classify images missing GemmaClassified tag', run: async () => { const r = await fetch('/image/ai-classification/missing-gemma-classified', { method: 'POST' }); return r; }, stream: '/image/ai-classification/stream' },
            image_tag_embeddings: { needsInput: false, title: 'Build image tag similarity embeddings', run: async (vals) => { const body = { reprocess_all: !!(vals && vals.reprocess_all) }; const r = await fetch('/images/tag-embeddings/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r; }, stream: '/images/tag-embeddings/backfill/stream' },
            imap_processing: { needsInput: true, title: 'IMAP Import', run: async (vals) => { const body = { host: vals.host, port: vals.port, username: vals.username, password: vals.password, use_ssl: vals.use_ssl !== false, all_folders: vals.all_folders || false, folders: vals.folders && vals.folders.length ? vals.folders : (vals.all_folders ? [] : ['INBOX']), new_only: vals.new_only || false, exclude_folders: vals.exclude_folders || [] }; return await fetch('/imap/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }, stream: '/imap/process/stream' }
        };

        async function wireGmailImportForm(ids, submitButtonHook) {
            const authStatusText = document.getElementById(ids.authText);
            const authLink = document.getElementById(ids.authLink);
            const importControls = document.getElementById(ids.importControls);
            const allLabelsCb = document.getElementById(ids.allLabels);
            const excludeLabelsWrap = document.getElementById(ids.excludeLabelsWrap);
            const excludeLabelsEl = document.getElementById(ids.excludeLabels);
            const labelsWrap = document.getElementById(ids.labelsWrap);
            const labelsSelect = document.getElementById(ids.labelsSelect);
            const newOnlyCb = document.getElementById(ids.newOnly);

            function collectGmailValues() {
                const all_folders = allLabelsCb ? allLabelsCb.checked : false;
                const label_ids = all_folders ? [] : Array.from(labelsSelect.selectedOptions).map(o => o.value).filter(Boolean);
                const new_only = newOnlyCb ? newOnlyCb.checked : true;
                const exclude_labels = (all_folders && excludeLabelsEl) ? excludeLabelsEl.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
                return { all_folders, label_ids, new_only, exclude_labels };
            }

            function validateGmail() {
                const { all_folders, label_ids } = collectGmailValues();
                if (!all_folders && label_ids.length === 0) {
                    return 'Select at least one Gmail label or enable Process All Labels.';
                }
                return null;
            }

            try {
                const authResp = await fetch('/gmail/auth/status');
                const authData = await authResp.json();
                if (!authData.authenticated) {
                    authStatusText.textContent = 'Not connected to Gmail.';
                    authLink.style.display = 'inline-block';
                    if (submitButtonHook) submitButtonHook.disabled = true;
                } else {
                    const expiry = authData.expiry ? ` (token expires ${new Date(authData.expiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'numeric', year: 'numeric' })})` : '';
                    authStatusText.textContent = `Connected to Gmail${expiry}`;
                    authStatusText.style.color = '#27ae60';
                    importControls.style.display = 'block';
                    if (submitButtonHook) submitButtonHook.disabled = false;

                    const allLabelsVal = typeof getControlValue === 'function' ? getControlValue('gmail_all_labels', false) : false;
                    const newOnlyVal = typeof getControlValue === 'function' ? getControlValue('gmail_new_only', true) : true;
                    allLabelsCb.checked = !!allLabelsVal;
                    newOnlyCb.checked = !!newOnlyVal;
                    labelsWrap.style.display = allLabelsCb.checked ? 'none' : 'block';
                    if (excludeLabelsWrap) excludeLabelsWrap.style.display = allLabelsCb.checked ? 'block' : 'none';
                    allLabelsCb.addEventListener('change', () => {
                        labelsWrap.style.display = allLabelsCb.checked ? 'none' : 'block';
                        if (excludeLabelsWrap) excludeLabelsWrap.style.display = allLabelsCb.checked ? 'block' : 'none';
                    });

                    try {
                        const labelsResp = await fetch('/gmail/labels');
                        if (!labelsResp.ok) throw new Error('Failed to load labels');
                        const labelsData = await labelsResp.json();
                        labelsSelect.innerHTML = '';
                        (labelsData.labels || []).forEach(l => {
                            const opt = document.createElement('option');
                            opt.value = l.id;
                            opt.textContent = l.name;
                            if (l.name === 'INBOX') opt.selected = true;
                            labelsSelect.appendChild(opt);
                        });
                    } catch (e) {
                        labelsSelect.innerHTML = '<option value="">Error loading labels</option>';
                    }

                    await gmailLoadSavedExcludeLabels(excludeLabelsEl);
                }
            } catch (e) {
                authStatusText.textContent = 'Could not check Gmail status.';
                authStatusText.style.color = '#c0392b';
            }

            return { collectGmailValues, validateGmail };
        }

        async function showEmailProcessingModal(onSubmit) {
            importInputModalTitle.textContent = 'Email Processing (Gmail)';
            importInputModalBody.innerHTML = gmailImportFormHTML(GMAIL_FORM_IDS_STANDALONE);
            importInputModal.style.display = 'flex';
            importInputModal.style.alignItems = 'center';
            importInputModal.style.justifyContent = 'center';
            const gmailApi = await wireGmailImportForm(GMAIL_FORM_IDS_STANDALONE, importInputModalSubmit);
            const doSubmit = () => {
                const err = gmailApi.validateGmail();
                if (err) return;
                const vals = gmailApi.collectGmailValues();
                if (typeof saveControlValue === 'function') {
                    saveControlValue('gmail_all_labels', vals.all_folders);
                    saveControlValue('gmail_new_only', vals.new_only);
                }
                void gmailPersistExcludeLabels(document.getElementById(GMAIL_FORM_IDS_STANDALONE.excludeLabels));
                importInputModal.style.display = 'none';
                importInputModalSubmit.disabled = false;
                onSubmit(vals);
            };
            importInputModalSubmit.onclick = doSubmit;
            importInputModalCancel.onclick = () => { importInputModal.style.display = 'none'; importInputModalSubmit.disabled = false; };
            importInputModal.onclick = (e) => { if (e.target === importInputModal) { importInputModal.style.display = 'none'; importInputModalSubmit.disabled = false; } };
        }

        async function wireImapImportForm(ids) {
            const hostEl = document.getElementById(ids.host);
            const portEl = document.getElementById(ids.port);
            const useSslEl = document.getElementById(ids.useSsl);
            const usernameEl = document.getElementById(ids.username);
            const passwordEl = document.getElementById(ids.password);
            const fetchBtn = document.getElementById(ids.fetchBtn);
            const fetchStatus = document.getElementById(ids.fetchStatus);
            const allFoldersCb = document.getElementById(ids.allFolders);
            const excludeFoldersWrap = document.getElementById(ids.excludeFoldersWrap);
            const excludeFoldersEl = document.getElementById(ids.excludeFolders);
            const foldersWrap = document.getElementById(ids.foldersWrap);
            const foldersSelect = document.getElementById(ids.foldersSelect);
            const newOnlyCb = document.getElementById(ids.newOnly);

            function imapCollectPayload() {
                const host = hostEl.value.trim();
                const port = parseInt(portEl.value, 10) || 993;
                const username = usernameEl.value.trim();
                const password = passwordEl.value;
                const use_ssl = useSslEl.checked;
                const all_folders = allFoldersCb.checked;
                const new_only = newOnlyCb.checked;
                const folder_options = Array.from(foldersSelect.options).map(function (o) { return o.value; });
                const folders = all_folders ? [] : Array.from(foldersSelect.selectedOptions).map(function (o) { return o.value; }).filter(Boolean);
                const exclude_folders = excludeFoldersEl ? excludeFoldersEl.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
                return { host: host, port: port, username: username, password: password, use_ssl: use_ssl, all_folders: all_folders, new_only: new_only, folders: folders, folder_options: folder_options, exclude_folders: exclude_folders };
            }

            async function imapSaveToPrivateStore() {
                try {
                    const body = imapCollectPayload();
                    saveEmailExcludeLinesToLocal('imap', body.exclude_folders || []);
                    const res = await fetch('/api/import-saved-settings/imap', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    if (!res.ok && res.status !== 403) {
                        console.warn('IMAP settings not saved to private store:', res.status);
                    }
                } catch (e) {
                    console.warn('IMAP settings private store save failed:', e);
                }
            }

            async function imapLoadFromPrivateStore() {
                let appliedServer = false;
                let data = null;
                try {
                    const res = await fetch('/api/import-saved-settings/imap');
                    if (res.ok) {
                        data = await res.json();
                    }
                } catch (e) {
                    console.debug('IMAP saved-settings load skipped:', e);
                }
                try {
                    if (data && data.ok && data.saved && data.settings) {
                        var s = data.settings;
                        hostEl.value = s.host || '';
                        portEl.value = String(s.port != null ? s.port : 993);
                        useSslEl.checked = s.use_ssl !== false;
                        usernameEl.value = s.username || '';
                        passwordEl.value = s.password || '';
                        allFoldersCb.checked = !!s.all_folders;
                        newOnlyCb.checked = s.new_only !== false;
                        if (excludeFoldersEl && Array.isArray(s.exclude_folders)) {
                            excludeFoldersEl.value = s.exclude_folders.join('\n');
                        }
                        if (excludeFoldersWrap) excludeFoldersWrap.style.display = allFoldersCb.checked ? 'block' : 'none';
                        if (Array.isArray(s.folder_options) && s.folder_options.length) {
                            foldersSelect.innerHTML = '';
                            var selectedSet = {};
                            (Array.isArray(s.folders) ? s.folders : []).forEach(function (n) { selectedSet[n] = true; });
                            s.folder_options.forEach(function (f) {
                                var opt = document.createElement('option');
                                opt.value = f;
                                opt.textContent = f;
                                if (selectedSet[f]) opt.selected = true;
                                foldersSelect.appendChild(opt);
                            });
                            if (!allFoldersCb.checked) foldersWrap.style.display = 'block';
                        } else if (Array.isArray(s.folders) && s.folders.length) {
                            foldersSelect.innerHTML = '';
                            s.folders.forEach(function (f) {
                                var opt = document.createElement('option');
                                opt.value = f;
                                opt.textContent = f;
                                opt.selected = true;
                                foldersSelect.appendChild(opt);
                            });
                            if (!allFoldersCb.checked) foldersWrap.style.display = 'block';
                        }
                        appliedServer = true;
                    }
                } catch (e) {
                    console.debug('IMAP saved-settings apply skipped:', e);
                }
                if (!appliedServer && typeof getControlValue === 'function') {
                    var defs = typeof controlDefaults !== 'undefined' ? controlDefaults : {};
                    hostEl.value = getControlValue('imap_host', defs.imap_host || '') || '';
                    portEl.value = getControlValue('imap_port', defs.imap_port || '993') || '993';
                    useSslEl.checked = getControlValue('imap_use_ssl', defs.imap_use_ssl !== undefined ? defs.imap_use_ssl : true) !== false;
                    usernameEl.value = getControlValue('imap_username', defs.imap_username || '') || '';
                    allFoldersCb.checked = !!(getControlValue('imap_all_folders', false));
                    newOnlyCb.checked = !!(getControlValue('imap_new_only', defs.imap_new_only !== undefined ? defs.imap_new_only : true));
                }
                if (excludeFoldersEl && !excludeFoldersEl.value.trim()) {
                    const loc = loadEmailExcludeLinesFromLocal('imap');
                    if (loc && loc.length) excludeFoldersEl.value = loc.join('\n');
                }
                if (excludeFoldersWrap) excludeFoldersWrap.style.display = allFoldersCb.checked ? 'block' : 'none';
            }

            await imapLoadFromPrivateStore();

            allFoldersCb.addEventListener('change', () => {
                foldersWrap.style.display = (!allFoldersCb.checked && foldersSelect.options.length > 0) ? 'block' : 'none';
                if (excludeFoldersWrap) excludeFoldersWrap.style.display = allFoldersCb.checked ? 'block' : 'none';
            });

            fetchBtn.addEventListener('click', async () => {
                const host = hostEl.value.trim();
                const port = parseInt(portEl.value, 10) || 993;
                const username = usernameEl.value.trim();
                const password = passwordEl.value;
                const use_ssl = useSslEl.checked;
                if (!host || !username || !password) {
                    fetchStatus.textContent = 'Fill in host, username, and password first.';
                    fetchStatus.style.color = '#c0392b';
                    return;
                }
                fetchBtn.disabled = true;
                fetchStatus.textContent = 'Connecting...';
                fetchStatus.style.color = '#666';
                try {
                    const resp = await fetch('/imap/folders', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ host, port, username, password, use_ssl })
                    });
                    if (!resp.ok) {
                        const err = await resp.json();
                        fetchStatus.textContent = err.detail || 'Failed to fetch folders';
                        fetchStatus.style.color = '#c0392b';
                        return;
                    }
                    const data = await resp.json();
                    const folders = data.folders || [];
                    foldersSelect.innerHTML = '';
                    folders.forEach(f => {
                        const opt = document.createElement('option');
                        opt.value = f;
                        opt.textContent = f;
                        foldersSelect.appendChild(opt);
                    });
                    const inboxOpt = Array.from(foldersSelect.options).find(o => o.value.toUpperCase() === 'INBOX');
                    if (inboxOpt) inboxOpt.selected = true;
                    fetchStatus.textContent = `${folders.length} folder(s) loaded`;
                    fetchStatus.style.color = '#27ae60';
                    if (!allFoldersCb.checked) foldersWrap.style.display = 'block';
                    if (excludeFoldersWrap) excludeFoldersWrap.style.display = allFoldersCb.checked ? 'block' : 'none';
                    void imapSaveToPrivateStore();
                } catch (e) {
                    fetchStatus.textContent = 'Connection error: ' + e.message;
                    fetchStatus.style.color = '#c0392b';
                } finally {
                    fetchBtn.disabled = false;
                }
            });

            function collectImapValues() {
                const host = hostEl.value.trim();
                const port = parseInt(portEl.value, 10) || 993;
                const username = usernameEl.value.trim();
                const password = passwordEl.value;
                const use_ssl = useSslEl.checked;
                const all_folders = allFoldersCb.checked;
                const folders = all_folders ? [] : Array.from(foldersSelect.selectedOptions).map(o => o.value).filter(Boolean);
                const new_only = newOnlyCb.checked;
                const exclude_folders = excludeFoldersEl ? excludeFoldersEl.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
                return { host, port, username, password, use_ssl, all_folders, folders, new_only, exclude_folders };
            }

            function validateImap() {
                const { host, username, password, all_folders, folders } = collectImapValues();
                if (!host || !username || !password) {
                    return 'Fill in IMAP host, username, and password.';
                }
                if (!all_folders && folders.length === 0 && foldersSelect.options.length > 0) {
                    return 'Select at least one folder or enable Process All Folders.';
                }
                return null;
            }

            return { collectImapValues, validateImap, imapSaveToPrivateStore };
        }

        async function showImapModal(onSubmit) {
            importInputModalTitle.textContent = 'IMAP Import';
            importInputModalBody.innerHTML = imapImportFormHTML(IMAP_FORM_IDS_STANDALONE);
            importInputModal.style.display = 'flex';
            importInputModal.style.alignItems = 'center';
            importInputModal.style.justifyContent = 'center';
            const imapApi = await wireImapImportForm(IMAP_FORM_IDS_STANDALONE);
            const doSubmit = () => {
                const err = imapApi.validateImap();
                if (err) return;
                const vals = imapApi.collectImapValues();
                if (typeof saveControlValue === 'function') {
                    saveControlValue('imap_host', vals.host);
                    saveControlValue('imap_port', String(vals.port));
                    saveControlValue('imap_use_ssl', vals.use_ssl);
                    saveControlValue('imap_username', vals.username);
                    saveControlValue('imap_all_folders', vals.all_folders);
                    saveControlValue('imap_new_only', vals.new_only);
                }
                void imapApi.imapSaveToPrivateStore();
                importInputModal.style.display = 'none';
                onSubmit(vals);
            };
            importInputModalSubmit.onclick = doSubmit;
            importInputModalCancel.onclick = () => { importInputModal.style.display = 'none'; };
            importInputModal.onclick = (e) => { if (e.target === importInputModal) importInputModal.style.display = 'none'; };
        }

        const IMPORT_SAVED_SETTINGS_BASE = '/api/import-saved-settings';
        const IMPORT_DIALOG_PRIVATE_KINDS = {
            filesystem: 'filesystem',
            filesystem_reference: 'filesystem_reference'
        };

        async function importDialogLoadPrivateStore(kind) {
            try {
                const res = await fetch(`${IMPORT_SAVED_SETTINGS_BASE}/${encodeURIComponent(kind)}`);
                if (!res.ok) return null;
                const data = await res.json();
                if (data.ok && data.saved && data.settings && typeof data.settings === 'object') {
                    return data.settings;
                }
            } catch (e) {
                console.debug('import saved-settings load skipped:', e);
            }
            return null;
        }

        async function importDialogSavePrivateStore(kind, settingsObj) {
            try {
                const res = await fetch(`${IMPORT_SAVED_SETTINGS_BASE}/${encodeURIComponent(kind)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(settingsObj)
                });
                if (!res.ok && res.status !== 403) {
                    console.warn('Import dialog settings not saved to private store:', kind, res.status);
                }
            } catch (e) {
                console.warn('Import dialog private store save failed:', e);
            }
        }

        async function showImportModal(importType, onSubmit) {
            const cfg = importConfigs[importType];
            if (!cfg || !cfg.needsInput) { onSubmit({}); return; }
            importInputModalTitle.textContent = cfg.title;
            importInputModalBody.innerHTML = cfg.fields.map(f => {
                if (f.type === 'checkbox') {
                    return `<div class="setting-group" style="margin-bottom: 15px; display: flex; align-items: center; gap: 8px;"><input type="checkbox" id="import-modal-${f.id}" style="width: 16px; height: 16px;"><label for="import-modal-${f.id}" style="font-weight: 500; cursor: pointer;">${f.label}</label></div>`;
                }
                if (f.type === 'folder') {
                    return `<div class="setting-group" style="margin-bottom: 15px;"><label for="import-modal-${f.id}" style="display: block; margin-bottom: 5px; font-weight: 500;">${f.label}</label><div style="display: flex; gap: 8px; align-items: stretch;"><input type="text" id="import-modal-${f.id}" placeholder="${f.placeholder || ''}" style="flex: 1; min-width: 0; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da;"><button type="button" class="modal-btn modal-btn-secondary" id="import-modal-${f.id}-browse" style="white-space: nowrap;">Choose folder…</button></div><p style="margin: 8px 0 0; font-size: 12px; color: #666;">Paths only are stored in the archive; image files remain on disk (reference import).</p></div>`;
                }
                return `<div class="setting-group" style="margin-bottom: 15px;"><label for="import-modal-${f.id}" style="display: block; margin-bottom: 5px; font-weight: 500;">${f.label}</label><input type="${f.type || 'text'}" id="import-modal-${f.id}" placeholder="${f.placeholder || ''}" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #bfc9da;"></div>`;
            }).join('');
            cfg.fields.forEach(f => {
                const el = document.getElementById(`import-modal-${f.id}`);
                if (el && typeof getControlValue === 'function') {
                    const val = getControlValue(f.key, typeof controlDefaults !== 'undefined' ? controlDefaults[f.key] : null);
                    if (f.type === 'checkbox') {
                        el.checked = val === true || val === 'true';
                    } else {
                        el.value = (val !== undefined && val !== null ? String(val) : '') || '';
                    }
                }
            });

            const privKind = IMPORT_DIALOG_PRIVATE_KINDS[importType];
            if (privKind) {
                const s = await importDialogLoadPrivateStore(privKind);
                if (s) {
                    cfg.fields.forEach(f => {
                        const el = document.getElementById(`import-modal-${f.id}`);
                        if (!el || !Object.prototype.hasOwnProperty.call(s, f.id)) return;
                        const v = s[f.id];
                        if (f.type === 'checkbox') {
                            el.checked = !!v;
                        } else {
                            el.value = v != null && v !== undefined ? String(v) : '';
                        }
                    });
                }
            }

            cfg.fields.forEach(f => {
                if (f.type !== 'folder') return;
                const input = document.getElementById(`import-modal-${f.id}`);
                const browse = document.getElementById(`import-modal-${f.id}-browse`);
                if (!input || !browse) return;
                browse.addEventListener('click', async () => {
                    if (!window.electronAPI || typeof window.electronAPI.showOpenDialog !== 'function') {
                        window.alert('Folder picker is only available in the desktop app. You can type the full path in the box instead.');
                        input.focus();
                        return;
                    }
                    try {
                        const picked = await window.electronAPI.showOpenDialog({
                            title: f.folderDialogTitle || 'Select folder',
                            properties: ['openDirectory']
                        });
                        const p = picked && !picked.canceled && picked.filePaths && picked.filePaths.length ? picked.filePaths[0] : '';
                        if (p) {
                            input.value = p;
                            if (typeof saveControlValue === 'function') saveControlValue(f.key, p);
                        }
                    } catch (err) {
                        console.warn('showOpenDialog failed:', err);
                    }
                });
            });

            importInputModal.style.display = 'flex';
            importInputModal.style.alignItems = 'center';
            importInputModal.style.justifyContent = 'center';

            const doSubmit = () => {
                const vals = {};
                let valid = true;
                cfg.fields.forEach(f => {
                    const el = document.getElementById(`import-modal-${f.id}`);
                    if (f.type === 'checkbox') {
                        vals[f.id] = el ? el.checked : false;
                        if (typeof saveControlValue === 'function') saveControlValue(f.key, el ? el.checked : false);
                    } else {
                        const v = el ? el.value.trim() : '';
                        if (f.required && !v) valid = false;
                        vals[f.id] = v;
                        if (typeof saveControlValue === 'function') saveControlValue(f.key, v);
                    }
                });
                if (!valid && cfg.fields.some(f => f.required)) return;
                if (privKind) void importDialogSavePrivateStore(privKind, vals);
                importInputModal.style.display = 'none';
                onSubmit(vals);
            };

            importInputModalSubmit.onclick = doSubmit;
            importInputModalCancel.onclick = () => { importInputModal.style.display = 'none'; };
            importInputModal.onclick = (e) => { if (e.target === importInputModal) importInputModal.style.display = 'none'; };
            importInputModalBody.querySelectorAll('input').forEach(inp => {
                inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } });
            });
        }

        function connectToImportStream(importType, jobKey) {
            const cfg = importConfigs[importType];
            if (!cfg || !cfg.stream) return;
            closeEventSourceForJob(jobKey);
            const es = new EventSource(cfg.stream);
            const job = runningJobs.get(jobKey);
            if (job) job.eventSource = es;
            es.onmessage = (event) => {
                try {
                    const ed = JSON.parse(event.data);
                    const type = ed.type;
                    const data = ed.data || {};
                    if (type === 'progress' || type === 'status') {
                        const line = data.status_line || formatProgressLine(importType, data);
                        appendJobLine(jobKey, line);
                    } else if (type === 'completed') {
                        const line = data.status_line || formatProgressLine(importType, data) || 'Completed successfully';
                        appendJobLine(jobKey, line);
                        finishImport(jobKey, true, line);
                    } else if (type === 'error') {
                        finishImport(jobKey, false, data.error_message || data.status_line || 'Error');
                    } else if (type === 'cancelled') {
                        finishImport(jobKey, false, data.status_line || 'Cancelled');
                    }
                } catch (e) { console.warn('Import SSE parse error:', e); }
            };
            es.onerror = () => {};
        }

        async function runImport(importType, values, extra = {}) {
            const serverKind = importType === 'filesystem_reference' ? 'filesystem' : importType;
            const jobKey = makeJobKey(serverKind, extra);
            if (runningJobs.has(jobKey)) {
                return;
            }
            const cfg = importConfigs[importType];
            if (!cfg) {
                return;
            }
            const jobExtra = Object.assign({}, extra, {
                runReferenceImportAfterLink: importType === 'filesystem' && !!(values && values.import_db_after_link)
            });
            registerRunningJob(jobKey, serverKind, jobExtra);
            setExecuting(serverKind, true, extra);
            appendJobLine(jobKey, 'Starting…');

            try {
                const res = await cfg.run(values);
                let result = {};
                let rawText = '';
                try {
                    rawText = await res.text();
                    if (rawText) result = JSON.parse(rawText);
                } catch (_) {}
                if (!res.ok) {
                    const fallback = (rawText || '').trim();
                    finishImport(jobKey, false, result.detail || fallback || 'Failed to start');
                    return;
                }
                if (cfg.stream) {
                    connectToImportStream(serverKind, jobKey);
                } else {
                    finishImport(jobKey, true, 'Accepted');
                }
            } catch (e) {
                finishImport(jobKey, false, e.message || 'Error');
            }
        }

        function showThumbnailsRunModeModal() {
            return new Promise((resolve) => {
                importInputModalTitle.textContent = 'Thumbnails & location extraction';
                importInputModalBody.innerHTML = '<p style="margin:0 0 12px; color:#444;">Choose how to run this job:</p>' +
                    '<ul style="margin:0 0 16px 18px; color:#555; line-height:1.5;">' +
                    '<li><strong>Continuous updates</strong> — live progress lines in the job log; you can cancel while it runs.</li>' +
                    '<li><strong>Background</strong> — same work on the server without attaching the live stream (log shows start/finish only).</li>' +
                    '</ul>' +
                    '<div style="display:flex; flex-direction:column; gap:10px;">' +
                    '<button type="button" id="thumbnails-run-mode-stream" class="modal-btn modal-btn-primary" style="width:100%;">Continuous updates</button>' +
                    '<button type="button" id="thumbnails-run-mode-bg" class="modal-btn modal-btn-secondary" style="width:100%;">Background</button>' +
                    '</div>';
                const submitBtn = importInputModalSubmit;
                const prevSubmitDisplay = submitBtn.style.display;
                submitBtn.style.display = 'none';
                importInputModal.style.display = 'flex';
                importInputModal.style.alignItems = 'center';
                importInputModal.style.justifyContent = 'center';
                const streamBtn = document.getElementById('thumbnails-run-mode-stream');
                const bgBtn = document.getElementById('thumbnails-run-mode-bg');
                const finish = (value) => {
                    submitBtn.style.display = prevSubmitDisplay || '';
                    importInputModal.style.display = 'none';
                    importInputModalCancel.onclick = null;
                    importInputModal.onclick = null;
                    resolve(value);
                };
                importInputModalCancel.onclick = () => finish(null);
                importInputModal.onclick = (e) => { if (e.target === importInputModal) finish(null); };
                if (streamBtn) streamBtn.onclick = () => finish('stream');
                if (bgBtn) bgBtn.onclick = () => finish('background');
            });
        }

        async function triggerImport(importType) {
            if (!(await ensureMasterKeyForDataImport())) return;
            if (importType === 'thumbnails_prompt') {
                if (runningJobs.has('thumbnails') || runningJobs.has('thumbnails_async')) return;
                const mode = await showThumbnailsRunModeModal();
                if (mode === 'stream') void runImport('thumbnails', {});
                else if (mode === 'background') void runImport('thumbnails_async', {});
                return;
            }
            const jobKey = makeJobKey(importType, {});
            if (runningJobs.has(jobKey)) return;
            if (importType === 'email_processing') {
                showEmailProcessingModal((vals) => runImport(importType, vals));
            } else if (importType === 'imap_processing') {
                showImapModal((vals) => runImport(importType, vals));
            } else if (importType === 'image_tag_embeddings') {
                let reprocessAll = false;
                if (window.AppDialogs && typeof window.AppDialogs.showAppConfirm === 'function') {
                    reprocessAll = await window.AppDialogs.showAppConfirm(
                        'Image tag embeddings',
                        'Do you want to reprocess all tagged images?\n\n' +
                            'Reprocess all: refresh every embedding via local AI (slower).\n' +
                            'Skip unchanged: only embed images where tags changed or no embedding exists yet.',
                        { confirmLabel: 'Reprocess all', cancelLabel: 'Skip unchanged' }
                    );
                }
                await runImport(importType, { reprocess_all: !!reprocessAll });
            } else {
                await showImportModal(importType, (vals) => runImport(importType, vals));
            }
        }

        document.querySelectorAll('.import-execute-btn').forEach(btn => {
            btn.addEventListener('click', () => { void triggerImport(btn.getAttribute('data-import')); });
        });

        let resetDataImportDetailSidebar = () => {};

        (function setupDataImportModalCategoryTabs() {
            const modal = document.getElementById('data-import-modal');
            if (!modal) return;
            const strip = modal.querySelector('.data-import-category-tabstrip');
            if (!strip) return;
            strip.addEventListener('click', (e) => {
                const btn = e.target.closest('.data-import-category-tab');
                if (!btn || !strip.contains(btn)) return;
                const tab = btn.getAttribute('data-import-category-tab');
                if (!tab) return;
                e.preventDefault();
                strip.querySelectorAll('.data-import-category-tab').forEach((b) => {
                    const on = b.getAttribute('data-import-category-tab') === tab;
                    b.classList.toggle('data-import-category-tab--active', on);
                    b.setAttribute('aria-selected', on ? 'true' : 'false');
                });
                modal.querySelectorAll('.data-import-category-panel').forEach((p) => {
                    const on = p.getAttribute('data-import-category-panel') === tab;
                    p.classList.toggle('data-import-category-panel--active', on);
                });
                resetDataImportDetailSidebar();
            });
        })();

        (function setupDataImportDetailSidebar() {
            const modal = document.getElementById('data-import-modal');
            if (!modal) return;
            const ph = modal.querySelector('.data-import-detail-placeholder');
            const content = modal.querySelector('.data-import-detail-content');
            const titleEl = modal.querySelector('.data-import-detail-title');
            const descEl = modal.querySelector('.data-import-detail-desc');
            const entriesEl = modal.querySelector('.data-import-detail-entries');
            const lastRunEl = modal.querySelector('.data-import-detail-last-run');

            function resetSidebar() {
                if (ph) ph.hidden = false;
                if (content) content.hidden = true;
            }

            resetDataImportDetailSidebar = resetSidebar;

            function showCard(card) {
                if (!card || !content || !ph || !titleEl || !descEl || !entriesEl || !lastRunEl) return;
                const titleSrc = card.querySelector('.data-import-card-title');
                const detailBody = card.querySelector('.data-import-card-detail-body');
                const metrics = card.querySelector('.data-import-card-metrics-source');
                const cnt = metrics && metrics.querySelector('.data-import-count');
                const lr = metrics && metrics.querySelector('.data-import-last-run');
                titleEl.innerHTML = titleSrc ? titleSrc.innerHTML : '';
                descEl.innerHTML = detailBody ? detailBody.innerHTML : '';
                entriesEl.textContent = cnt ? cnt.textContent.trim() : '—';
                lastRunEl.textContent = lr ? lr.textContent.trim() : '';
                if (lr && lr.title) lastRunEl.title = lr.title;
                else lastRunEl.removeAttribute('title');
                ph.hidden = true;
                content.hidden = false;
            }

            modal.querySelectorAll('.data-import-card').forEach((card) => {
                card.addEventListener('mouseenter', () => showCard(card));
                card.addEventListener('focusin', () => showCard(card));
            });
        })();

        document.querySelectorAll('.import-control-tile').forEach(tile => {
            tile.addEventListener('click', (e) => {
                const openModal = tile.getAttribute('data-open-modal');
                if (openModal) {
                    if (openModal === 'data-import-modal') {
                        void (async () => {
                            if (!(await ensureMasterKeyForDataImport())) return;
                            const modal = document.getElementById(openModal);
                            if (modal) {
                                modal.style.display = 'flex';
                                if (DOM.configPage) DOM.configPage.style.display = 'none';
                                if (typeof loadControlDefaults === 'function') loadControlDefaults();
                                if (typeof resetDataImportDetailSidebar === 'function') resetDataImportDetailSidebar();
                                if (typeof loadDataImportModalCounts === 'function') void loadDataImportModalCounts();
                                if (typeof loadImportControlLastRun === 'function') loadImportControlLastRun();
                            }
                        })();
                        return;
                    }
                    const modal = document.getElementById(openModal);
                    if (modal) {
                        modal.style.display = 'flex';
                        if (openModal === 'reference-documents-manage-modal') {
                            const dim = document.getElementById('data-import-modal');
                            if (dim) dim.style.display = 'none';
                            if (Modals.ReferenceDocuments && Modals.ReferenceDocuments.loadDocuments) {
                                Modals.ReferenceDocuments.loadDocuments();
                            }
                        }
                    }
                    return;
                }
                const openTab = tile.getAttribute('data-open-tab');
                if (openTab) {
                    const dataImportModal = document.getElementById('data-import-modal');
                    if (dataImportModal) dataImportModal.style.display = 'none';
                    if (DOM.configPage) {
                        DOM.configPage.style.display = 'flex';
                        loadControlDefaults();
                        const tabBtn = document.querySelector(`.config-tab-button[data-tab="${openTab}"]`);
                        if (tabBtn) {
                            tabBtn.click();
                        }
                        refreshSettingsDataImportModalLLM();
                    }
                    return;
                }
                void triggerImport(tile.getAttribute('data-import'));
            });
        });

        (function setupDataImportTableDelegations() {
            // Capture phase: inner .modal-content uses onclick="event.stopPropagation()" which blocks
            // bubbling to the overlay; delegated handlers must run on capture.
            function bindDataImportTableClicks(container, opts) {
                if (!container) return;
                const hideDataImportWhenOpeningRefModal = !!(opts && opts.hideDataImportWhenOpeningRefModal);
                container.addEventListener('click', (e) => {
                    const rowCancelBtn = e.target.closest('.data-import-row-cancel-btn');
                    if (rowCancelBtn && container.contains(rowCancelBtn) && !rowCancelBtn.disabled) {
                        e.preventDefault();
                        e.stopPropagation();
                        const row = rowCancelBtn.closest('.data-import-row');
                        if (row) void cancelImportJobForDataImportRow(row);
                        return;
                    }
                    const startBtn = e.target.closest('.data-import-start-btn');
                    if (startBtn && container.contains(startBtn)) {
                        e.preventDefault();
                        e.stopPropagation();
                        const t = startBtn.getAttribute('data-import-start');
                        if (t) void triggerImport(t);
                        return;
                    }
                    const zipBtn = e.target.closest('.data-import-zip-start-btn');
                    if (zipBtn && container.contains(zipBtn)) {
                        e.preventDefault();
                        e.stopPropagation();
                        const arch = zipBtn.getAttribute('data-zip-archive-type');
                        if (arch && window.UploadImport && typeof window.UploadImport.openZipModalWithArchiveType === 'function') {
                            void (async () => {
                                if (!(await ensureMasterKeyForDataImport())) return;
                                window.UploadImport.openZipModalWithArchiveType(arch);
                            })();
                        }
                        return;
                    }
                    const openM = e.target.closest('.data-import-open-modal-btn');
                    if (openM && container.contains(openM)) {
                        e.preventDefault();
                        e.stopPropagation();
                        void (async () => {
                            if (!(await ensureMasterKeyForDataImport())) return;
                            const mid = openM.getAttribute('data-open-modal');
                            const m = mid ? document.getElementById(mid) : null;
                            if (m) {
                                m.style.display = 'flex';
                                if (mid === 'reference-documents-manage-modal' && hideDataImportWhenOpeningRefModal) {
                                    const dim = document.getElementById('data-import-modal');
                                    if (dim) dim.style.display = 'none';
                                    if (Modals.ReferenceDocuments && Modals.ReferenceDocuments.loadDocuments) {
                                        Modals.ReferenceDocuments.loadDocuments();
                                    }
                                }
                            }
                        })();
                        return;
                    }
                    const delBtn = e.target.closest('.data-import-delete-btn');
                    if (delBtn && container.contains(delBtn) && !delBtn.disabled) {
                        e.preventDefault();
                        e.stopPropagation();
                        const kind = delBtn.getAttribute('data-import-purge-kind');
                        if (!kind) return;
                        void (async () => {
                            if (!(await ensureMasterKeyForDataImport())) return;
                            const ok1 = await AppDialogs.showAppConfirm(
                                'Delete imported data',
                                'This permanently removes archive data for this type. This cannot be undone.\n\nAre you sure you want to continue?',
                                { danger: true }
                            );
                            if (!ok1) return;
                            const ok2 = await AppDialogs.showAppConfirm(
                                'Final confirmation',
                                'Confirm again: delete all data for this import type for your archive.',
                                { danger: true }
                            );
                            if (!ok2) return;
                            try {
                                const res = await fetch('/api/import-data/purge', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ kind }),
                                    credentials: 'same-origin'
                                });
                                const body = await res.json().catch(() => ({}));
                                if (!res.ok) {
                                    throw new Error(body.detail || body.error || `HTTP ${res.status}`);
                                }
                                if (typeof loadDataImportModalCounts === 'function') void loadDataImportModalCounts();
                                if (typeof loadImportControlLastRun === 'function') loadImportControlLastRun();
                            } catch (err) {
                                console.error('Purge failed:', err);
                                if (typeof UI !== 'undefined' && UI.displayError) UI.displayError(err.message || 'Delete failed');
                                else alert(err.message || 'Delete failed');
                            }
                        })();
                    }
                }, true);
            }
            bindDataImportTableClicks(document.getElementById('data-import-modal'), { hideDataImportWhenOpeningRefModal: true });
        })();

        async function checkInitialImportStatus() {
            const types = ['upload_zip','email_processing','imap_processing','filesystem','reference_import','email_embeddings','message_embeddings','message_context_embeddings','image_tag_embeddings','image_export','thumbnails','contacts','image_ai_gemma_unclassified'];
            const statusEndpoints = {
                upload_zip: '/import/upload/status',
                email_processing: '/gmail/process/status',
                imap_processing: '/imap/process/status',
                filesystem: '/images/import/status',
                reference_import: '/images/import-reference/status',
                email_embeddings: '/emails/embeddings/backfill/status',
                message_embeddings: '/messages/embeddings/backfill/status',
                message_context_embeddings: '/messages/context-embeddings/backfill/status',
                image_export: '/images/export/status',
                thumbnails: '/images/process-thumbnails/status',
                contacts: '/contacts/extract/status',
                image_ai_gemma_unclassified: '/image/ai-classification/status',
                image_tag_embeddings: '/images/tag-embeddings/backfill/status'
            };
            for (const t of types) {
                try {
                    const r = await fetch(statusEndpoints[t]);
                    const s = await r.json();
                    if (!s.in_progress) continue;
                    const extra = (t === 'upload_zip' && s.import_type) ? { zipArchiveType: String(s.import_type) } : {};
                    const jobKey = makeJobKey(t, extra);
                    if (runningJobs.has(jobKey)) continue;
                    registerRunningJob(jobKey, t, extra);
                    setExecuting(t, true, extra);
                    if (s.status_line) appendJobLine(jobKey, String(s.status_line));
                    const cfg = importConfigs[t];
                    if (cfg && cfg.stream) {
                        connectToImportStream(t, jobKey);
                    }
                } catch (_) {}
            }
        }
        checkInitialImportStatus();

        // ── Public hook for upload-import.js ────────────────────────────────
        // Called after the upload ZIP modal closes to wire the background import
        // job into the main import status system without going through runImport().
        window.ImportControls = {
            /** @param {string} label Human-readable archive label @param {string} [archiveTypeValue] e.g. whatsapp, facebook — disambiguates parallel ZIP jobs */
            attachUploadStream: function (label, archiveTypeValue) {
                const extra = archiveTypeValue ? { zipArchiveType: String(archiveTypeValue) } : {};
                const jobKey = makeJobKey('upload_zip', extra);
                if (runningJobs.has(jobKey)) return;
                registerRunningJob(jobKey, 'upload_zip', extra);
                setExecuting('upload_zip', true, extra);
                appendJobLine(jobKey, 'Starting ' + (label || 'upload') + ' import…');
                closeEventSourceForJob(jobKey);
                const es = new EventSource('/import/upload/stream');
                const job = runningJobs.get(jobKey);
                if (job) job.eventSource = es;
                es.onmessage = function (event) {
                    try {
                        const ed = JSON.parse(event.data);
                        const type = ed.type;
                        const data = ed.data || {};
                        if (type === 'progress' || type === 'status') {
                            appendJobLine(jobKey, data.status_line || '');
                        } else if (type === 'completed') {
                            finishImport(jobKey, true, data.status_line || 'Upload import completed');
                        } else if (type === 'error') {
                            finishImport(jobKey, false, data.error_message || data.status_line || 'Import error');
                        } else if (type === 'cancelled') {
                            finishImport(jobKey, false, 'Import cancelled');
                        }
                    } catch (e) { /* ignore */ }
                };
                es.onerror = function () { /* SSE auto-reconnects */ };
            },
            /** Wire a running “Upload Photos from Device” job into the Import Status panel. */
            attachFilesystemStream: function () {
                const jobKey = makeJobKey('filesystem', {});
                if (runningJobs.has(jobKey)) return;
                registerRunningJob(jobKey, 'filesystem', {});
                setExecuting('filesystem', true, {});
                appendJobLine(jobKey, 'Starting photo import…');
                closeEventSourceForJob(jobKey);
                const es = new EventSource('/images/import/stream');
                const job = runningJobs.get(jobKey);
                if (job) job.eventSource = es;
                let logLinesShown = 0;
                es.onmessage = function (event) {
                    try {
                        const ed = JSON.parse(event.data);
                        const type = ed.type;
                        const data = ed.data || {};
                        // Replay any server-buffered log lines not yet shown
                        if (Array.isArray(data.log_lines) && data.log_lines.length > logLinesShown) {
                            data.log_lines.slice(logLinesShown).forEach(function (line) {
                                if (line) appendJobLine(jobKey, line);
                            });
                            logLinesShown = data.log_lines.length;
                        } else if ((type === 'progress' || type === 'status') && data.status_line) {
                            appendJobLine(jobKey, data.status_line);
                        }
                        if (type === 'completed') {
                            if (data.status_line) appendJobLine(jobKey, data.status_line);
                            finishImport(jobKey, true, data.status_line || 'Photo import completed');
                            if (window.ImportControls && typeof window.ImportControls.startThumbnailsAfterPhotoImport === 'function') {
                                void window.ImportControls.startThumbnailsAfterPhotoImport();
                            }
                        } else if (type === 'error') {
                            finishImport(jobKey, false, data.error_message || data.status_line || 'Import error');
                        } else if (type === 'cancelled') {
                            finishImport(jobKey, false, 'Import cancelled');
                        }
                    } catch (e) { /* ignore */ }
                };
                es.onerror = function () { /* SSE auto-reconnects */ };
            },
            /** After “Upload Photos from Device” finishes: start async thumbnail/EXIF job and mirror progress in Import status. */
            startThumbnailsAfterPhotoImport: async function () {
                try {
                    const jobKey = makeJobKey('thumbnails', {});
                    if (runningJobs.has(jobKey)) return;
                    const res = await fetch('/images/process-thumbnails/async', { method: 'POST', credentials: 'same-origin' });
                    if (res.status !== 202) return;

                    registerRunningJob(jobKey, 'thumbnails', {});
                    setExecuting('thumbnails', true, {});
                    appendJobLine(jobKey, 'Processing thumbnails for uploaded photos…');
                    closeEventSourceForJob(jobKey);
                    const es = new EventSource('/images/process-thumbnails/stream');
                    const job = runningJobs.get(jobKey);
                    if (job) job.eventSource = es;
                    es.onmessage = function (event) {
                        try {
                            const ed = JSON.parse(event.data);
                            const type = ed.type;
                            const data = ed.data || {};
                            if (type === 'progress' || type === 'status') {
                                const line = data.status_line || formatProgressLine('thumbnails', data);
                                appendJobLine(jobKey, line);
                            } else if (type === 'completed') {
                                finishImport(jobKey, true, data.status_line || formatProgressLine('thumbnails', data) || 'Thumbnail processing completed');
                            } else if (type === 'error') {
                                finishImport(jobKey, false, data.error_message || data.status_line || 'Thumbnail error');
                            } else if (type === 'cancelled') {
                                finishImport(jobKey, false, data.status_line || 'Cancelled');
                            }
                        } catch (e) { /* ignore */ }
                    };
                    es.onerror = function () { /* SSE reconnects */ };
                } catch (e) {
                    console.warn('startThumbnailsAfterPhotoImport:', e);
                }
            }
        };


        
        // Sidebar button event listeners
        if (DOM.fbAlbumsSidebarBtn) {
            DOM.fbAlbumsSidebarBtn.addEventListener('click', () => {
                Modals.FBAlbums.open();
            });
        }
        if (DOM.fbPostsSidebarBtn) {
            DOM.fbPostsSidebarBtn.addEventListener('click', () => {
                Modals.FBPosts.open();
            });
        }

        // if (DOM.imageGallerySidebarBtn) {
        //     DOM.imageGallerySidebarBtn.addEventListener('click', () => {
        //         Modals.ImageGallery.open();
        //     });
        // }

        if (DOM.locationsSidebarBtn) {
            DOM.locationsSidebarBtn.addEventListener('click', () => {
                Modals.Locations.open();
            });
        }

        if (DOM.emailGallerySidebarBtn) {
            DOM.emailGallerySidebarBtn.addEventListener('click', () => {
                Modals.EmailGallery.open();
            });
        }

        if (DOM.newImageGallerySidebarBtn) {
            DOM.newImageGallerySidebarBtn.addEventListener('click', () => {
                Modals.NewImageGallery.open();
            });
        }

        const smsMessagesSidebarBtn = document.getElementById('sms-messages-sidebar-btn');
        if (smsMessagesSidebarBtn) {
            smsMessagesSidebarBtn.addEventListener('click', () => {
                Modals.SMSMessages.open();
            });
        }

        if (DOM.suggestionsSidebarBtn) {
            DOM.suggestionsSidebarBtn.addEventListener('click', () => {
                Modals.Suggestions.open();
            });
        }

        if (DOM.statisticsSidebarBtn) {
            DOM.statisticsSidebarBtn.addEventListener('click', () => {
                if (DOM.statisticsModal) {
                    DOM.statisticsModal.style.display = 'flex';
                    loadDashboard('stats-');
                }
            });
        }
        if (DOM.closeStatisticsModalBtn) {
            DOM.closeStatisticsModalBtn.addEventListener('click', () => {
                if (DOM.statisticsModal) DOM.statisticsModal.style.display = 'none';
            });
        }
        if (DOM.statisticsModal) {
            DOM.statisticsModal.addEventListener('click', (e) => {
                if (e.target === DOM.statisticsModal) DOM.statisticsModal.style.display = 'none';
            });
        }
        const statsRefreshBtn = document.getElementById('stats-dashboard-refresh-btn');
        if (statsRefreshBtn) {
            statsRefreshBtn.addEventListener('click', () => loadDashboard('stats-'));
        }

        // if (DOM.haveYourSaySidebarBtn) {
        //     DOM.haveYourSaySidebarBtn.addEventListener('click', () => {
        //         Modals.HaveYourSay.open();
        //     });
        // }

        const contactsSidebarBtn = document.getElementById('contacts-sidebar-btn');
        if (contactsSidebarBtn) {
            contactsSidebarBtn.addEventListener('click', () => {
                Modals.Contacts.open();
            });
        }

        const messageSimilaritySidebarBtn = document.getElementById('message-similarity-sidebar-btn');
        const messageSimilarityModal = document.getElementById('message-similarity-modal');
        const closeMessageSimilarityModalBtn = document.getElementById('close-message-similarity-modal');
        const messageSimilarityCancelBtn = document.getElementById('message-similarity-cancel-btn');
        const messageSimilarityRunBtn = document.getElementById('message-similarity-run-btn');
        const messageSimilarityText = document.getElementById('message-similarity-text');
        const messageSimilarityN = document.getElementById('message-similarity-n');
        const messageSimilarityStatus = document.getElementById('message-similarity-status');
        const messageSimilarityResults = document.getElementById('message-similarity-results');

        const setMessageSimilarityStatus = (msg, isError = false) => {
            if (!messageSimilarityStatus) return;
            if (!msg) {
                messageSimilarityStatus.style.display = 'none';
                messageSimilarityStatus.textContent = '';
                return;
            }
            messageSimilarityStatus.style.display = 'block';
            messageSimilarityStatus.textContent = msg;
            messageSimilarityStatus.style.color = isError ? '#b91c1c' : '';
        };

        const renderMessageSimilarityResults = (data) => {
            if (!messageSimilarityResults) return;
            messageSimilarityResults.innerHTML = '';
            const results = Array.isArray(data?.results) ? data.results : [];
            const uniqueMessages = Array.isArray(data?.unique_messages) ? data.unique_messages : [];
            if (!results || !results.length) {
                const empty = document.createElement('div');
                empty.className = 'app-card';
                empty.textContent = 'No matches found.';
                messageSimilarityResults.appendChild(empty);
                return;
            }
            if (uniqueMessages.length > 0) {
                const groupCard = document.createElement('div');
                groupCard.className = 'app-card';
                groupCard.style.padding = '10px';
                groupCard.style.border = '1px solid var(--color-border)';
                groupCard.style.borderRadius = '8px';

                const groupHdr = document.createElement('div');
                groupHdr.style.fontWeight = 'bold';
                groupHdr.style.marginBottom = '6px';
                groupHdr.textContent = `Unique grouped messages (${uniqueMessages.length})`;
                groupCard.appendChild(groupHdr);

                uniqueMessages.forEach((m) => {
                    const row = document.createElement('div');
                    row.style.padding = '6px 8px';
                    row.style.marginBottom = '6px';
                    row.style.borderLeft = '3px solid var(--color-blue)';
                    row.style.background = 'var(--color-bg-alt)';
                    row.textContent = `[${m.id}] ${m.chat_session || '(no chat)'}: ${m.text || ''}`;
                    groupCard.appendChild(row);
                });
                messageSimilarityResults.appendChild(groupCard);
            }
            results.forEach((item, idx) => {
                const card = document.createElement('div');
                card.className = 'app-card';
                card.style.padding = '10px';
                card.style.border = '1px solid var(--color-border)';
                card.style.borderRadius = '8px';
                const hdr = document.createElement('div');
                hdr.style.fontWeight = 'bold';
                hdr.style.marginBottom = '6px';
                hdr.textContent = `Match ${idx + 1} | row ${item.row_id} | distance ${item.distance}`;
                card.appendChild(hdr);
                const ids = Array.isArray(item.int_ids) ? item.int_ids : [];
                const idsRow = document.createElement('div');
                idsRow.style.fontSize = '0.9em';
                idsRow.style.color = 'var(--color-text-muted)';
                idsRow.textContent = `message ids: ${ids.join(', ')}`;
                card.appendChild(idsRow);
                messageSimilarityResults.appendChild(card);
            });
        };

        const closeMessageSimilarityModal = () => {
            if (!messageSimilarityModal) return;
            messageSimilarityModal.style.display = 'none';
        };

        if (messageSimilaritySidebarBtn && messageSimilarityModal) {
            messageSimilaritySidebarBtn.addEventListener('click', () => {
                messageSimilarityModal.style.display = 'flex';
                if (messageSimilarityText) messageSimilarityText.focus();
            });
        }
        if (closeMessageSimilarityModalBtn) closeMessageSimilarityModalBtn.addEventListener('click', closeMessageSimilarityModal);
        if (messageSimilarityCancelBtn) messageSimilarityCancelBtn.addEventListener('click', closeMessageSimilarityModal);
        if (messageSimilarityModal) {
            messageSimilarityModal.addEventListener('click', (e) => {
                if (e.target === messageSimilarityModal) closeMessageSimilarityModal();
            });
        }
        if (messageSimilarityRunBtn) {
            messageSimilarityRunBtn.addEventListener('click', async () => {
                const text = (messageSimilarityText?.value || '').trim();
                const nVal = parseInt(messageSimilarityN?.value || '3', 10);
                const n = Number.isFinite(nVal) && nVal > 0 ? nVal : 3;
                if (!text) {
                    setMessageSimilarityStatus('Please enter text to search.', true);
                    return;
                }
                setMessageSimilarityStatus('Searching...');
                renderMessageSimilarityResults({ results: [] });
                messageSimilarityRunBtn.disabled = true;
                try {
                    const res = await fetch('/imessages/similarity-search/unique', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ text, n })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) {
                        throw new Error(data.detail || data.error || `Request failed (${res.status})`);
                    }
                    setMessageSimilarityStatus(`Found ${data.count || 0} match(es).`);
                    renderMessageSimilarityResults(data || {});
                } catch (err) {
                    setMessageSimilarityStatus(`Search failed: ${err.message || err}`, true);
                } finally {
                    messageSimilarityRunBtn.disabled = false;
                }
            });
        }

        const profilesSidebarBtn = document.getElementById('profiles-sidebar-btn');
        if (profilesSidebarBtn) {
            profilesSidebarBtn.addEventListener('click', () => {
                Modals.Profiles.open();
            });
        }

        const relationshipsBtn = document.getElementById('relationships-btn');
        if (relationshipsBtn) {
            relationshipsBtn.addEventListener('click', () => {
                Modals.Relationships.open();
            });
        }

        if (DOM.artefactsSidebarBtn) {
            DOM.artefactsSidebarBtn.addEventListener('click', () => {
                Modals.Artefacts.open();
            });
        }

        if (DOM.sensitiveSidebarBtn) {
            DOM.sensitiveSidebarBtn.addEventListener('click', () => {
                Modals.SensitiveData.open();
            });
        }

        const settingsDataImportSidebarBtn = document.getElementById('settings-data-import-sidebar-btn');
        if (settingsDataImportSidebarBtn && DOM.configPage) {
            settingsDataImportSidebarBtn.addEventListener('click', () => {
                DOM.configPage.style.display = 'flex';
                loadControlDefaults();
                refreshSettingsDataImportModalLLM();
            });
        }

        const emailEditorOpenAttachmentsBtn = document.getElementById('email-editor-open-attachments-btn');
        if (emailEditorOpenAttachmentsBtn) {
            emailEditorOpenAttachmentsBtn.addEventListener('click', async () => {
                if (!(await ensureMasterKeyForDataImport())) return;
                if (Modals.EmailEditor && Modals.EmailEditor.close) Modals.EmailEditor.close();
                if (Modals.EmailAttachments && Modals.EmailAttachments.open) Modals.EmailAttachments.open();
            });
        }

        const emailAttachmentsOpenEmailManagerBtn = document.getElementById('email-attachments-open-email-manager-btn');
        if (emailAttachmentsOpenEmailManagerBtn) {
            emailAttachmentsOpenEmailManagerBtn.addEventListener('click', async () => {
                if (!(await ensureMasterKeyForDataImport())) return;
                if (Modals.EmailAttachments && Modals.EmailAttachments.close) Modals.EmailAttachments.close();
                if (Modals.EmailEditor && Modals.EmailEditor.open) Modals.EmailEditor.open();
            });
        }

        const emailGalleryManageEmailsBtn = document.getElementById('email-gallery-manage-emails-btn');
        if (emailGalleryManageEmailsBtn) {
            emailGalleryManageEmailsBtn.addEventListener('click', async () => {
                if (!(await ensureMasterKeyForDataImport())) return;
                if (Modals.EmailGallery && Modals.EmailGallery.close) Modals.EmailGallery.close();
                if (Modals.EmailEditor && Modals.EmailEditor.open) Modals.EmailEditor.open();
            });
        }

        const dataImportSidebarBtn = document.getElementById('data-import-sidebar-btn');
        const dataImportModal = document.getElementById('data-import-modal');
        const closeDataImportModalBtn = document.getElementById('close-data-import-modal');
        if (dataImportSidebarBtn && dataImportModal) {
            dataImportSidebarBtn.addEventListener('click', () => {
                void (async () => {
                    if (!(await ensureMasterKeyForDataImport())) return;
                    dataImportModal.style.display = 'flex';
                    loadControlDefaults();
                    if (typeof loadDataImportModalCounts === 'function') void loadDataImportModalCounts();
                    if (typeof loadImportControlLastRun === 'function') loadImportControlLastRun();
                })();
            });
        }
        const closeDataImportModal = () => {
            if (dataImportModal) dataImportModal.style.display = 'none';
        };
        if (closeDataImportModalBtn && dataImportModal) {
            closeDataImportModalBtn.addEventListener('click', closeDataImportModal);
        }
        if (dataImportModal) {
            dataImportModal.addEventListener('click', (e) => {
                if (e.target === dataImportModal) closeDataImportModal();
            });
        }

        const referenceDocumentsManageModal = document.getElementById('reference-documents-manage-modal');
        const closeReferenceDocumentsManageBtn = document.getElementById('close-reference-documents-manage-modal');
        const closeReferenceDocumentsManageModal = () => {
            if (referenceDocumentsManageModal) referenceDocumentsManageModal.style.display = 'none';
        };
        if (closeReferenceDocumentsManageBtn && referenceDocumentsManageModal) {
            closeReferenceDocumentsManageBtn.addEventListener('click', closeReferenceDocumentsManageModal);
        }
        if (referenceDocumentsManageModal) {
            referenceDocumentsManageModal.addEventListener('click', (e) => {
                if (e.target === referenceDocumentsManageModal) closeReferenceDocumentsManageModal();
            });
        }

        const randomQuestionSidebarBtn = document.getElementById('random-question-sidebar-btn');
        if (randomQuestionSidebarBtn) {
            randomQuestionSidebarBtn.addEventListener('click', () => {
                App.processQuestionSubmit();
            });
        }

        const todaysThingSidebarBtn = document.getElementById('todays-thing-sidebar-btn');
        const todaysThingAddInterestModal = document.getElementById('todays-thing-add-interest-modal');
        const todaysThingAddInterestInput = document.getElementById('todays-thing-add-interest-input');
        const todaysThingAddInterestError = document.getElementById('todays-thing-add-interest-error');
        const todaysThingAddInterestSave = document.getElementById('todays-thing-add-interest-save');
        const todaysThingAddInterestCancel = document.getElementById('todays-thing-add-interest-cancel');
        const closeTodaysThingAddInterest = document.getElementById('close-todays-thing-add-interest-modal');

        const runTodaysThing = () => App.processFormSubmit(
            "What's today's things of interest? Suggest something interesting for today based on my interests.",
            "Today's Things of Interest",
            "What's going on today?"
        );

        if (todaysThingAddInterestModal && todaysThingAddInterestSave) {
            const closeTodaysThingModal = () => { todaysThingAddInterestModal.style.display = 'none'; };
            todaysThingAddInterestSave.addEventListener('click', async () => {
                const name = (todaysThingAddInterestInput?.value || '').trim();
                if (!name) {
                    if (todaysThingAddInterestError) {
                        todaysThingAddInterestError.textContent = 'Please enter at least one topic.';
                        todaysThingAddInterestError.style.display = 'block';
                    }
                    return;
                }
                if (todaysThingAddInterestError) todaysThingAddInterestError.style.display = 'none';
                try {
                    const postRes = await fetch('/api/interests', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name })
                    });
                    if (!postRes.ok) {
                        const d = await postRes.json().catch(() => ({}));
                        const msg = typeof d.detail === 'string' ? d.detail : 'Failed to save';
                        if (todaysThingAddInterestError) {
                            todaysThingAddInterestError.textContent = msg;
                            todaysThingAddInterestError.style.display = 'block';
                        }
                        return;
                    }
                    closeTodaysThingModal();
                    runTodaysThing();
                } catch (e) {
                    if (todaysThingAddInterestError) {
                        todaysThingAddInterestError.textContent = 'Failed to save: ' + e.message;
                        todaysThingAddInterestError.style.display = 'block';
                    }
                }
            });
            if (todaysThingAddInterestCancel) todaysThingAddInterestCancel.addEventListener('click', closeTodaysThingModal);
            if (closeTodaysThingAddInterest) closeTodaysThingAddInterest.addEventListener('click', closeTodaysThingModal);
            todaysThingAddInterestModal.addEventListener('click', (e) => { if (e.target === todaysThingAddInterestModal) closeTodaysThingModal(); });
        }

        if (todaysThingSidebarBtn) {
            todaysThingSidebarBtn.addEventListener('click', async () => {
                try {
                    const res = await fetch('/api/interests');
                    if (!res.ok) { runTodaysThing(); return; }
                    const data = await res.json();
                    if (data && data.length > 0) {
                        runTodaysThing();
                        return;
                    }
                    if (todaysThingAddInterestModal && todaysThingAddInterestInput) {
                        todaysThingAddInterestInput.value = '';
                        if (todaysThingAddInterestError) { todaysThingAddInterestError.style.display = 'none'; todaysThingAddInterestError.textContent = ''; }
                        todaysThingAddInterestModal.style.display = 'flex';
                    } else {
                        runTodaysThing();
                    }
                } catch (e) {
                    runTodaysThing();
                }
            });
        }

        (function setupWelcomeArchiveOverviewSection() {
            const welcomeModal = document.getElementById('info-box-modal');
            if (!welcomeModal || welcomeModal.classList.contains('info-box-modal-closed')) return;
            if (!document.getElementById('overview-llm-status-body')) return;
            void loadArchiveOverviewLLMStatus();
            void loadDashboard('overview-');
        })();

    }

    async function loadLLMProviderAvailability() {
        const select = DOM.llmProviderSelect;
        if (!select) return;
        try {
            const res = await fetch('/chat/availability', { credentials: 'same-origin' });
            if (!res.ok) return;
            const av = await res.json();
            const gemini_available = !!av.gemini_available;
            const claude_available = !!av.claude_available;
            const deepseek_available = !!av.deepseek_available;
            const localai_available = !!av.localai_available;
            const geminiOpt = select.querySelector('option[value="gemini"]');
            const claudeOpt = select.querySelector('option[value="claude"]');
            const deepseekOpt = select.querySelector('option[value="deepseek"]');
            const localaiOpt = select.querySelector('option[value="localai"]');
            if (geminiOpt) geminiOpt.disabled = !gemini_available;
            if (claudeOpt) claudeOpt.disabled = !claude_available;
            if (deepseekOpt) deepseekOpt.disabled = !deepseek_available;
            if (localaiOpt) localaiOpt.disabled = !localai_available;
            const current = select.value;
            const currentUnavailable =
                (current === 'gemini' && !gemini_available) ||
                (current === 'claude' && !claude_available) ||
                (current === 'deepseek' && !deepseek_available) ||
                (current === 'localai' && !localai_available);
            if (currentUnavailable) {
                select.value = gemini_available ? 'gemini' : (claude_available ? 'claude' : (deepseek_available ? 'deepseek' : (localai_available ? 'localai' : 'gemini')));
            } else {
                // Prefer Local AI as the startup default while still respecting explicit user changes.
                const userSelected = select.dataset.userSelectedProvider === 'true';
                if (!userSelected && localai_available) {
                    select.value = 'localai';
                }
            }
            if (typeof UI !== 'undefined' && UI.updateChatContextStatusBarFromAvailability) {
                UI.updateChatContextStatusBarFromAvailability(av);
            }
        } catch (e) {
            console.error('Failed to load LLM availability:', e);
        }
    }

    function closeMasterKeyUnlockModal() {
        const modal = document.getElementById('master-key-unlock-modal');
        const input = document.getElementById('master-key-unlock-input');
        const errEl = document.getElementById('master-key-unlock-error');
        const submitBtn = document.getElementById('master-key-unlock-submit');
        const visitorBtn = document.getElementById('master-key-unlock-visitor-submit');
        if (modal) modal.style.display = 'none';
        if (input) input.value = '';
        if (errEl) {
            errEl.style.display = 'none';
            errEl.textContent = '';
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Unlock with Master Key';
        }
        if (visitorBtn) {
            visitorBtn.disabled = false;
            visitorBtn.textContent = 'Unlock as visitor';
        }
    }

    /** After welcome info box: offer master key unlock if keyring exists and server RAM has no key yet. */
    function maybePromptMasterKeyUnlock() {
        (async () => {
            try {
                // If the user is authenticated, the login flow auto-unlocks the keyring — no prompt needed.
                if (typeof AuthModule !== 'undefined' && AuthModule.getUser && AuthModule.getUser()) return;
                const kc = await fetch('/sensitive-data/key-count', { credentials: 'same-origin' });
                if (!kc.ok) return;
                const kj = await kc.json();
                if (!kj.count) return;
                const st = await fetch('/api/session/master-key/status', { credentials: 'same-origin' });
                if (!st.ok) return;
                const sj = await st.json();
                if (sj.unlocked) return;
                const modal = document.getElementById('master-key-unlock-modal');
                const input = document.getElementById('master-key-unlock-input');
                if (!modal || !input) return;
                closeMasterKeyUnlockModal();
                modal.style.display = 'flex';
                input.focus();
            } catch (e) {
                console.warn('Master key prompt check failed:', e);
            }
        })();
    }

    async function applyVisitorFeatureGatingFromSession() {
        const deniedTitle = 'Not available for your visitor key. The owner can grant access under Settings → Manage Keys.';
        try {
            const res = await fetch('/auth/me', { credentials: 'same-origin' });
            if (!res.ok) return;
            const me = await res.json().catch(() => null);
            if (!me || !me.is_visitor) {
                window.__visitorAccess = { restricted: false };
                return;
            }
            const va = me.visitor_access;
            if (!va) {
                window.__visitorAccess = { restricted: false };
                return;
            }
            window.__visitorAccess = {
                restricted: !!va.restricted,
                can_messages_chat: !!va.can_messages_chat,
                can_emails: !!va.can_emails,
                can_contacts: !!va.can_contacts,
                can_relationships: !!va.can_relationships,
                can_sensitive_private: !!va.can_sensitive_private,
            };
            if (!va.restricted) return;

            function gate(id, allowed, gateKey) {
                const el = document.getElementById(id);
                if (!el) return;
                el.disabled = !allowed;
                if (allowed) {
                    el.title = '';
                    el.removeAttribute('data-visitor-gate');
                } else {
                    el.title = deniedTitle;
                    el.setAttribute('data-visitor-gate', gateKey);
                }
            }
            gate('sms-messages-sidebar-btn', !!va.can_messages_chat, 'messages_chat');
            gate('email-gallery-sidebar-btn', !!va.can_emails, 'emails');
            gate('contacts-sidebar-btn', !!va.can_contacts, 'contacts');
            gate('relationships-btn', !!va.can_relationships, 'relationship');
            gate('sensitive-data-sidebar-btn', !!va.can_sensitive_private, 'sensitive_private');
            gate('profiles-sidebar-btn', !!va.can_relationships, 'relationship');
        } catch (e) {
            console.warn('Visitor feature gating: /auth/me failed', e);
        }
    }

    async function init() {
        // Info box modal: set up close first (before other inits that might throw)
        window.closeInfoBoxModal = function() {
            const modal = document.getElementById('info-box-modal');
            if (modal) {
                modal.classList.add('info-box-modal-closed');
                if (typeof UI !== 'undefined' && UI.setControlsEnabled) UI.setControlsEnabled(true);
            }
            const geminiOk = CONSTANTS.LLM_PROVIDERS && CONSTANTS.LLM_PROVIDERS.GEMINI === 'True';
            const claudeOk = CONSTANTS.LLM_PROVIDERS && CONSTANTS.LLM_PROVIDERS.CLAUDE === 'True';
            const deepseekOk = CONSTANTS.LLM_PROVIDERS && CONSTANTS.LLM_PROVIDERS.DEEPSEEK === 'True';
            const localaiOk = CONSTANTS.LLM_PROVIDERS && CONSTANTS.LLM_PROVIDERS.LOCALAI === 'True';
            if (!geminiOk && !claudeOk && !deepseekOk && !localaiOk && Modals.ConfirmationModal) {
                Modals.ConfirmationModal.open(
                    'No AI Provider Available',
                    'No LLM provider is available. AI functions will not be available until at least one API key or local endpoint (Gemini, Anthropic, DeepSeek, or Local AI) is set in the server environment (for example in the .env file).',
                    undefined
                );
            }
            maybePromptMasterKeyUnlock();
        };
        const infoBoxModal = document.getElementById('info-box-modal');
        if (infoBoxModal) {
            infoBoxModal.addEventListener('click', (e) => {
                if (e.target === infoBoxModal) window.closeInfoBoxModal();
            });
            document.getElementById('info-box-close-btn')?.addEventListener('click', window.closeInfoBoxModal);
            if (typeof UI !== 'undefined' && UI.setControlsEnabled) UI.setControlsEnabled(false);
        }

        installVisitorFeatureGateCapture();
        Config.init(); // Loads and applies settings, sets up its listeners
        initChatStarfield();
        Chat.renderExistingMessages();
        VoiceSelector.init(); // Sets initial voice state, creativity lock, listeners
        Modals.initAll();
        if (typeof Modals.ConversationManager !== 'undefined' && Modals.ConversationManager.ensureChatConversationContext) {
            await Modals.ConversationManager.ensureChatConversationContext();
        }

        //SSE.init();
        InterviewerMode.init();
        if (typeof ChatVoiceInput !== 'undefined' && ChatVoiceInput.init) ChatVoiceInput.init();
        try {
            initEventListeners(); // Attach main app event listeners
        } catch (e) {
            console.error('initEventListeners failed (some UI may be broken):', e);
        }
        if (DOM.llmProviderSelect) {
            DOM.llmProviderSelect.addEventListener('change', () => {
                DOM.llmProviderSelect.dataset.userSelectedProvider = 'true';
            });
        }
        void applyVisitorFeatureGatingFromSession();
        refreshDataImportMasterKeyAccessUI();
        (function observeConfigModalMasterUnlockRefresh() {
            const el = document.getElementById('config-modal-overlay');
            if (!el) return;
            const run = () => {
                try {
                    if (window.getComputedStyle(el).display !== 'none') refreshDataImportMasterKeyAccessUI();
                } catch (e) { /* ignore */ }
            };
            const obs = new MutationObserver(run);
            obs.observe(el, { attributes: true, attributeFilter: ['style'] });
        })();
        loadLLMProviderAvailability();
        if (typeof UI !== 'undefined' && UI.syncChatContextStatusBarVisibility) {
            UI.syncChatContextStatusBarVisibility();
        }

        const mkSkip = document.getElementById('master-key-unlock-skip');
        const mkSubmit = document.getElementById('master-key-unlock-submit');
        const mkVisitorSubmit = document.getElementById('master-key-unlock-visitor-submit');
        if (mkSkip) mkSkip.addEventListener('click', closeMasterKeyUnlockModal);

        async function runKeyUnlock(endpoint) {
            const input = document.getElementById('master-key-unlock-input');
            const errEl = document.getElementById('master-key-unlock-error');
            const raw = (input && input.value || '').trim();
            const pw = raw.toLowerCase();
            if (!pw) {
                if (errEl) {
                    errEl.textContent = 'Enter a key or choose Skip for now.';
                    errEl.style.display = 'block';
                }
                return;
            }
            if (errEl) errEl.style.display = 'none';
            if (mkSubmit) {
                mkSubmit.disabled = true;
                mkSubmit.textContent = 'Checking\u2026';
            }
            if (mkVisitorSubmit) {
                mkVisitorSubmit.disabled = true;
                mkVisitorSubmit.textContent = 'Checking\u2026';
            }
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ password: pw })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.valid) {
                    if (errEl) {
                        errEl.textContent = data.detail || 'That key does not match. Try again or skip.';
                        errEl.style.display = 'block';
                    }
                    if (mkSubmit) {
                        mkSubmit.disabled = false;
                        mkSubmit.textContent = 'Unlock with Master Key';
                    }
                    if (mkVisitorSubmit) {
                        mkVisitorSubmit.disabled = false;
                        mkVisitorSubmit.textContent = 'Unlock as visitor';
                    }
                    if (input) {
                        input.value = '';
                        input.focus();
                    }
                    return;
                }
                closeMasterKeyUnlockModal();
                refreshDataImportMasterKeyAccessUI();
            } catch (e) {
                if (errEl) {
                    errEl.textContent = e.message || 'Request failed';
                    errEl.style.display = 'block';
                }
                if (mkSubmit) {
                    mkSubmit.disabled = false;
                    mkSubmit.textContent = 'Unlock with Master Key';
                }
                if (mkVisitorSubmit) {
                    mkVisitorSubmit.disabled = false;
                    mkVisitorSubmit.textContent = 'Unlock as visitor';
                }
            }
        }

        if (mkSubmit) {
            mkSubmit.addEventListener('click', () => void runKeyUnlock('/api/session/master-key/unlock'));
        }
        if (mkVisitorSubmit) {
            mkVisitorSubmit.addEventListener('click', () => void runKeyUnlock('/api/session/master-key/unlock-visitor'));
        }

        const visitorHintsModal = document.getElementById('visitor-key-hints-modal');
        const visitorHintsBtn = document.getElementById('master-key-unlock-show-hints');
        const visitorHintsClose = document.getElementById('visitor-key-hints-close');
        const visitorHintsList = document.getElementById('visitor-key-hints-list');
        const visitorHintsEmpty = document.getElementById('visitor-key-hints-empty');
        const visitorHintsErr = document.getElementById('visitor-key-hints-error');
        const visitorHintsLoading = document.getElementById('visitor-key-hints-loading');

        function closeVisitorHintsModal() {
            if (visitorHintsModal) visitorHintsModal.style.display = 'none';
        }

        async function openVisitorHintsModal() {
            if (!visitorHintsModal || !visitorHintsList) return;
            visitorHintsModal.style.display = 'flex';
            if (visitorHintsErr) {
                visitorHintsErr.style.display = 'none';
                visitorHintsErr.textContent = '';
            }
            if (visitorHintsEmpty) visitorHintsEmpty.style.display = 'none';
            visitorHintsList.innerHTML = '';
            if (visitorHintsLoading) visitorHintsLoading.style.display = 'block';
            try {
                const res = await fetch('/api/session/visitor-key-hints');
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(data.detail || `HTTP ${res.status}`);
                }
                const hints = Array.isArray(data.hints) ? data.hints : [];
                if (visitorHintsLoading) visitorHintsLoading.style.display = 'none';
                if (hints.length === 0) {
                    if (visitorHintsEmpty) visitorHintsEmpty.style.display = 'block';
                    return;
                }
                hints.forEach((row) => {
                    const li = document.createElement('li');
                    li.style.marginBottom = '10px';
                    li.style.lineHeight = '1.4';
                    li.textContent = row.hint != null ? String(row.hint) : '';
                    visitorHintsList.appendChild(li);
                });
            } catch (e) {
                if (visitorHintsLoading) visitorHintsLoading.style.display = 'none';
                if (visitorHintsErr) {
                    visitorHintsErr.textContent = e.message || 'Failed to load hints';
                    visitorHintsErr.style.display = 'block';
                }
            }
        }

        if (visitorHintsBtn) visitorHintsBtn.addEventListener('click', () => { void openVisitorHintsModal(); });
        if (visitorHintsClose) visitorHintsClose.addEventListener('click', closeVisitorHintsModal);
        if (visitorHintsModal) {
            visitorHintsModal.addEventListener('click', (e) => {
                if (e.target === visitorHintsModal) closeVisitorHintsModal();
            });
        }

        window.onbeforeunload = () => { SSE.close(); };
    }
    return {
        init,
        processFormSubmit,
        processQuestionSubmit,
        processAnswerSubmit,
        refreshChatAvailability: loadLLMProviderAvailability
    };
})();

void App.init();
