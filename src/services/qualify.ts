/**
 * Pre-enrichment ICP qualification.
 *
 * Filters leads using only cheap, locally-derivable signals — email freemail
 * detection, domain-based industry hints, job title patterns, country hints,
 * and user-supplied target-platform cues — so that expensive enrichment calls
 * (Hunter.io, HubSpot lookup, etc.) and downstream scoring are only spent on
 * leads that actually fit the ICP.
 *
 * Community insight (Reddit / Detecto): "Before you even score a lead, you
 * want to know if the company is on the right tech stack. Shopify-targeted
 * offer vs a Woo shop, Salesforce add-on vs a HubSpot shop." — this service
 * is the local implementation of that pre-filter. External platform-detection
 * MCP tools (like Detecto) can be chained upstream via agent workflows to
 * enrich the signal further.
 */

import type { Lead } from '../models/lead.js';
import { storage as defaultStorage, Storage } from './storage.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

// ── ICP criteria schema (runtime) ───────────────────────────────────

export interface QualificationCriteria {
  /** Reject any lead whose email uses a freemail provider (gmail, yahoo, outlook, etc.). */
  reject_freemail?: boolean;
  /** Case-insensitive substrings a lead's job_title must contain (any match passes). */
  required_title_keywords?: string[];
  /** Case-insensitive substrings that disqualify if present in job_title. */
  exclude_title_keywords?: string[];
  /** ISO 3166-1 alpha-2 country codes the lead's company_country must match. */
  target_countries?: string[];
  /** Industries the company must belong to (case-insensitive substring match). */
  target_industries?: string[];
  /** Minimum company size tier. Leads below this bucket are rejected. */
  min_company_size?: '1-10' | '11-50' | '51-200' | '201-500' | '501-1000' | '1001-5000' | '5000+';
  /** Explicit domain allowlist — reject anything not matching (full domain or suffix). */
  domain_allowlist?: string[];
  /** Explicit domain blocklist — reject anything matching. */
  domain_blocklist?: string[];
  /** Tech-stack hints the lead's company.tech_stack must contain (any match passes).
   *  Useful when chained after a platform-detection tool like Detecto. */
  required_tech_stack?: string[];
}

export interface QualificationResult {
  lead_id: string;
  email: string;
  qualified: boolean;
  reasons: string[];
  signals: {
    is_freemail: boolean;
    domain: string | null;
    industry_hint: string | null;
    company_size: string | null;
    country: string | null;
  };
}

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'protonmail.com', 'mail.com',
  'yandex.com', 'gmx.com', 'live.com', 'msn.com',
  'ymail.com', 'rocketmail.com', 'zoho.com',
]);

const SIZE_ORDER: Record<string, number> = {
  '1-10': 0, '11-50': 1, '51-200': 2, '201-500': 3,
  '501-1000': 4, '1001-5000': 5, '5000+': 6,
};

function extractDomain(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim() || null;
}

