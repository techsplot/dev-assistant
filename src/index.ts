import { Nango } from '@nangohq/node';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const nango = new Nango({ secretKey: requireEnv('NANGO_SECRET_KEY') });

const groq = new OpenAI({
  apiKey: requireEnv('GROQ_API_KEY'),
  baseURL: 'https://api.groq.com/openai/v1',
});

const githubProviderConfigKey =
  process.env.NANGO_GITHUB_PROVIDER_CONFIG_KEY || 'github';
const gmailProviderConfigKey =
  process.env.NANGO_GMAIL_PROVIDER_CONFIG_KEY || 'google-mail';
const githubNotificationsLookbackDays = Number(
  process.env.GITHUB_NOTIFICATIONS_LOOKBACK_DAYS || '30'
);
const githubNotificationsPerPage = 50;
const githubNotificationsMaxPages = 5;
const digestStateFilePath = join(process.cwd(), '.digest-state.json');

type GithubNotification = {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  last_read_at?: string;
  subject?: {
    title?: string;
    url?: string | null;
    latest_comment_url?: string | null;
    type?: string;
  };
  repository?: {
    full_name?: string;
    html_url?: string;
  };
};

type CleanGithubNotification = {
  id: string;
  unread: boolean;
  reason: string;
  updatedAt: string;
  lastReadAt: string | null;
  title: string;
  subjectType: string;
  repository: string;
  url: string | null;
  priority: number;
};

type GmailMessageListResponse = {
  messages?: Array<{
    id: string;
    threadId: string;
  }>;
};

type GmailMessageDetailResponse = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{
      name?: string;
      value?: string;
    }>;
  };
};

type CleanGmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string | null;
  snippet: string;
  labelIds: string[];
  priority: number;
};

type DigestState = {
  lastRunAt: string;
  githubNotificationIds: string[];
  gmailMessageIds: string[];
};

type DigestDelta = {
  hasPreviousRun: boolean;
  previousRunAt: string | null;
  newGithubNotifications: number;
  newGmailMessages: number;
  newGithubIds: string[];
  newGmailIds: string[];
};

function getGithubNotificationPriority(notification: GithubNotification): number {
  const reasonPriority: Record<string, number> = {
    review_requested: 100,
    mention: 95,
    author: 90,
    comment: 85,
    ci_activity: 80,
    state_change: 70,
    assign: 65,
    subscribed: 40,
    manual: 30,
    security_alert: 100,
  };

  const basePriority = reasonPriority[notification.reason] || 50;
  const unreadBoost = notification.unread ? 10 : 0;
  const subjectTypeBoost = notification.subject?.type === 'PullRequest' ? 5 : 0;

  const title = (notification.subject?.title || '').toLowerCase();
  const titleKeywordBoost = /failed|security|vulnerability|incident|urgent/.test(title)
    ? 15
    : 0;

  const securityReasonBoost = notification.reason === 'security_alert' ? 20 : 0;

  return (
    basePriority +
    unreadBoost +
    subjectTypeBoost +
    titleKeywordBoost +
    securityReasonBoost
  );
}

function getGmailMessagePriority(message: {
  subject: string;
  snippet: string;
  labelIds: string[];
  from: string;
}): number {
  const labels = new Set(message.labelIds.map((label) => label.toUpperCase()));
  let score = 20;

  if (labels.has('UNREAD')) {
    score += 10;
  }

  if (labels.has('IMPORTANT')) {
    score += 15;
  }

  const subject = message.subject.toLowerCase();
  const snippet = message.snippet.toLowerCase();
  const from = message.from.toLowerCase();
  const text = `${subject} ${snippet}`;

  if (/login|password|security|verify|verification|suspicious|alert/.test(text)) {
    score += 35;
  }

  if (/failed|down|error|incident/.test(text)) {
    score += 25;
  }

  if (/deadline|interview|offer|application|action required/.test(text)) {
    score += 20;
  }

  if (/invoice|payment|receipt|due/.test(text)) {
    score += 18;
  }

  if (/digest|newsletter|promotions|weekly|updates/.test(text)) {
    score -= 10;
  }

  if (/no-reply|noreply/.test(from)) {
    score -= 5;
  }

  return score;
}

