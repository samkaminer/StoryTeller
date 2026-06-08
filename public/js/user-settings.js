// User Settings Module
// Handles user profile and settings management

const SUPPORTED_SOCIAL_PLATFORMS = ['tiktok', 'instagram'];
let socialAccountsRequestInFlight = null;
let socialAccountUiState = {
    isLoading: false,
    actionPlatform: null,
    disconnectingPlatform: null
};

function createDefaultSocialPlatforms() {
    return {
        tiktok: { connected: false, account: null },
        instagram: { connected: false, account: null }
    };
}

function createDefaultSocialPlatformConfigs() {
    return {
        tiktok: { configured: null, missingEnvVars: [], setupError: null },
        instagram: { configured: null, missingEnvVars: [], setupError: null }
    };
}

function createDefaultSocialAccountsState() {
    return {
        socialAccounts: [],
        socialPlatforms: createDefaultSocialPlatforms(),
        socialPlatformConfigs: createDefaultSocialPlatformConfigs()
    };
}

function getSocialPlatformConfig(platform) {
    return appState.userProfile.socialPlatformConfigs?.[platform] || createDefaultSocialPlatformConfigs()[platform];
}

// Apply user settings panel state from appState
function applyUserSettingsPanelState() {
    const panel = document.getElementById('userSettingsPanel'); 
    const overlay = document.getElementById('userSettingsOverlay'); 
    if (!panel || !overlay) {
        console.warn("User settings panel or overlay element not found.");
        return;
    }

    const isOpen = appState.uiState.userSettingsPanel.isOpen;

    if (isOpen) {
        // Close other slide-out panels if they are open
        if (appState.uiState.reportDetailPanel.isOpen) {
            appState.setReportDetailPanelOpen(false);
            if (window.applyReportDetailPanelState) window.applyReportDetailPanelState();
        }
        if (appState.uiState.interviewLivePreviewPanel.isOpen) {
            appState.setInterviewLivePreviewPanelOpen(false);
            if (window.applyInterviewLivePreviewPanelState) window.applyInterviewLivePreviewPanelState();
        }
        if (appState.uiState.pricingPanel.isOpen) {
            appState.setPricingPanelOpen(false);
            if (window.applyPricingPanelState) window.applyPricingPanelState();
        }
        
        // Populate inputs from appState when opening
        const userDisplayNameInput = document.getElementById('userDisplayNameInput');
        const userOrganizationInput = document.getElementById('userOrganizationInput');
        const saveUserSettingsBtn = document.getElementById('saveUserSettingsBtn');
        
        if (userDisplayNameInput) userDisplayNameInput.value = appState.userProfile.displayName || '';
        if (userOrganizationInput) userOrganizationInput.value = appState.userProfile.organization || '';
        if (saveUserSettingsBtn) saveUserSettingsBtn.disabled = true; // Initially disabled until changes are made
        
        // Update Gmail connection status
        updateGmailConnectionStatus();
        socialAccountUiState = { ...socialAccountUiState, isLoading: true };
        updateSocialConnectionStatus();
        setSocialAccountsFeedback('Loading connected accounts…');
        loadSocialAccountsStatus()
            .then(() => {
                setSocialAccountsFeedback('');
            })
            .catch((error) => {
                console.error('Error loading connected accounts:', error);
                setSocialAccountsFeedback(error.message || 'Failed to load connected accounts', 'error');
            })
            .finally(() => {
                socialAccountUiState = { ...socialAccountUiState, isLoading: false };
                updateSocialConnectionStatus();
            });

        panel.style.display = 'flex';
        overlay.style.opacity = '1';
        overlay.style.pointerEvents = 'auto';
        void panel.offsetWidth; // Trigger reflow
        panel.style.transform = 'translateX(0)';
    } else {
        panel.style.transform = 'translateX(100%)';
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        setTimeout(() => {
            if (!appState.uiState.userSettingsPanel.isOpen) { // Check state again
                panel.style.display = 'none';
            }
        }, 300); // Match CSS transition duration
    }
}

