import type { Lead, ScoreBreakdown, ScoringConfig, ScoringDetail, CustomRule } from '../models/lead.js';
import { storage as defaultStorage, Storage } from './storage.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

// Pre-compiled regex patterns for job title scoring (avoids repeated compilation)
const RE_CLEVEL = /\b(ceo|cto|cfo|coo|cmo|founder|co-founder|owner)\b/;
const RE_VP = /\b(vp|vice president|director|head of)\b/;
const RE_MANAGER = /\b(manager|lead|team lead|principal)\b/;
const RE_SENIOR = /\b(senior|sr\.?|staff)\b/;
const RE_JUNIOR = /\b(junior|jr\.?|intern|student|trainee|assistant)\b/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Max regex pattern length to prevent ReDoS attacks
const MAX_REGEX_LENGTH = 200;

function scoreJobTitle(title: string | undefined, config: ScoringConfig): { score: number; details: ScoringDetail[] } {
  if (!title) return { score: 20, details: [{ rule: 'job_title', points: 20, reason: 'No job title provided' }] };

  const lower = title.toLowerCase();
  const details: ScoringDetail[] = [];

  // C-level / Founder
  if (RE_CLEVEL.test(lower)) {
    details.push({ rule: 'job_title_clevel', points: 100, reason: `C-level/Founder: ${title}` });
    return { score: 100, details };
  }

  // VP / Director / Head
  if (RE_VP.test(lower)) {
    details.push({ rule: 'job_title_vp', points: 85, reason: `VP/Director level: ${title}` });
    return { score: 85, details };
  }

  // Manager
  if (RE_MANAGER.test(lower)) {
    details.push({ rule: 'job_title_manager', points: 65, reason: `Manager level: ${title}` });
    return { score: 65, details };
  }

  // Check against custom high-value titles
  const isHighValue = config.high_value_titles.some((t) => lower.includes(t.toLowerCase()));
  if (isHighValue) {
    details.push({ rule: 'job_title_custom', points: 70, reason: `Matches high-value title: ${title}` });
    return { score: 70, details };
  }

  // Senior
  if (RE_SENIOR.test(lower)) {
    details.push({ rule: 'job_title_senior', points: 50, reason: `Senior role: ${title}` });
    return { score: 50, details };
  }

  // Junior / Intern / Student
  if (RE_JUNIOR.test(lower)) {
    details.push({ rule: 'job_title_junior', points: 15, reason: `Junior role: ${title}` });
    return { score: 15, details };
  }

  details.push({ rule: 'job_title_other', points: 35, reason: `Standard role: ${title}` });
  return { score: 35, details };
}

function scoreCompanySize(size: string | undefined, config: ScoringConfig): { score: number; details: ScoringDetail[] } {
  if (!size) return { score: 30, details: [{ rule: 'company_size', points: 30, reason: 'Company size unknown' }] };

  const isPreferred = config.preferred_company_sizes.includes(size as any);
  if (isPreferred) {
    return { score: 90, details: [{ rule: 'company_size_preferred', points: 90, reason: `Preferred size: ${size}` }] };
  }

  const sizeScores: Record<string, number> = {
    '1-10': 40,
    '11-50': 70,
    '51-200': 85,
    '201-500': 80,
    '501-1000': 65,
    '1001-5000': 55,
    '5000+': 45,
  };

  const score = sizeScores[size] ?? 30;
  return { score, details: [{ rule: 'company_size', points: score, reason: `Company size: ${size}` }] };
}

function scoreIndustry(industry: string | undefined, config: ScoringConfig): { score: number; details: ScoringDetail[] } {
  if (!industry) return { score: 30, details: [{ rule: 'industry', points: 30, reason: 'Industry unknown' }] };

  const lower = industry.toLowerCase();
  const isHighValue = config.high_value_industries.some((i) => lower.includes(i.toLowerCase()));

  if (isHighValue) {
    return { score: 90, details: [{ rule: 'industry_high_value', points: 90, reason: `High-value industry: ${industry}` }] };
  }

  return { score: 40, details: [{ rule: 'industry_standard', points: 40, reason: `Standard industry: ${industry}` }] };
}

function scoreEngagement(lead: Lead): { score: number; details: ScoringDetail[] } {
  let score = 30; // baseline
  const details: ScoringDetail[] = [];

  // Has phone number (engagement signal)
  if (lead.phone) {
    score += 15;
    details.push({ rule: 'engagement_phone', points: 15, reason: 'Phone number provided' });
  }

  // Has full name
  if (lead.first_name && lead.last_name) {
    score += 10;
    details.push({ rule: 'engagement_fullname', points: 10, reason: 'Full name provided' });
  }

  // Has tags (shows interaction/categorization)
  if (lead.tags.length > 0) {
    score += 10;
    details.push({ rule: 'engagement_tags', points: 10, reason: `Has ${lead.tags.length} tags` });
  }

  // Has custom fields
  if (Object.keys(lead.custom_fields).length > 0) {
    score += 10;
    details.push({ rule: 'engagement_custom', points: 10, reason: 'Has custom fields' });
  }

  // Source signals
  const sourceScores: Record<string, number> = {
    website_form: 15,
    landing_page: 20,
    webhook: 10,
    api: 5,
    manual: 10,
    csv_import: 0,
  };
  const sourceBonus = sourceScores[lead.source] ?? 0;
  if (sourceBonus > 0) {
    score += sourceBonus;
    details.push({ rule: 'engagement_source', points: sourceBonus, reason: `Source: ${lead.source}` });
  }

  return { score: Math.min(score, 100), details };
}