async function loadDigestState(): Promise<DigestState | null> {
  try {
    const raw = await readFile(digestStateFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DigestState>;

    if (
      typeof parsed.lastRunAt === 'string' &&
      Array.isArray(parsed.githubNotificationIds) &&
      Array.isArray(parsed.gmailMessageIds)
    ) {
      return {
        lastRunAt: parsed.lastRunAt,
        githubNotificationIds: parsed.githubNotificationIds,
        gmailMessageIds: parsed.gmailMessageIds,
      };
    }

    return null;
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function saveDigestState(state: DigestState): Promise<void> {
  await writeFile(digestStateFilePath, JSON.stringify(state, null, 2), 'utf-8');
}

function getDigestDelta(
  previousState: DigestState | null,
  githubNotifications: CleanGithubNotification[],
  gmailMessages: CleanGmailMessage[]
): DigestDelta {
  if (!previousState) {
    return {
      hasPreviousRun: false,
      previousRunAt: null,
      newGithubNotifications: githubNotifications.length,
      newGmailMessages: gmailMessages.length,
      newGithubIds: githubNotifications.map((item) => item.id),
      newGmailIds: gmailMessages.map((item) => item.id),
    };
  }

  const previousGithub = new Set(previousState.githubNotificationIds);
  const previousGmail = new Set(previousState.gmailMessageIds);

  const newGithubIds = githubNotifications
    .map((item) => item.id)
    .filter((id) => !previousGithub.has(id));
  const newGmailIds = gmailMessages
    .map((item) => item.id)
    .filter((id) => !previousGmail.has(id));

  return {
    hasPreviousRun: true,
    previousRunAt: previousState.lastRunAt,
    newGithubNotifications: newGithubIds.length,
    newGmailMessages: newGmailIds.length,
    newGithubIds,
    newGmailIds,
  };
}

async function getGithubNotifications() {
  const connectionId = requireEnv('NANGO_GITHUB_CONNECTION_ID');
  const since = new Date(
    Date.now() - githubNotificationsLookbackDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const notifications: GithubNotification[] = [];

  for (let page = 1; page <= githubNotificationsMaxPages; page += 1) {
    const response = await nango.get<GithubNotification[]>({
      endpoint: `/notifications?all=true&participating=false&since=${encodeURIComponent(
        since
      )}&per_page=${githubNotificationsPerPage}&page=${page}`,
      providerConfigKey: githubProviderConfigKey,
      connectionId,
    });

    const pageItems = response.data || [];
    notifications.push(...pageItems);

    if (pageItems.length < githubNotificationsPerPage) {
      break;
    }
  }

  const cleanedNotifications: CleanGithubNotification[] = notifications
    .map((notification) => ({
      id: notification.id,
      unread: notification.unread,
      reason: notification.reason,
      updatedAt: notification.updated_at,
      lastReadAt: notification.last_read_at || null,
      title: notification.subject?.title || '(No title)',
      subjectType: notification.subject?.type || 'Unknown',
      repository: notification.repository?.full_name || 'Unknown repository',
      url:
        notification.subject?.url ||
        notification.subject?.latest_comment_url ||
        notification.repository?.html_url ||
        null,
      priority: getGithubNotificationPriority(notification),
    }))
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }

      return (
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    });

  return {
    lookbackDays: githubNotificationsLookbackDays,
    totalCount: cleanedNotifications.length,
    unreadCount: cleanedNotifications.filter((notification) => notification.unread)
      .length,
    urgentCount: cleanedNotifications.filter(
      (notification) => notification.priority >= 80
    ).length,
    notifications: cleanedNotifications,
  };
}

async function getGmailMessages() {
  const connectionId = requireEnv('NANGO_GMAIL_CONNECTION_ID');
  const response = await nango.get<GmailMessageListResponse>({
    endpoint: '/gmail/v1/users/me/messages?maxResults=5',
    providerConfigKey: gmailProviderConfigKey,
    connectionId,
  });

  const messages = response.data.messages || [];

  const detailedMessages: CleanGmailMessage[] = await Promise.all(
    messages.map(async ({ id }) => {
      const detailResponse = await nango.get<GmailMessageDetailResponse>({
        endpoint: `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        providerConfigKey: gmailProviderConfigKey,
        connectionId,
      });

      const headers = detailResponse.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find(
          (header) => header.name?.toLowerCase() === name.toLowerCase()
        )?.value;

      const labelIds = detailResponse.data.labelIds || [];
      const subject = getHeader('Subject') || '(No subject)';
      const snippet = detailResponse.data.snippet || '';
      const from = getHeader('From') || 'Unknown sender';

      return {
        id: detailResponse.data.id,
        threadId: detailResponse.data.threadId,
        from,
        subject,
        date: getHeader('Date') || null,
        snippet,
        labelIds,
        priority: getGmailMessagePriority({
          subject,
          snippet,
          labelIds,
          from,
        }),
      };
    })
  );

  const sortedMessages = detailedMessages.sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }

    const rightDate = right.date ? new Date(right.date).getTime() : 0;
    const leftDate = left.date ? new Date(left.date).getTime() : 0;
    return rightDate - leftDate;
  });

  return {
    resultSizeEstimate: response.data.messages?.length || 0,
    unreadCount: sortedMessages.filter((message) =>
      message.labelIds.map((label) => label.toUpperCase()).includes('UNREAD')
    ).length,
    urgentCount: sortedMessages.filter((message) => message.priority >= 55).length,
    messages: sortedMessages,
  };
}

function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...truncated...`;
}

function prepareAssistantInput(data: {
  notifications: unknown;
  emails: unknown;
  digestDelta: DigestDelta;
}): string {
  const notifications = clip(JSON.stringify(data.notifications, null, 2), 10000);
  const emails = clip(JSON.stringify(data.emails, null, 2), 6000);
  const digest = JSON.stringify(data.digestDelta, null, 2);

  return [
    'GitHub notifications data:',
    notifications,
    '',
    'Gmail messages data:',
    emails,
    '',
    'Digest delta (new items since previous run):',
    digest,
  ].join('\n');
}

async function askAssistant(data: string, question: string) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content:
          'You are a friendly and sharp personal developer assistant. Analyze both the GitHub notifications and Gmail data provided. Respond in plain text only, no markdown. Use this exact structure and headings: QUICK SUMMARY, GITHUB (ACT ON FIRST), GITHUB (CAN WAIT), GMAIL (ACT ON FIRST), GMAIL (CAN WAIT), TODAY\'S PLAN. Put each item on its own line starting with "- ". Keep each bullet specific and concrete (about 12 to 28 words), mentioning exact repo names, PR/workflow titles, senders, and subjects where relevant. Avoid generic wording like "check this" or "review that". Use clear action language and include why each urgent item matters now. Keep the tone warm, practical, and supportive without sounding robotic. Prioritize items flagged as new since last run and never repeat the same item in multiple sections.',
      },
      {
        role: 'user',
        content: `${data}\n\nQuestion: ${question}`,
      },
    ],
  });
  return response.choices[0].message.content;
}

function wrapLine(line: string, maxWidth: number): string[] {
  if (line.length <= maxWidth) {
    return [line];
  }

  const wrapped: string[] = [];
  let current = '';
  const words = line.split(/\s+/).filter(Boolean);

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if (`${current} ${word}`.length <= maxWidth) {
      current = `${current} ${word}`;
      continue;
    }

    wrapped.push(current);
    current = word;
  }

  if (current) {
    wrapped.push(current);
  }

  return wrapped;
}

function formatAssistantResponse(response: string): string {
  const maxWidth = 96;
  const lines = response
    .split('\n')
    .map((line) => line.trimEnd())
    .map((line) => line.replace(/^\*\s+/, '- '));

  const output: string[] = [];
  const seenBulletKeys = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      if (output[output.length - 1] !== '') {
        output.push('');
      }
      continue;
    }

    const headingMatch = line.match(/^[A-Z][A-Z\s()]+:$/);

    if (headingMatch) {
      if (output.length > 0 && output[output.length - 1] !== '') {
        output.push('');
      }
      output.push(line);
      continue;
    }

    const isBullet = line.startsWith('- ');
    const prefix = isBullet ? '- ' : '';
    const content = isBullet ? line.slice(2).trim() : line;

    if (isBullet) {
      const key = content.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seenBulletKeys.has(key)) {
        continue;
      }
      seenBulletKeys.add(key);
    }

    const wrapped = wrapLine(content, isBullet ? maxWidth - 2 : maxWidth);

    wrapped.forEach((wrappedLine, index) => {
      if (isBullet) {
        output.push(index === 0 ? `${prefix}${wrappedLine}` : `  ${wrappedLine}`);
      } else {
        output.push(wrappedLine);
      }
    });
  }

  return output.join('\n').trim();
}