// Load user profile from Firebase
async function loadUserProfile() {
    const currentUser = auth.currentUser;
    if (!currentUser) {
        appState.setUserProfile({
            displayName: '',
            organization: '',
            gmailConnected: false,
            gmailEmail: null,
            ...createDefaultSocialAccountsState()
        });
        return;
    }

    try {
        const userDocRef = db.collection('users').doc(currentUser.uid);
        const userDoc = await userDocRef.get();

        if (userDoc.exists) {
            const userData = userDoc.data();
            appState.setUserProfile({
                displayName: userData.displayName || currentUser.displayName || '',
                organization: userData.organization || '',
                torusConfig: userData.torusConfig || null,
                torusConfigs: userData.torusConfigs || [],
                gmailConnected: userData.gmailConnected || false,
                gmailEmail: userData.gmailEmail || null,
                ...createDefaultSocialAccountsState()
            });
        } else {
            // Document doesn't exist, create it
            // For Google users, use their Google profile information as defaults
            const defaultDisplayName = currentUser.displayName || 
                                     currentUser.email.split('@')[0] || 
                                     'New User';
            
            const initialProfile = {
                displayName: defaultDisplayName,
                organization: '',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                email: currentUser.email, // Store email for reference
                photoURL: currentUser.photoURL || null, // Store Google photo if available
                providerId: currentUser.providerData.length > 0 ? currentUser.providerData[0].providerId : 'email' // Track login method
            };
            await userDocRef.set(initialProfile);
            appState.setUserProfile({
                displayName: initialProfile.displayName,
                organization: initialProfile.organization,
                torusConfig: null,
                torusConfigs: [],
                gmailConnected: false,
                gmailEmail: null,
                ...createDefaultSocialAccountsState()
            });
            console.log('User profile document created in Firestore for UID:', currentUser.uid, 'Provider:', initialProfile.providerId);
            
            // Create interview from featured template for new users
            await createInterviewFromFeaturedTemplate(currentUser.uid);
        }
    } catch (error) {
        console.error("Error loading/creating user profile:", error);
        // Fallback to auth user data
        const fallbackDisplayName = currentUser.displayName || 
                                  currentUser.email.split('@')[0] || 
                                  'New User';
        appState.setUserProfile({
            displayName: fallbackDisplayName,
            organization: '',
            torusConfig: null,
            torusConfigs: [],
            gmailConnected: false,
            gmailEmail: null,
            ...createDefaultSocialAccountsState()
        });
    }

    try {
        await loadSocialAccountsStatus();
    } catch (socialError) {
        console.warn('Unable to preload social account status:', socialError.message);
    }
    
    // Update UI if settings panel is open
    if (appState.uiState.userSettingsPanel.isOpen) {
        const userDisplayNameInput = document.getElementById('userDisplayNameInput');
        const userOrganizationInput = document.getElementById('userOrganizationInput');
        const saveUserSettingsBtn = document.getElementById('saveUserSettingsBtn');
        
        if (userDisplayNameInput) userDisplayNameInput.value = appState.userProfile.displayName || '';
        if (userOrganizationInput) userOrganizationInput.value = appState.userProfile.organization || '';
        if (saveUserSettingsBtn) saveUserSettingsBtn.disabled = true;
    }
}

