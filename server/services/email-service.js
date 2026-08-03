// Email Service
// Handles email sending through either SendGrid or Gmail based on user configuration

const sgMail = require('@sendgrid/mail');
const { google } = require('googleapis');
const admin = require('firebase-admin');

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

class EmailService {
    /**
     * Send an email using the appropriate service
     * @param {Object} options - Email options
     * @param {string} options.to - Recipient email
     * @param {string} options.subject - Email subject
     * @param {string} options.html - HTML content
     * @param {string} options.text - Plain text content
     * @param {Object} options.user - User object with Gmail configuration
     * @param {Object} options.attachments - Optional attachments
     * @returns {Promise<Object>} Result of email send
     */
    static async send(options) {
        const { to, subject, html, text, user, attachments } = options;
        
        console.log('[EmailService] Send request:', {
            to,
            subject,
            hasUser: !!user,
            gmailConnected: user?.gmailConnected,
            userId: user?.uid,
            hasAttachments: !!(attachments && attachments.length > 0)
        });
        
        // Check if user has Gmail connected
        if (user?.gmailConnected && user?.uid) {
            try {
                console.log('[EmailService] Attempting to send via Gmail...');
                const result = await this.sendViaGmail({
                    to,
                    subject,
                    html,
                    text,
                    userId: user.uid,
                    attachments
                });
                console.log('[EmailService] Gmail send successful:', result);
                return result;
            } catch (error) {
                console.error('[EmailService] Gmail send failed, falling back to SendGrid:', error);
                // Fall back to SendGrid if Gmail fails
            }
        }
        
        // Default to SendGrid
        console.log('[EmailService] Sending via SendGrid...');
        const result = await this.sendViaSendGrid({
            to,
            subject,
            html,
            text,
            attachments
        });
        console.log('[EmailService] SendGrid send successful:', result);
        return result;
    }
    
    /**
     * Send email via Gmail API
     */
    static async sendViaGmail(options) {
        const { to, subject, html, text, userId, attachments } = options;
        
        // Get user's Gmail tokens from Firestore
        const userDoc = await admin.firestore()
            .collection('users')
            .doc(userId)
            .get();
        
        const userData = userDoc.data();
        if (!userData?.gmailConnected || !userData?.gmailTokens) {
            throw new Error('Gmail not connected for user');
        }
        
        // Validate refresh token exists
        if (!userData.gmailTokens.refresh_token) {
            console.error('No refresh token found for user:', userId);
            throw new Error('Gmail refresh token missing - reauthorization required');
        }
        
        // Create OAuth client with user's tokens
        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            process.env.GMAIL_REDIRECT_URI || `${process.env.BASE_URL}/api/gmail/callback`
        );
        oauth2Client.setCredentials(userData.gmailTokens);
        
        // Debug: Log token info (without exposing sensitive data)
        console.log('[Gmail] Token debug:', {
            hasAccessToken: !!userData.gmailTokens.access_token,
            hasRefreshToken: !!userData.gmailTokens.refresh_token,
            tokenLength: userData.gmailTokens.refresh_token?.length,
            expiryDate: userData.gmailTokens.expiry_date,
            isExpired: userData.gmailTokens.expiry_date ? Date.now() > userData.gmailTokens.expiry_date : 'unknown'
        });
        
        // Refresh token if needed
        try {
            // Force refresh to get new access token
            const { credentials } = await oauth2Client.refreshAccessToken();
            
            // Update stored tokens with new credentials
            await admin.firestore()
                .collection('users')
                .doc(userId)
                .update({
                    'gmailTokens': {
                        ...userData.gmailTokens,
                        access_token: credentials.access_token,
                        expiry_date: credentials.expiry_date,
                        // Keep the refresh token if not provided in response
                        refresh_token: credentials.refresh_token || userData.gmailTokens.refresh_token
                    },
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            
            // Update the oauth2Client with new credentials
            oauth2Client.setCredentials(credentials);
        } catch (error) {
            console.error('Error refreshing Gmail token:', error);
            console.error('Token refresh error details:', {
                message: error.message,
                code: error.code,
                response: error.response?.data
            });
            throw new Error('Failed to refresh Gmail access token');
        }
        
        // Create Gmail API instance
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // Create email message with proper MIME structure
        let message;
        
        if (attachments && attachments.length > 0) {
            // Create multipart message with attachments
            const boundary = `boundary_${Date.now()}`;
            const messageParts = [
                `To: ${to}`,
                `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, // Encode subject for emoji support
                'MIME-Version: 1.0',
                `Content-Type: multipart/related; boundary="${boundary}"`,
                '',
                `--${boundary}`,
                'Content-Type: text/html; charset=utf-8',
                'Content-Transfer-Encoding: base64',
                '',
                Buffer.from(html || text).toString('base64'),
            ];
            
            // Add attachments
            for (const attachment of attachments) {
                messageParts.push('');
                messageParts.push(`--${boundary}`);
                messageParts.push(`Content-Type: ${attachment.type || 'application/octet-stream'}`);
                messageParts.push('Content-Transfer-Encoding: base64');
                if (attachment.content_id) {
                    messageParts.push(`Content-ID: <${attachment.content_id}>`);
                }
                messageParts.push(`Content-Disposition: ${attachment.disposition || 'attachment'}; filename="${attachment.filename || 'attachment'}"`);
                messageParts.push('');
                messageParts.push(attachment.content);
            }
            
            messageParts.push('');
            messageParts.push(`--${boundary}--`);
            
            message = messageParts.join('\n');
        } else {
            // Simple message without attachments
            message = [
                `To: ${to}`,
                `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, // Encode subject for emoji support
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset=utf-8',
                'Content-Transfer-Encoding: base64',
                '',
                Buffer.from(html || text).toString('base64')
            ].join('\n');
        }
        
        // Encode entire message to base64 URL-safe
        const encodedMessage = Buffer.from(message)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        
        // Send email
        console.log('[EmailService.sendViaGmail] Sending message via Gmail API...');
        try {
            const result = await gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedMessage
                }
            });
            