function printSection(title: string, content: string) {
  console.log('\n=============================');
  console.log(` ${title}`);
  console.log('=============================');
  console.log(content);
}

function printCompactDigest(params: {
  notifications: {
    totalCount: number;
    unreadCount: number;
    urgentCount: number;
    notifications: CleanGithubNotification[];
  };
  emails: {
    resultSizeEstimate: number;
    unreadCount: number;
    urgentCount: number;
    messages: CleanGmailMessage[];
  };
  digestDelta: DigestDelta;
}) {
  const topGithub = params.notifications.notifications.slice(0, 2);
  const topEmails = params.emails.messages.slice(0, 2);

  printSection(
    'DIGEST SNAPSHOT',
    [
      `GH  total=${params.notifications.totalCount} unread=${params.notifications.unreadCount} urgent=${params.notifications.urgentCount} new=${params.digestDelta.newGithubNotifications}`,
      `MAIL total=${params.emails.resultSizeEstimate} unread=${params.emails.unreadCount} urgent=${params.emails.urgentCount} new=${params.digestDelta.newGmailMessages}`,
      params.digestDelta.hasPreviousRun && params.digestDelta.previousRunAt
        ? `Compared with previous run at ${params.digestDelta.previousRunAt}`
        : 'First run baseline created for future new-item comparisons.',
      '',
      'Top GitHub now:',
      ...topGithub.map(
        (item, index) =>
          `- [GH ${index + 1}] ${item.repository} | ${item.reason} | ${item.title}`
      ),
      '',
      'Top Gmail now:',
      ...topEmails.map(
        (item, index) => `- [MAIL ${index + 1}] ${item.from} | ${item.subject}`
      ),
    ].join('\n')
  );
}