// Create interview from featured template for new users
async function createInterviewFromFeaturedTemplate(userId) {
    try {
        // Find the featured template
        const featuredTemplateSnapshot = await db.collection('templates')
            .where('isFeatured', '==', true)
            .limit(1)
            .get();
        
        if (featuredTemplateSnapshot.empty) {
            console.log('No featured template found for new user onboarding');
            return;
        }
        
        const featuredTemplateDoc = featuredTemplateSnapshot.docs[0];
        const featuredTemplate = featuredTemplateDoc.data();
        
        console.log(`Creating interview from featured template "${featuredTemplate.title}" for new user ${userId}`);
        
        // Prepare the interview data (copy from template, removing template-specific fields)
        const interviewData = {
            ...featuredTemplate,
            // Update the title to indicate it's a sample/demo
            title: `Sample: ${featuredTemplate.title ? featuredTemplate.title.replace(' (Template)', '') : 'Welcome Interview'}`,
            // Ensure category is preserved
            category: featuredTemplate.category || '',
            // Set new interview metadata
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: userId,
            sharedWith: [], // New interview not shared with anyone
            // Add template tracking
            sourceTemplateId: featuredTemplateDoc.id,
            sourceTemplateCreatedBy: featuredTemplate.templateCreatedBy,
            sourceOriginalInterviewId: featuredTemplate.originalInterviewId,
            isOnboardingSample: true // Flag to identify this as the onboarding sample
        };
        
        // Remove template-specific metadata
        delete interviewData.originalInterviewId;
        delete interviewData.templateCreatedAt;
        delete interviewData.templateCreatedBy;
        delete interviewData.templateCreatedByEmail;
        delete interviewData.usageStats;
        delete interviewData.isFeatured;
        delete interviewData.featuredAt;
        delete interviewData.featuredBy;
        
        // Create the interview
        const interviewRef = await db.collection('interviews').add(interviewData);
        
        console.log(`Created onboarding interview ${interviewRef.id} from featured template for user ${userId}`);
        
        // Update template usage statistics
        await db.collection('templates').doc(featuredTemplateDoc.id).update({
            'usageStats.totalInterviewsCreated': firebase.firestore.FieldValue.increment(1),
            'usageStats.lastUsedAt': firebase.firestore.FieldValue.serverTimestamp(),
            'usageStats.onboardingUsageCount': firebase.firestore.FieldValue.increment(1)
        });
        
        // Refresh the interviews list if the function is available
        if (window.refreshInterviewsList) {
            setTimeout(() => {
                window.refreshInterviewsList();
            }, 1000); // Small delay to ensure the interview is fully created
        } else if (window.loadInterviewsGlobal) {
            setTimeout(() => {
                window.loadInterviewsGlobal();
            }, 1000);
        }
        
    } catch (error) {
        console.error('Error creating interview from featured template:', error);
        // Don't throw the error - we don't want to block user creation if this fails
    }
}

