import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

function encodeSubject(subject: string): string {
  // ASCII-only subjects don't need encoding
  if (/^[\x20-\x7E]*$/.test(subject)) {
    return subject;
  }
  // RFC 2047 MIME encoded-word: =?charset?encoding?encoded-text?=
  return '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
}

export class GmailClient {
  private gmail: gmail_v1.Gmail | null = null;
  private auth: OAuth2Client;
  private accountEmail: string;
  
  constructor(auth: OAuth2Client, accountEmail: string) {
    this.auth = auth;
    this.accountEmail = accountEmail;
    this.gmail = google.gmail({ version: 'v1', auth: auth as any });
  }

  getAccountEmail(): string {
    return this.accountEmail;
  }

  async sendEmail(params: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
  }): Promise<string> {
    const { to, subject, body, cc, bcc } = params;
    
    const messageParts = [
      `To: ${to.join(', ')}`,
      `Subject: ${encodeSubject(subject)}`,
    ];
    
    if (cc?.length) messageParts.push(`Cc: ${cc.join(', ')}`);
    if (bcc?.length) messageParts.push(`Bcc: ${bcc.join(', ')}`);
    
    messageParts.push(
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    );
    
    const email = messageParts.join('\r\n');
    const encodedEmail = Buffer.from(email).toString('base64url');
    
    const res = await this.gmail!.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail
      }
    });
    
    return res.data.id!;
  }

  async searchEmails(query: string, maxResults: number = 10): Promise<any> {
    const res = await this.gmail!.users.messages.list({
      userId: 'me',
      q: query,
      maxResults
    });
    
    const messages = await Promise.all(
      (res.data.messages || []).map(async (msg) => {
        const details = await this.getMessage(msg.id!);
        return {
          id: msg.id,
          threadId: msg.threadId,
          snippet: details.snippet,
          subject: this.extractHeader(details, 'Subject'),
          from: this.extractHeader(details, 'From'),
          date: this.extractHeader(details, 'Date')
        };
      })
    );
    
    return {
      messages,
      resultSizeEstimate: res.data.resultSizeEstimate,
      nextPageToken: res.data.nextPageToken
    };
  }

  async getMessage(messageId: string): Promise<any> {
    const res = await this.gmail!.users.messages.get({
      userId: 'me',
      id: messageId
    });
    return res.data;
  }

  async getMessageLight(messageId: string): Promise<{
    id: string;
    threadId: string;
    from: string;
    to: string;
    subject: string;
    date: string;
    snippet: string;
    body: string;
    labels: string[];
    links: string[];
  }> {
    const res = await this.gmail!.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const message = res.data;
    const headers = message.payload?.headers || [];

    // Extract key headers only
    const getHeader = (name: string) =>
      headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    // Extract links from HTML before converting to plain text
    const links = this.extractLinksFromPayload(message.payload);

    // Extract plain text body
    const body = this.extractPlainTextBody(message.payload);

    return {
      id: message.id!,
      threadId: message.threadId!,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      snippet: message.snippet || '',
      body,
      labels: message.labelIds || [],
      links
    };
  }

  private extractPlainTextBody(payload: any): string {
    if (!payload) return '';

    // If this part is plain text, decode and return it
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    // If multipart, search for text/plain part
    if (payload.parts) {
      for (const part of payload.parts) {
        // Prefer text/plain
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        // Recurse into nested multipart
        if (part.mimeType?.startsWith('multipart/')) {
          const nested = this.extractPlainTextBody(part);
          if (nested) return nested;
        }
      }
      // If no plain text found, try to find text/html and note it
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
          // Basic HTML to text conversion - strip tags
          return html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
        }
      }
    }

    return '';
  }

  private extractLinksFromPayload(payload: any): string[] {
    if (!payload) return [];

    const links: Set<string> = new Set();

    // Helper to extract links from HTML
    const extractFromHtml = (html: string) => {
      // Match href attributes in anchor tags
      const hrefRegex = /href=["']([^"']+)["']/gi;
      let match;
      while ((match = hrefRegex.exec(html)) !== null) {
        const url = match[1];
        // Filter out mailto:, javascript:, and # links
        if (url &&
            !url.startsWith('mailto:') &&
            !url.startsWith('javascript:') &&
            !url.startsWith('#') &&
            (url.startsWith('http://') || url.startsWith('https://'))) {
          // Try to extract actual URL from tracking redirects
          const cleanUrl = this.cleanTrackingUrl(url);
          if (cleanUrl) {
            links.add(cleanUrl);
          }
        }
      }
    };

    // Check if this part is HTML
    if (payload.mimeType === 'text/html' && payload.body?.data) {
      const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      extractFromHtml(html);
    }

    // Recurse into multipart
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
          extractFromHtml(html);
        }
        if (part.mimeType?.startsWith('multipart/')) {
          const nestedLinks = this.extractLinksFromPayload(part);
          nestedLinks.forEach(link => links.add(link));
        }
      }
    }

    return Array.from(links);
  }

  private cleanTrackingUrl(url: string): string | null {
    try {
      const parsed = new URL(url);

      // Common tracking URL patterns - try to extract destination
      // Pattern 1: URL in query parameter (e.g., ?url=https://... or ?u=https://...)
      for (const param of ['url', 'u', 'redirect', 'destination', 'target', 'link']) {
        const destUrl = parsed.searchParams.get(param);
        if (destUrl && (destUrl.startsWith('http://') || destUrl.startsWith('https://'))) {
          return decodeURIComponent(destUrl);
        }
      }

      // Pattern 2: Base64 encoded destination in path or param
      // (common in newsletter tracking - skip for now, return original)

      // If no tracking pattern found, return original URL
      // Filter out common tracking domains that aren't useful
      const trackingDomains = [
        'click.', 'track.', 'trk.', 'email.', 'links.',
        'list-manage.com', 'mailchimp.com', 'beehiiv.com/clicks',
        'convertkit.com', 'substack.com/redirect'
      ];

      const isTrackingOnly = trackingDomains.some(domain =>
        parsed.hostname.includes(domain) || parsed.pathname.includes(domain)
      );

      // If it's a pure tracking URL with no extractable destination, still return it
      // The user can click through to see where it goes
      return url;
    } catch {
      return null;
    }
  }

  private extractHeader(message: any, headerName: string): string {
    const header = message.payload?.headers?.find(
      (h: any) => h.name.toLowerCase() === headerName.toLowerCase()
    );
    return header?.value || '';
  }

  async markAsRead(messageIds: string[]): Promise<void> {
    await Promise.all(
      messageIds.map(id =>
        this.gmail!.users.messages.modify({
          userId: 'me',
          id,
          requestBody: {
            removeLabelIds: ['UNREAD']
          }
        })
      )
    );
  }
}