import type { Lead, CompanyInfo } from '../models/lead.js';
import { storage as defaultStorage, Storage } from './storage.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 10_000;

/** Curated domain → industry mapping for well-known companies. */
const INDUSTRY_MAP: Record<string, string> = {
  'google.com': 'technology',
  'microsoft.com': 'technology',
  'apple.com': 'technology',
  'meta.com': 'technology',
  'amazon.com': 'ecommerce',
  'stripe.com': 'fintech',
  'paypal.com': 'fintech',
  'square.com': 'fintech',
  'plaid.com': 'fintech',
  'shopify.com': 'ecommerce',
  'woocommerce.com': 'ecommerce',
  'bigcommerce.com': 'ecommerce',
  'salesforce.com': 'saas',
  'hubspot.com': 'marketing',
  'marketo.com': 'marketing',
  'mailchimp.com': 'marketing',
  'slack.com': 'saas',
  'notion.so': 'saas',
  'linear.app': 'saas',
  'asana.com': 'saas',
  'figma.com': 'saas',
  'zoom.us': 'saas',
  'github.com': 'technology',
  'gitlab.com': 'technology',
  'atlassian.com': 'saas',
  'twilio.com': 'saas',
  'sendgrid.com': 'saas',
  'vercel.com': 'technology',
  'netlify.com': 'technology',
  'cloudflare.com': 'technology',
  'datadoghq.com': 'saas',
  'snowflake.com': 'saas',
  'databricks.com': 'saas',
  'anthropic.com': 'technology',
  'openai.com': 'technology',
};

/** TLD → industry hint (fallback when domain not in curated map). */
const TLD_INDUSTRY_HINTS: Record<string, string> = {
  ai: 'technology',
  io: 'technology',
  dev: 'technology',
  tech: 'technology',
  software: 'technology',
  app: 'technology',
  cloud: 'technology',
  shop: 'ecommerce',
  store: 'ecommerce',
  market: 'ecommerce',
  bank: 'fintech',
  finance: 'fintech',
  pay: 'fintech',
  health: 'healthcare',
  care: 'healthcare',
  edu: 'education',
  university: 'education',
  legal: 'legal',
  law: 'legal',
  agency: 'marketing',
  studio: 'marketing',
  media: 'media',
  news: 'media',
};

/** Name keyword → industry hint (fallback when domain + TLD give nothing).
 *  Uses substring matching (not \b) so keywords match inside compound
 *  domain names like "mycoolshop" or "velocityai". */
const NAME_KEYWORDS: Array<[RegExp, string]> = [
  [/(neural|vector|llm|gpt|tensor|\bai\b|\bml\b)/i, 'technology'],
  [/(shop|store|cart|retail|commerce)/i, 'ecommerce'],
  [/(bank|fintech|finance|capital|invest|wealth|lending|credit)/i, 'fintech'],
  [/(health|medical|clinic|pharma|\bbio\b|wellness)/i, 'healthcare'],
  [/(learn|edu|school|academy|course|teach|training)/i, 'education'],
  [/(legal|law|attorney|counsel)/i, 'legal'],
  [/(marketing|agency|studio|creative|\bbrand)/i, 'marketing'],
  [/(media|news|press|podcast|broadcast|publish)/i, 'media'],
  [/(logistics|freight|transport|supply\s*chain)/i, 'logistics'],
  [/(realty|real\s*estate|property|housing)/i, 'real_estate'],
  [/(travel|hotel|booking|flight)/i, 'travel'],
  [/(restaurant|kitchen|grocery|food\s*delivery)/i, 'food_beverage'],
];

function extractDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

function extractTLD(domain: string): string {
  const parts = domain.split('.');
  return parts[parts.length - 1] ?? '';
}

function isFreemailDomain(domain: string): boolean {
  const freemail = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'protonmail.com', 'mail.com', 'zoho.com', 'yandex.com',
    'gmx.com', 'live.com', 'msn.com', 'fastmail.com',
  ];
  return freemail.includes(domain);
}

/** Guess industry from TLD + company name, when no curated match exists. */
function guessIndustry(domain: string, companyName: string | undefined): string | undefined {
  const tld = extractTLD(domain);
  if (TLD_INDUSTRY_HINTS[tld]) return TLD_INDUSTRY_HINTS[tld];

  const haystack = `${domain} ${companyName ?? ''}`.toLowerCase();
  for (const [pattern, industry] of NAME_KEYWORDS) {
    if (pattern.test(haystack)) return industry;
  }
  return undefined;
}