// Save user settings to Firebase
async function saveUserSettings() {
    const currentUser = auth.currentUser;
    const userDisplayNameInput = document.getElementById('userDisplayNameInput');
    const userOrganizationInput = document.getElementById('userOrganizationInput');
    const saveUserSettingsBtn = document.getElementById('saveUserSettingsBtn');
    
    if (!currentUser || !userDisplayNameInput || !userOrganizationInput || !saveUserSettingsBtn) {
        alert('Not logged in or panel elements missing.');
        return;
    }

    const newDisplayName = userDisplayNameInput.value.trim();
    const newOrganization = userOrganizationInput.value.trim();

    if (!newDisplayName) {
        alert('Display Name cannot be empty.');
        return;
    }
    
    saveUserSettingsBtn.disabled = true;
    saveUserSettingsBtn.textContent = 'Saving...';

    try {
        if (currentUser.displayName !== newDisplayName) {
            await currentUser.updateProfile({ displayName: newDisplayName });
            console.log('Firebase Auth displayName updated.');
        }

        const userDocRef = db.collection('users').doc(currentUser.uid);
        await userDocRef.set({
            displayName: newDisplayName,
            organization: newOrganization,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log('Firestore user profile updated.');

        appState.setUserProfile({
            displayName: newDisplayName,
            organization: newOrganization
        });
        
        window.updateHeaderInterviewTitle(); // If header shows user-specific info, it might need refresh

        alert('Settings saved successfully!');
        saveUserSettingsBtn.textContent = 'Save Settings'; 
        // Button remains disabled as there are no new changes after save
    } catch (error) {
        console.error("Error saving user settings:", error);
        alert('Error saving settings: ' + error.message);
        saveUserSettingsBtn.disabled = false; 
        saveUserSettingsBtn.textContent = 'Save Settings';
    }
}

// Update Gmail connection status in the UI
function updateGmailConnectionStatus() {
    const gmailNotConnected = document.getElementById('gmailNotConnected');
    const gmailConnected = document.getElementById('gmailConnected');
    const gmailAccountEmail = document.getElementById('gmailAccountEmail');
    
    if (appState.userProfile.gmailConnected) {
        if (gmailNotConnected) gmailNotConnected.classList.add('hidden');
        if (gmailConnected) gmailConnected.classList.remove('hidden');
        if (gmailAccountEmail && appState.userProfile.gmailEmail) {
            gmailAccountEmail.textContent = appState.userProfile.gmailEmail;
        }
    } else {
        if (gmailNotConnected) gmailNotConnected.classList.remove('hidden');
        if (gmailConnected) gmailConnected.classList.add('hidden');
    }
}

function getSocialPlatformState(platform) {
    return appState.userProfile.socialPlatforms?.[platform] || { connected: false, account: null };
}

function getSocialFeedbackElement() {
    return document.getElementById('socialAccountsFeedback');
}

function setSocialAccountsFeedback(message, type = 'info') {
    const feedbackEl = getSocialFeedbackElement();
    if (!feedbackEl) return;

    if (!message) {
        feedbackEl.textContent = '';
        feedbackEl.classList.add('hidden');
        feedbackEl.classList.remove('bg-red-900', 'bg-opacity-20', 'border', 'border-red-600', 'text-red-300');
        feedbackEl.classList.remove('bg-green-900', 'bg-opacity-20', 'border-green-600', 'text-green-300');
        feedbackEl.classList.remove('bg-blue-900', 'border-blue-600', 'text-blue-200');
        return;
    }

    feedbackEl.textContent = message;
    feedbackEl.classList.remove('hidden');
    feedbackEl.classList.remove('bg-red-900', 'bg-opacity-20', 'border', 'border-red-600', 'text-red-300');
    feedbackEl.classList.remove('bg-green-900', 'border-green-600', 'text-green-300');
    feedbackEl.classList.remove('bg-blue-900', 'border-blue-600', 'text-blue-200');
    feedbackEl.classList.add('border');

    if (type === 'error') {
        feedbackEl.classList.add('bg-red-900', 'bg-opacity-20', 'border-red-600', 'text-red-300');
    } else if (type === 'success') {
        feedbackEl.classList.add('bg-green-900', 'bg-opacity-20', 'border-green-600', 'text-green-300');
    } else {
        feedbackEl.classList.add('bg-blue-900', 'bg-opacity-20', 'border-blue-600', 'text-blue-200');
    }
}

function getSocialPlatformLabel(platform) {
    return platform === 'instagram' ? 'Instagram' : 'TikTok';
}

function updateSocialRefreshButton() {
    const refreshBtn = document.getElementById('refreshSocialAccountsBtn');
    if (!refreshBtn) return;

    const isBusy = socialAccountUiState.isLoading || Boolean(socialAccountUiState.actionPlatform) || Boolean(socialAccountUiState.disconnectingPlatform);
    refreshBtn.textContent = socialAccountUiState.isLoading ? 'Refreshing…' : 'Refresh';
    refreshBtn.disabled = isBusy;
    refreshBtn.classList.toggle('opacity-60', isBusy);
    refreshBtn.classList.toggle('cursor-not-allowed', isBusy);
}

function formatSocialStatus(status, connected) {
    if (connected || status === 'active') return 'Connected';
    if (status === 'reauth_required') return 'Reconnect needed';
    if (status === 'disconnected') return 'Disconnected';
    if (status === 'revoked') return 'Access revoked';
    return 'Not connected';
}

function updateSocialPlatformCard(platform) {
    const platformState = getSocialPlatformState(platform);
    const platformConfig = getSocialPlatformConfig(platform);
    const account = platformState.account || null;
    const label = getSocialPlatformLabel(platform);
    const status = account?.status || (platformState.connected ? 'active' : null);
    const isConfigured = platformConfig.configured !== false;
    const requiresSetup = platformConfig.configured === false;
    const isBusy = socialAccountUiState.isLoading || socialAccountUiState.actionPlatform === platform || socialAccountUiState.disconnectingPlatform === platform;
    const canDisconnect = Boolean(account?.socialAccountId) && status !== 'disconnected';
    const shouldShowReconnect = Boolean(account?.socialAccountId) && isConfigured;
    const isConnected = platformState.connected && status === 'active';

    const statusBadge = document.getElementById(`${platform}StatusBadge`);
    const summaryEl = document.getElementById(`${platform}AccountSummary`);
    const metaEl = document.getElementById(`${platform}AccountMeta`);
    const connectBtn = document.getElementById(`connect${platform === 'instagram' ? 'Instagram' : 'Tiktok'}Btn`);
    const reconnectBtn = document.getElementById(`reconnect${platform === 'instagram' ? 'Instagram' : 'Tiktok'}Btn`);
    const disconnectBtn = document.getElementById(`disconnect${platform === 'instagram' ? 'Instagram' : 'Tiktok'}Btn`);

    if (statusBadge) {
        statusBadge.textContent = requiresSetup && !account
            ? 'Setup required'
            : formatSocialStatus(status, isConnected);
        statusBadge.className = 'text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full border';
        if (isConnected) {
            statusBadge.classList.add('border-green-600', 'text-green-300', 'bg-green-900', 'bg-opacity-20');
        } else if (requiresSetup && !account) {
            statusBadge.classList.add('border-yellow-600', 'text-yellow-300', 'bg-yellow-900', 'bg-opacity-20');
        } else if (status === 'reauth_required' || status === 'revoked') {
            statusBadge.classList.add('border-yellow-600', 'text-yellow-300', 'bg-yellow-900', 'bg-opacity-20');
        } else if (status === 'disconnected') {
            statusBadge.classList.add('border-gray-500', 'text-gray-300');
        } else {
            statusBadge.classList.add('border-gray-500', 'text-gray-300');
        }
    }

    if (summaryEl) {
        if (requiresSetup && !account) {
            summaryEl.textContent = `${label} connection is not configured on this server yet.`;
        } else if (!account) {
            summaryEl.textContent = `No ${label} account connected yet.`;
        } else if (account.username) {
            summaryEl.textContent = `${label} account: @${account.username}`;
        } else if (account.displayName) {
            summaryEl.textContent = `${label} account: ${account.displayName}`;
        } else {
            summaryEl.textContent = `${label} account connected.`;
        }
    }

    if (metaEl) {
        if (requiresSetup && !account) {
            if (platformConfig.missingEnvVars?.length) {
                metaEl.textContent = `Missing env vars: ${platformConfig.missingEnvVars.join(', ')}`;
            } else {
                metaEl.textContent = platformConfig.setupError || `Server configuration is incomplete for ${label} connections.`;
            }
        } else if (!account) {
            metaEl.textContent = `Connect ${label} to manage future StoryTeller publishing from your own account.`;
        } else if (account.connectedAt) {
            const connectedDate = new Date(account.connectedAt);
            const readableDate = Number.isNaN(connectedDate.getTime())
                ? account.connectedAt
                : connectedDate.toLocaleString();
            metaEl.textContent = `Status: ${formatSocialStatus(status, isConnected)}${account.hasRefreshToken ? ' • Refresh token available' : ''} • Connected ${readableDate}`;
        } else {
            metaEl.textContent = `Status: ${formatSocialStatus(status, isConnected)}${account.hasRefreshToken ? ' • Refresh token available' : ''}`;
        }
    }

    if (connectBtn) {
        connectBtn.textContent = requiresSetup ? 'Setup required' : (socialAccountUiState.actionPlatform === platform ? `${label}...` : 'Connect');
        connectBtn.disabled = isBusy || requiresSetup;
        connectBtn.classList.toggle('hidden', Boolean(account));
        connectBtn.classList.toggle('opacity-60', connectBtn.disabled);
        connectBtn.classList.toggle('cursor-not-allowed', connectBtn.disabled);
    }

    if (reconnectBtn) {
        reconnectBtn.classList.toggle('hidden', !shouldShowReconnect);
        reconnectBtn.textContent = socialAccountUiState.actionPlatform === platform ? 'Connecting…' : 'Reconnect';
        reconnectBtn.disabled = isBusy || !isConfigured;
        reconnectBtn.classList.toggle('opacity-60', reconnectBtn.disabled);
        reconnectBtn.classList.toggle('cursor-not-allowed', reconnectBtn.disabled);
    }

    if (disconnectBtn) {
        disconnectBtn.classList.toggle('hidden', !canDisconnect);
        disconnectBtn.textContent = socialAccountUiState.disconnectingPlatform === platform ? 'Disconnecting…' : 'Disconnect';
        disconnectBtn.disabled = isBusy;
        disconnectBtn.classList.toggle('opacity-60', disconnectBtn.disabled);
        disconnectBtn.classList.toggle('cursor-not-allowed', disconnectBtn.disabled);
    }
}

function updateSocialConnectionStatus() {
    SUPPORTED_SOCIAL_PLATFORMS.forEach(updateSocialPlatformCard);
    updateSocialRefreshButton();
}

async function loadSocialAccountsStatus(force = false) {
    if (socialAccountsRequestInFlight && !force) {
        return socialAccountsRequestInFlight;
    }

    const currentUser = auth.currentUser;
    if (!currentUser) {
        appState.setUserProfile(createDefaultSocialAccountsState());
        updateSocialConnectionStatus();
        return createDefaultSocialAccountsState();
    }

    socialAccountsRequestInFlight = (async () => {
        const idToken = await currentUser.getIdToken();
        const response = await fetch('/api/social/accounts', {
            headers: {
                'Authorization': `Bearer ${idToken}`
            }
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || 'Failed to load connected accounts');
        }

        appState.setUserProfile({
            socialAccounts: Array.isArray(payload.accounts) ? payload.accounts : [],
            socialPlatforms: payload.platforms || createDefaultSocialPlatforms(),
            socialPlatformConfigs: payload.platformConfigs || createDefaultSocialPlatformConfigs()
        });
        updateSocialConnectionStatus();
        return payload;
    })();

    try {
        return await socialAccountsRequestInFlight;
    } finally {
        socialAccountsRequestInFlight = null;
    }
}

function getPopupFeatures(width = 560, height = 720) {
    const left = Math.max(0, Math.round((window.screen.width - width) / 2));
    const top = Math.max(0, Math.round((window.screen.height - height) / 2));
    return `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
}

function waitForSocialOAuthResult(platform, authWindow) {
    return new Promise((resolve, reject) => {
        let pollTimer = null;

        function cleanup() {
            window.removeEventListener('message', handleMessage);
            if (pollTimer) clearInterval(pollTimer);
        }

        function handleMessage(event) {
            if (event.origin !== window.location.origin) return;
            if (!event.data || !String(event.data.type || '').startsWith('social-oauth-')) return;
            if (event.data.platform !== platform) return;

            cleanup();
            if (authWindow && !authWindow.closed) authWindow.close();

            if (event.data.type === 'social-oauth-success') {
                resolve(event.data);
            } else {
                reject(new Error(event.data.error || `Failed to connect ${getSocialPlatformLabel(platform)}`));
            }
        }

        pollTimer = setInterval(() => {
            if (authWindow && authWindow.closed) {
                cleanup();
                reject(new Error(`${getSocialPlatformLabel(platform)} connection window was closed before it finished.`));
            }
        }, 400);

        window.addEventListener('message', handleMessage);
    });
}

async function startSocialConnect(platform) {
    const currentUser = auth.currentUser;
    if (!currentUser) {
        alert('Please sign in before connecting an account.');
        return;
    }

    socialAccountUiState = { ...socialAccountUiState, actionPlatform: platform };
    setSocialAccountsFeedback(`Starting ${getSocialPlatformLabel(platform)} connection…`);
    updateSocialConnectionStatus();

    try {
        const idToken = await currentUser.getIdToken();
        const response = await fetch(`/api/social/${platform}/connect/start`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${idToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                redirectPath: window.location.pathname,
            })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            let errorMessage = payload.error || `Failed to start ${getSocialPlatformLabel(platform)} connection`;
            if (Array.isArray(payload.missingEnvVars) && payload.missingEnvVars.length) {
                errorMessage = `${errorMessage}. Missing: ${payload.missingEnvVars.join(', ')}`;
            }
            throw new Error(errorMessage);
        }

        const authWindow = window.open(
            payload.authorizeUrl,
            `${platform}Connect`,
            getPopupFeatures()
        );

        if (!authWindow) {
            throw new Error('Popup blocked. Please allow popups and try again.');
        }

        const result = await waitForSocialOAuthResult(platform, authWindow);
        await loadSocialAccountsStatus(true);
        const connectedLabel = result?.account?.username
            ? `@${result.account.username}`
            : (result?.account?.displayName || getSocialPlatformLabel(platform));
        setSocialAccountsFeedback(`${getSocialPlatformLabel(platform)} connected: ${connectedLabel}`, 'success');
    } catch (error) {
        console.error(`Error connecting ${platform}:`, error);
        setSocialAccountsFeedback(error.message || `Failed to connect ${getSocialPlatformLabel(platform)}`, 'error');
        alert(error.message || `Failed to connect ${getSocialPlatformLabel(platform)}`);
    } finally {
        socialAccountUiState = { ...socialAccountUiState, actionPlatform: null };
        updateSocialConnectionStatus();
    }
}

async function disconnectSocialAccount(platform) {
    const platformState = getSocialPlatformState(platform);
    const account = platformState.account || null;
    if (!account?.socialAccountId) return;

    const label = getSocialPlatformLabel(platform);
    if (!confirm(`Disconnect your ${label} account from StoryTeller?`)) {
        return;
    }

    socialAccountUiState = { ...socialAccountUiState, disconnectingPlatform: platform };
    setSocialAccountsFeedback(`Disconnecting ${label}…`);
    updateSocialConnectionStatus();

    try {
        const currentUser = auth.currentUser;
        if (!currentUser) throw new Error('Please sign in before disconnecting an account.');

        const idToken = await currentUser.getIdToken();
        const response = await fetch(`/api/social/accounts/${encodeURIComponent(account.socialAccountId)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${idToken}`
            }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || `Failed to disconnect ${label}`);
        }

        await loadSocialAccountsStatus(true);
        setSocialAccountsFeedback(`${label} disconnected. You can reconnect it any time.`, 'success');
    } catch (error) {
        console.error(`Error disconnecting ${platform}:`, error);
        setSocialAccountsFeedback(error.message || `Failed to disconnect ${label}`, 'error');
        alert(error.message || `Failed to disconnect ${label}`);
    } finally {
        socialAccountUiState = { ...socialAccountUiState, disconnectingPlatform: null };
        updateSocialConnectionStatus();
    }
}

// Connect Gmail account
async function connectGmail() {
    try {
        // Open OAuth popup
        const width = 500;
        const height = 600;
        const left = (window.innerWidth - width) / 2;
        const top = (window.innerHeight - height) / 2;
        
        const authWindow = window.open(
            '/api/gmail/auth',
            'gmailAuth',
            `width=${width},height=${height},left=${left},top=${top}`
        );
        
        // Listen for OAuth completion
        window.addEventListener('message', async function handleOAuthMessage(event) {
            if (event.origin !== window.location.origin) return;
            
            if (event.data.type === 'gmail-oauth-success') {
                window.removeEventListener('message', handleOAuthMessage);
                authWindow.close();
                
                // Update user profile
                const currentUser = auth.currentUser;
                if (currentUser) {
                    await db.collection('users').doc(currentUser.uid).update({
                        gmailConnected: true,
                        gmailEmail: event.data.email,
                        gmailTokens: event.data.tokens,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    
                    appState.setUserProfile({
                        ...appState.userProfile,
                        gmailConnected: true,
                        gmailEmail: event.data.email
                    });
                    
                    updateGmailConnectionStatus();
                    alert('Gmail account connected successfully!');
                }
            } else if (event.data.type === 'gmail-oauth-error') {
                window.removeEventListener('message', handleOAuthMessage);
                authWindow.close();
                alert('Failed to connect Gmail account: ' + event.data.error);
            }
        });
        
    } catch (error) {
        console.error('Error connecting Gmail:', error);
        alert('Error connecting Gmail account: ' + error.message);
    }
}

// Disconnect Gmail account
async function disconnectGmail() {
    if (!confirm('Are you sure you want to disconnect your Gmail account? Emails will be sent using the default service.')) {
        return;
    }
    
    try {
        const currentUser = auth.currentUser;
        if (currentUser) {
            // Revoke tokens on server
            await fetch('/api/gmail/disconnect', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${await currentUser.getIdToken()}`,
                    'Content-Type': 'application/json'
                }
            });
            
            // Update Firestore
            await db.collection('users').doc(currentUser.uid).update({
                gmailConnected: false,
                gmailEmail: null,
                gmailTokens: firebase.firestore.FieldValue.delete(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            appState.setUserProfile({
                ...appState.userProfile,
                gmailConnected: false,
                gmailEmail: null
            });
            
            updateGmailConnectionStatus();
            alert('Gmail account disconnected successfully.');
        }
    } catch (error) {
        console.error('Error disconnecting Gmail:', error);
        alert('Error disconnecting Gmail account: ' + error.message);
    }
}

// Initialize user settings event listeners
function initializeUserSettings() {
    const userSettingsBtn = document.getElementById('userSettingsBtn');
    const closeUserSettingsPanelBtn = document.getElementById('closeUserSettingsPanelBtn');
    const userSettingsOverlay = document.getElementById('userSettingsOverlay');
    const saveUserSettingsBtn = document.getElementById('saveUserSettingsBtn');
    const userDisplayNameInput = document.getElementById('userDisplayNameInput');
    const userOrganizationInput = document.getElementById('userOrganizationInput');
    const connectGmailBtn = document.getElementById('connectGmailBtn');
    const disconnectGmailBtn = document.getElementById('disconnectGmailBtn');
    const refreshSocialAccountsBtn = document.getElementById('refreshSocialAccountsBtn');
    const connectTiktokBtn = document.getElementById('connectTiktokBtn');
    const reconnectTiktokBtn = document.getElementById('reconnectTiktokBtn');
    const disconnectTiktokBtn = document.getElementById('disconnectTiktokBtn');
    const connectInstagramBtn = document.getElementById('connectInstagramBtn');
    const reconnectInstagramBtn = document.getElementById('reconnectInstagramBtn');
    const disconnectInstagramBtn = document.getElementById('disconnectInstagramBtn');
    
    userSettingsBtn?.addEventListener('click', () => {
        appState.setUserSettingsPanelOpen(true);
        applyUserSettingsPanelState(); 
    });
    
    closeUserSettingsPanelBtn?.addEventListener('click', () => {
        appState.setUserSettingsPanelOpen(false);
        applyUserSettingsPanelState();
    });
    
    userSettingsOverlay?.addEventListener('click', () => {
        appState.setUserSettingsPanelOpen(false);
        applyUserSettingsPanelState();
    });
    
    saveUserSettingsBtn?.addEventListener('click', saveUserSettings);

    userDisplayNameInput?.addEventListener('input', () => {
        if (userDisplayNameInput.value.trim() !== appState.userProfile.displayName) {
            if (saveUserSettingsBtn) saveUserSettingsBtn.disabled = false;
        } else if (userOrganizationInput && userOrganizationInput.value.trim() === appState.userProfile.organization) {
            if (saveUserSettingsBtn) saveUserSettingsBtn.disabled = true;
        }
    });
    
    userOrganizationInput?.addEventListener('input', () => {
        if (userOrganizationInput.value.trim() !== appState.userProfile.organization) {
            if (saveUserSettingsBtn) saveUserSettingsBtn.disabled = false;
        } else if (userDisplayNameInput && userDisplayNameInput.value.trim() === appState.userProfile.displayName) {
            if (saveUserSettingsBtn) saveUserSettingsBtn.disabled = true;
        }
    });
    
    // Gmail OAuth event listeners
    connectGmailBtn?.addEventListener('click', connectGmail);
    disconnectGmailBtn?.addEventListener('click', disconnectGmail);

    refreshSocialAccountsBtn?.addEventListener('click', async () => {
        socialAccountUiState = { ...socialAccountUiState, isLoading: true };
        updateSocialConnectionStatus();
        setSocialAccountsFeedback('Refreshing connected accounts…');
        try {
            await loadSocialAccountsStatus(true);
            setSocialAccountsFeedback('Connected accounts refreshed.', 'success');
        } catch (error) {
            console.error('Error refreshing connected accounts:', error);
            setSocialAccountsFeedback(error.message || 'Failed to refresh connected accounts', 'error');
        } finally {
            socialAccountUiState = { ...socialAccountUiState, isLoading: false };
            updateSocialConnectionStatus();
        }
    });

    connectTiktokBtn?.addEventListener('click', () => startSocialConnect('tiktok'));
    reconnectTiktokBtn?.addEventListener('click', () => startSocialConnect('tiktok'));
    disconnectTiktokBtn?.addEventListener('click', () => disconnectSocialAccount('tiktok'));

    connectInstagramBtn?.addEventListener('click', () => startSocialConnect('instagram'));
    reconnectInstagramBtn?.addEventListener('click', () => startSocialConnect('instagram'));
    disconnectInstagramBtn?.addEventListener('click', () => disconnectSocialAccount('instagram'));

    updateSocialConnectionStatus();
}

// Expose functions globally
window.applyUserSettingsPanelState = applyUserSettingsPanelState;
window.loadUserProfile = loadUserProfile;

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeUserSettings); 