            console.log('[EmailService.sendViaGmail] Gmail API response:', {
                id: result.data.id,
                threadId: result.data.threadId,
                labelIds: result.data.labelIds
            });
            
            return {
                success: true,
                messageId: result.data.id,
                service: 'gmail'
            };
        } catch (gmailError) {
            console.error('[EmailService.sendViaGmail] Gmail API error:', gmailError);
            throw gmailError;
        }
    }
    
    /**
     * Send email via SendGrid
     */
    static async sendViaSendGrid(options) {
        const { to, subject, html, text, attachments } = options;
        
        const msg = {
            to,
            from: {
                email: process.env.SENDGRID_FROM_EMAIL || 'noreply@prompter.example.com',
                name: process.env.SENDGRID_FROM_NAME || 'Say'
            },
            subject,
            text: text || this.htmlToText(html),
            html
        };
        
        if (attachments && attachments.length > 0) {
            msg.attachments = attachments;
        }
        
        try {
            const [response] = await sgMail.send(msg);
            return {
                success: true,
                messageId: response.headers['x-message-id'],
                service: 'sendgrid'
            };
        } catch (error) {
            console.error('SendGrid error:', error);
            throw new Error(error.message || 'Failed to send email via SendGrid');
        }
    }
    
    /**
     * Simple HTML to text conversion
     */
    static htmlToText(html) {
        if (!html) return '';
        return html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();
    }
    
    /**
     * Send interview report email
     */
    static async sendInterviewReport(options) {
        const { to, interviewTitle, reportUrl, userName, user } = options;
        
        const subject = `Your interview is ready: ${interviewTitle}`;
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>Hello ${userName},</h2>
                <p>Thank you for sharing your story with Say.</p>
                <p>Your interview transcripts and videos for "${interviewTitle}" are now available to view and share.</p>
                <p>
                    <a href="${reportUrl}" style="display: inline-block; padding: 12px 24px; background-color: #4a90e2; color: white; text-decoration: none; border-radius: 5px;">
                        Access Your Interview
                    </a>
                </p>
                <p>Best,<br>The Say Team</p>
            </div>
        `;
        
        return await this.send({
            to,
            subject,
            html,
            user
        });
    }
    
    /**
     * Send story completion email with thumbnail + watch/archive links
     */
    static async sendStoryComplete(options) {
        const { to, userName, thumbnailUrl, watchUrl, archiveUrl } = options;
        const subject = 'Your story is ready to watch';
        const thumbHtml = thumbnailUrl
            ? `<div style="text-align:center;margin:1.5rem 0;"><img src="${thumbnailUrl}" style="width:140px;border-radius:12px;display:inline-block;" alt="Story thumbnail" /></div>`
            : '';
        const html = `
            <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#F3EDD8;padding:2.5rem 2rem;border-radius:16px;">
                <h1 style="font-family:Georgia,serif;font-style:italic;font-size:1.75rem;font-weight:400;color:#1C1610;margin:0 0 0.75rem;">${userName ? `Hi ${userName},` : 'Your story is ready.'}</h1>
                <p style="color:#7A6E5B;line-height:1.65;margin:0 0 1.5rem;">You've captured something real. Your final telling is ready to watch and share.</p>
                ${thumbHtml}
                <div style="text-align:center;margin:2rem 0;">
                    <a href="${watchUrl}" style="display:inline-block;padding:0.875rem 2.25rem;background:#2C3C6A;color:#fff;text-decoration:none;border-radius:100px;font-size:1rem;font-weight:500;">Watch your story →</a>
                </div>
                <p style="text-align:center;margin-top:0.5rem;">
                    <a href="${archiveUrl}" style="color:#7A6E5B;font-size:0.875rem;text-decoration:none;">View your story archive</a>
                </p>
                <p style="color:#7A6E5B;font-size:0.8125rem;margin-top:2.5rem;border-top:1px solid #D9D0B8;padding-top:1.25rem;">The StoryTeller team</p>
            </div>
        `;
        return await this.send({ to, subject, html });
    }

    /**
     * Send admin notification email
     */
    static async sendAdminNotification(options) {
        const { adminEmail, userName, userEmail, interviewTitle, adminReportUrl, user } = options;
        
        const subject = `New Interview Completed: ${userName}`;
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>Interview Completed</h2>
                <p><strong>Interviewee:</strong> ${userName} (${userEmail})</p>
                <p><strong>Interview:</strong> ${interviewTitle}</p>
                <p>
                    <a href="${adminReportUrl}" style="display: inline-block; padding: 12px 24px; background-color: #4a90e2; color: white; text-decoration: none; border-radius: 5px;">
                        View Report
                    </a>
                </p>
            </div>
        `;
        
        return await this.send({
            to: adminEmail,
            subject,
            html,
            user
        });
    }
}

module.exports = EmailService;