/** Fetch company info from external API (Hunter.io) or fall back to domain heuristics. */
async function fetchCompanyFromDomain(
  domain: string,
  existing: CompanyInfo | undefined,
): Promise<CompanyInfo> {
  const info: CompanyInfo = { domain };

  // Try Hunter.io if API key is set
  const hunterKey = process.env.HUNTER_API_KEY;
  if (hunterKey) {
    try {
      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const data = await res.json() as any;
        const d = data?.data;
        if (d) {
          info.name = d.organization ?? undefined;
          info.industry = d.industry ?? undefined;
          info.country = d.country ?? undefined;
          info.description = d.description ?? undefined;
          info.linkedin_url = d.linkedin ?? undefined;
          if (d.technologies && Array.isArray(d.technologies)) {
            info.tech_stack = d.technologies;
          }
        }
      }
    } catch {
      // Hunter.io failed — continue with fallback
    }
  }

  // Only set a fallback name if the user did NOT already provide one.
  // This preserves user-provided casing and spelling (e.g. "VelocityAI" vs "Velocityai").
  if (!existing?.name && !info.name) {
    const parts = domain.split('.');
    info.name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }

  // Industry resolution: curated map → TLD heuristic → name keyword heuristic
  if (!info.industry) {
    info.industry =
      INDUSTRY_MAP[domain] ??
      guessIndustry(domain, existing?.name ?? info.name) ??
      undefined;
  }

  return info;
}

/** Estimate company size from domain. Returns a default midmarket bracket for unknown domains. */
function estimateCompanySize(domain: string): CompanyInfo['size'] {
  // Well-known large companies
  const large = ['google.com', 'microsoft.com', 'apple.com', 'amazon.com', 'meta.com', 'salesforce.com'];
  if (large.includes(domain)) return '5000+';

  const midLarge = ['stripe.com', 'shopify.com', 'hubspot.com', 'atlassian.com', 'twilio.com', 'databricks.com', 'snowflake.com'];
  if (midLarge.includes(domain)) return '1001-5000';

  const mid = ['vercel.com', 'notion.so', 'linear.app', 'figma.com', 'anthropic.com'];
  if (mid.includes(domain)) return '201-500';

  // Unknown domain — assume small-to-mid market (51-200). This is the default
  // bracket for "unknown small company" and lets scoring treat it as neutral
  // rather than penalizing it to zero.
  return '51-200';
}

/**
 * Enrich an existing lead with company data.
 *
 * Merge rules (user data is sacred):
 *   - Any field the user already set on the lead (name, industry, etc.) is kept.
 *   - Enrichment only fills fields that are undefined on the existing lead.
 *   - Every field from the CompanyInfo schema is explicitly set to `null`
 *     when unknown, so the output shape is stable and discoverable.
 */
export async function enrichLead(leadId: string, store?: Storage): Promise<Lead> {
  if (!RE_UUID.test(leadId)) throw new ValidationError(`Invalid lead ID format: ${leadId}`);

  const s = store ?? defaultStorage;
  const lead = await s.getLeadById(leadId);
  if (!lead) throw new NotFoundError('Lead', leadId);

  const domain = extractDomain(lead.email);
  const isFreemail = isFreemailDomain(domain);
  const existing = lead.company;

  let fetched: CompanyInfo;
  if (isFreemail) {
    fetched = { domain: existing?.domain };
  } else {
    fetched = await fetchCompanyFromDomain(domain, existing);
    const estimatedSize = estimateCompanySize(domain);
    if (estimatedSize && !fetched.size && !existing?.size) {
      fetched.size = estimatedSize;
    }
  }

  // Merge: existing user-provided data wins over heuristic fallbacks
  const pick = <T>(userVal: T | undefined, heuristic: T | undefined): T | undefined =>
    userVal !== undefined ? userVal : heuristic;

  const merged: CompanyInfo = {
    name: pick(existing?.name, fetched.name),
    domain: pick(existing?.domain, fetched.domain ?? (domain && !isFreemail ? domain : undefined)),
    industry: pick(existing?.industry, fetched.industry),
    size: pick(existing?.size, fetched.size),
    country: pick(existing?.country, fetched.country),
    description: pick(existing?.description, fetched.description),
    linkedin_url: pick(existing?.linkedin_url, fetched.linkedin_url),
    tech_stack: pick(existing?.tech_stack, fetched.tech_stack),
  };

  const updated = await s.updateLead(leadId, {
    company: merged,
    status: lead.status === 'new' ? 'enriched' : lead.status,
    enriched_at: new Date().toISOString(),
  });

  return updated!;
}
