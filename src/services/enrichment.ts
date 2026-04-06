import type { Lead, CompanyInfo } from '../models/lead.js';
import { storage } from './storage.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 10_000;

const INDUSTRY_MAP: Record<string, string> = {
  'google.com': 'technology',
  'microsoft.com': 'technology',
  'apple.com': 'technology',
  'amazon.com': 'ecommerce',
  'stripe.com': 'fintech',
  'shopify.com': 'ecommerce',
  'salesforce.com': 'saas',
  'hubspot.com': 'marketing',
  'slack.com': 'saas',
  'notion.so': 'saas',
  'github.com': 'technology',
  'atlassian.com': 'saas',
  'twilio.com': 'saas',
  'vercel.com': 'technology',
};

function extractDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

function isFreemailDomain(domain: string): boolean {
  const freemail = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'protonmail.com', 'mail.com', 'zoho.com', 'yandex.com',
    'gmx.com', 'live.com', 'msn.com', 'fastmail.com',
  ];
  return freemail.includes(domain);
}

async function fetchCompanyFromDomain(domain: string): Promise<CompanyInfo> {
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

  // Fallback: domain-based heuristics
  if (!info.name) {
    const parts = domain.split('.');
    info.name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }

  if (!info.industry && INDUSTRY_MAP[domain]) {
    info.industry = INDUSTRY_MAP[domain];
  }

  return info;
}

function estimateCompanySize(domain: string): CompanyInfo['size'] {
  // Well-known large companies
  const large = ['google.com', 'microsoft.com', 'apple.com', 'amazon.com', 'meta.com', 'salesforce.com'];
  if (large.includes(domain)) return '5000+';

  const midLarge = ['stripe.com', 'shopify.com', 'hubspot.com', 'atlassian.com', 'twilio.com'];
  if (midLarge.includes(domain)) return '1001-5000';

  const mid = ['vercel.com', 'notion.so', 'linear.app', 'figma.com'];
  if (mid.includes(domain)) return '201-500';

  // Default: unknown — will be scored as neutral
  return undefined;
}

export async function enrichLead(leadId: string): Promise<Lead> {
  if (!RE_UUID.test(leadId)) throw new ValidationError(`Invalid lead ID format: ${leadId}`);

  const lead = await storage.getLeadById(leadId);
  if (!lead) throw new NotFoundError('Lead', leadId);

  const domain = extractDomain(lead.email);
  const isFreemail = isFreemailDomain(domain);

  let company: CompanyInfo;
  if (isFreemail) {
    // For freemail domains, use existing company info or minimal data
    company = lead.company ?? {
      name: undefined,
      domain: undefined,
      industry: undefined,
    };
  } else {
    company = await fetchCompanyFromDomain(domain);
    const estimatedSize = estimateCompanySize(domain);
    if (estimatedSize && !company.size) {
      company.size = estimatedSize;
    }
  }

  // Merge with existing company data (don't overwrite existing values with undefined)
  const merged: CompanyInfo = {
    ...lead.company,
    ...Object.fromEntries(
      Object.entries(company).filter(([_, v]) => v !== undefined)
    ),
  };

  const updated = await storage.updateLead(leadId, {
    company: merged,
    status: lead.status === 'new' ? 'enriched' : lead.status,
    enriched_at: new Date().toISOString(),
  });

  return updated!;
}