function includesAny(haystack: string, needles: string[] | undefined): boolean {
  if (!needles || needles.length === 0) return false;
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

/** Apply ICP criteria to a single lead, collect all match/mismatch reasons. */
function evaluateLead(lead: Lead, criteria: QualificationCriteria): QualificationResult {
  const reasons: string[] = [];
  let qualified = true;

  const domain = extractDomain(lead.email);
  const isFreemail = domain ? FREEMAIL_DOMAINS.has(domain) : false;
  const industry = lead.company?.industry ?? null;
  const size = lead.company?.size ?? null;
  const country = lead.company?.country ?? null;
  const techStack = lead.company?.tech_stack ?? [];

  // Freemail filter
  if (criteria.reject_freemail && isFreemail) {
    qualified = false;
    reasons.push(`Rejected: freemail domain (${domain}) — not a business email.`);
  }

  // Title requirements
  if (criteria.required_title_keywords && criteria.required_title_keywords.length > 0) {
    const title = lead.job_title ?? '';
    if (!includesAny(title, criteria.required_title_keywords)) {
      qualified = false;
      reasons.push(`Rejected: job_title "${title || '(empty)'}" missing any of [${criteria.required_title_keywords.join(', ')}].`);
    }
  }

  if (criteria.exclude_title_keywords && criteria.exclude_title_keywords.length > 0) {
    const title = lead.job_title ?? '';
    if (includesAny(title, criteria.exclude_title_keywords)) {
      qualified = false;
      reasons.push(`Rejected: job_title contains excluded keyword.`);
    }
  }

  // Country filter
  if (criteria.target_countries && criteria.target_countries.length > 0) {
    const countryUpper = (country ?? '').toUpperCase();
    const targets = criteria.target_countries.map((c) => c.toUpperCase());
    if (!countryUpper || !targets.includes(countryUpper)) {
      qualified = false;
      reasons.push(`Rejected: country "${country ?? '(unknown)'}" not in target list [${targets.join(', ')}].`);
    }
  }

  // Industry filter
  if (criteria.target_industries && criteria.target_industries.length > 0) {
    if (!industry || !includesAny(industry, criteria.target_industries)) {
      qualified = false;
      reasons.push(`Rejected: industry "${industry ?? '(unknown)'}" not in target list.`);
    }
  }

  // Company size filter
  if (criteria.min_company_size && size) {
    const min = SIZE_ORDER[criteria.min_company_size];
    const actual = SIZE_ORDER[size];
    if (actual !== undefined && actual < min) {
      qualified = false;
      reasons.push(`Rejected: company size ${size} below minimum ${criteria.min_company_size}.`);
    }
  }

  // Domain allow/block
  if (criteria.domain_blocklist && domain) {
    const blocked = criteria.domain_blocklist.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`));
    if (blocked) {
      qualified = false;
      reasons.push(`Rejected: domain ${domain} is blocklisted.`);
    }
  }

  if (criteria.domain_allowlist && criteria.domain_allowlist.length > 0) {
    const allowed = domain && criteria.domain_allowlist.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`));
    if (!allowed) {
      qualified = false;
      reasons.push(`Rejected: domain ${domain ?? '(none)'} not in allowlist.`);
    }
  }

  // Tech stack requirement
  if (criteria.required_tech_stack && criteria.required_tech_stack.length > 0) {
    const stackLower = techStack.map((t) => t.toLowerCase());
    const hasAny = criteria.required_tech_stack.some((t) => stackLower.includes(t.toLowerCase()));
    if (!hasAny) {
      qualified = false;
      reasons.push(`Rejected: tech_stack [${techStack.join(', ') || '(empty)'}] missing any of required [${criteria.required_tech_stack.join(', ')}]. Consider chaining with a platform-detection tool if tech_stack is empty.`);
    }
  }

  if (qualified && reasons.length === 0) {
    reasons.push('Passed: all configured ICP criteria matched.');
  }

  return {
    lead_id: lead.id,
    email: lead.email,
    qualified,
    reasons,
    signals: {
      is_freemail: isFreemail,
      domain,
      industry_hint: industry,
      company_size: size,
      country,
    },
  };
}

export interface QualifyOptions {
  lead_ids?: string[];
  criteria: QualificationCriteria;
  /** If true, auto-update rejected leads to status="disqualified" and save reasons. Default false. */
  auto_disqualify?: boolean;
}

export interface QualifySummary {
  evaluated: number;
  qualified: number;
  rejected: number;
  auto_disqualified: number;
  results: QualificationResult[];
  cost_savings_estimate: {
    enrichment_calls_avoided: number;
    note: string;
  };
}

/** Evaluate a batch of leads against ICP criteria without hitting any external API.
 *  If lead_ids not provided, evaluates all leads currently in status="new".
 *  If auto_disqualify, rejected leads are updated to status="disqualified" in storage. */
export async function qualifyLeads(
  options: QualifyOptions,
  store?: Storage,
): Promise<QualifySummary> {
  const s = store ?? defaultStorage;

  if (!options.criteria || Object.keys(options.criteria).length === 0) {
    throw new ValidationError('At least one qualification criterion must be provided.');
  }

  let leads: Lead[];
  if (options.lead_ids && options.lead_ids.length > 0) {
    leads = [];
    for (const id of options.lead_ids) {
      const lead = await s.getLeadById(id);
      if (!lead) {
        throw new NotFoundError('Lead', id);
      }
      leads.push(lead);
    }
  } else {
    const all = await s.getAllLeads();
    leads = all.filter((l) => l.status === 'new');
  }

  const results = leads.map((lead) => evaluateLead(lead, options.criteria));

  let autoDisqualified = 0;
  if (options.auto_disqualify) {
    for (const r of results) {
      if (!r.qualified) {
        const lead = leads.find((l) => l.id === r.lead_id);
        const prevFields = lead?.custom_fields ?? {};
        await s.updateLead(r.lead_id, {
          status: 'disqualified',
          custom_fields: {
            ...prevFields,
            disqualification_reason: r.reasons.join(' | '),
            disqualified_by: 'lead_qualify',
            disqualified_at: new Date().toISOString(),
          },
        });
        autoDisqualified++;
      }
    }
  }

  const qualifiedCount = results.filter((r) => r.qualified).length;
  const rejectedCount = results.length - qualifiedCount;

  return {
    evaluated: results.length,
    qualified: qualifiedCount,
    rejected: rejectedCount,
    auto_disqualified: autoDisqualified,
    results,
    cost_savings_estimate: {
      enrichment_calls_avoided: rejectedCount,
      note: `Each rejected lead would have consumed 1 Hunter.io credit (~$0.01) during enrichment. Rejected ${rejectedCount} leads saves ~$${(rejectedCount * 0.01).toFixed(2)}.`,
    },
  };
}