async function main() {
  const previousDigestState = await loadDigestState();

  console.log('Fetching GitHub notifications...');
  const notifications = await getGithubNotifications();

  console.log('Fetching Gmail messages...');
  const emails = await getGmailMessages();

  const digestDelta = getDigestDelta(
    previousDigestState,
    notifications.notifications,
    emails.messages
  );

  printCompactDigest({ notifications, emails, digestDelta });

  const combinedData = prepareAssistantInput({
    notifications,
    emails,
    digestDelta,
  });

  const answer = await askAssistant(
    combinedData,
    'Give me a clear and friendly update. Prioritize what is new since my previous run, explain what needs attention first and why it matters, then give a short plan for today.'
  );

  if (process.env.DEBUG === 'true') {
    printSection('GITHUB NOTIFICATIONS', JSON.stringify(notifications, null, 2));
    printSection('GMAIL MESSAGES', JSON.stringify(emails, null, 2));
  }

  const formattedAnswer = formatAssistantResponse(answer ?? '');
  printSection('ASSISTANT', formattedAnswer);

  await saveDigestState({
    lastRunAt: new Date().toISOString(),
    githubNotificationIds: notifications.notifications.map((item) => item.id),
    gmailMessageIds: emails.messages.map((item) => item.id),
  });
}

function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const axiosLikeError = error as Error & {
      status?: number;
      response?: {
        status?: number;
        statusText?: string;
        data?: unknown;
      };
    };

    const status = axiosLikeError.response?.status ?? axiosLikeError.status;
    const statusText = axiosLikeError.response?.statusText;
    const responseData = axiosLikeError.response?.data;

    if (status) {
      const details =
        responseData && typeof responseData === 'object'
          ? JSON.stringify(responseData, null, 2)
          : responseData;

      return [
        `Request failed with status ${status}${statusText ? ` ${statusText}` : ''}.`,
        details ? `Response: ${details}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    }

    return error.message;
  }

  return 'An unknown error occurred.';
}

main().catch((error) => {
  console.error(getSafeErrorMessage(error));
  process.exitCode = 1;
});