function scoreRecency(lead: Lead): { score: number; details: ScoringDetail[] } {
  const now = Date.now();
  const created = new Date(lead.created_at).getTime();
  const daysSince = (now - created) / (1000 * 60 * 60 * 24);

  let score: number;
  let reason: string;

  if (daysSince <= 1) {
    score = 100;
    reason = 'Created today';
  } else if (daysSince <= 3) {
    score = 90;
    reason = 'Created in last 3 days';
  } else if (daysSince <= 7) {
    score = 75;
    reason = 'Created in last week';
  } else if (daysSince <= 14) {
    score = 55;
    reason = 'Created in last 2 weeks';
  } else if (daysSince <= 30) {
    score = 35;
    reason = 'Created in last month';
  } else if (daysSince <= 90) {
    score = 15;
    reason = 'Created 1-3 months ago';
  } else {
    score = 5;
    reason = 'Created over 3 months ago';
  }

  return { score, details: [{ rule: 'recency', points: score, reason }] };
}

function evaluateCustomRules(lead: Lead, rules: CustomRule[]): { score: number; details: ScoringDetail[] } {
  if (rules.length === 0) return { score: 50, details: [{ rule: 'custom_rules', points: 50, reason: 'No custom rules configured' }] };

  let totalPoints = 0;
  const details: ScoringDetail[] = [];

  for (const rule of rules) {
    const fieldValue = getFieldValue(lead, rule.field);
    if (fieldValue === undefined) continue;

    const matches = evaluateCondition(String(fieldValue), rule.operator, rule.value);
    if (matches) {
      totalPoints += rule.points;
      details.push({
        rule: `custom_${rule.field}`,
        points: rule.points,
        reason: rule.description,
      });
    }
  }

  // Normalize to 0-100
  const score = Math.max(0, Math.min(100, 50 + totalPoints));
  return { score, details };
}

function getFieldValue(lead: Lead, field: string): string | undefined {
  const map: Record<string, string | undefined> = {
    email: lead.email,
    first_name: lead.first_name,
    last_name: lead.last_name,
    full_name: lead.full_name,
    job_title: lead.job_title,
    phone: lead.phone,
    source: lead.source,
    company_name: lead.company?.name,
    company_domain: lead.company?.domain,
    company_industry: lead.company?.industry,
    company_size: lead.company?.size,
    company_country: lead.company?.country,
  };

  // Check custom_fields as fallback
  return map[field] ?? lead.custom_fields[field];
}

function evaluateCondition(value: string, operator: string, target: string): boolean {
  if (!value || !target) return false;

  const lower = value.toLowerCase();
  const targetLower = target.toLowerCase();

  switch (operator) {
    case 'equals': return lower === targetLower;
    case 'contains': return lower.includes(targetLower);
    case 'starts_with': return lower.startsWith(targetLower);
    case 'ends_with': return lower.endsWith(targetLower);
    case 'gt': {
      const a = parseFloat(value);
      const b = parseFloat(target);
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    }
    case 'lt': {
      const a = parseFloat(value);
      const b = parseFloat(target);
      return Number.isFinite(a) && Number.isFinite(b) && a < b;
    }
    case 'regex': {
      // ReDoS protection: limit pattern length and reject dangerous patterns
      if (target.length > MAX_REGEX_LENGTH) return false;
      try {
        const re = new RegExp(target, 'i');
        return re.test(value);
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

export async function scoreLead(leadId: string, store?: Storage): Promise<Lead> {
  if (!RE_UUID.test(leadId)) throw new ValidationError(`Invalid lead ID format: ${leadId}`);

  const s = store ?? defaultStorage;
  const lead = await s.getLeadById(leadId);
  if (!lead) throw new NotFoundError('Lead', leadId);

  const config = await s.getScoringConfig();

  const titleResult = scoreJobTitle(lead.job_title, config);
  const sizeResult = scoreCompanySize(lead.company?.size, config);
  const industryResult = scoreIndustry(lead.company?.industry, config);
  const engagementResult = scoreEngagement(lead);
  const recencyResult = scoreRecency(lead);
  const customResult = evaluateCustomRules(lead, config.custom_rules);

  // Weighted average
  const total = Math.round(
    titleResult.score * config.job_title_weight +
    sizeResult.score * config.company_size_weight +
    industryResult.score * config.industry_weight +
    engagementResult.score * config.engagement_weight +
    recencyResult.score * config.recency_weight +
    customResult.score * config.custom_rules_weight
  );

  const breakdown: ScoreBreakdown = {
    total,
    job_title_score: titleResult.score,
    company_size_score: sizeResult.score,
    industry_score: industryResult.score,
    engagement_score: engagementResult.score,
    recency_score: recencyResult.score,
    custom_rules_score: customResult.score,
    details: [
      ...titleResult.details,
      ...sizeResult.details,
      ...industryResult.details,
      ...engagementResult.details,
      ...recencyResult.details,
      ...customResult.details,
    ],
  };

  const status = total >= 60 ? 'qualified' : 'disqualified';

  const updated = await s.updateLead(leadId, {
    score: total,
    score_breakdown: breakdown,
    status,
    scored_at: new Date().toISOString(),
  });

  return updated!;
}
