/**
 * Demo seed service — populate LeadPipe with a realistic set of leads
 * covering multiple archetypes (qualified, unqualified, enriched,
 * raw). Designed so MCP Inspector users can evaluate every tool
 * (lead_list, lead_score, lead_search, crm_export, etc.) without
 * hitting Hunter, HubSpot, or Pipedrive credentials.
 */

import { randomUUID } from 'node:crypto';
import type { Lead, LeadSource, LeadStatus, CompanyInfo, CompanySize } from '../models/lead.js';
import { Storage, storage as defaultStorage } from './storage.js';

// ─── Seed specs ──────────────────────────────────────────────────
interface LeadSpec {
  first: string;
  last: string;
  title: string;
  companyName: string;
  domain: string;
  industry: string;
  size: CompanySize;
  country: string;
  source: LeadSource;
  archetype: 'hot' | 'warm' | 'cold' | 'raw' | 'disqualified';
}

const LEAD_SPECS: LeadSpec[] = [
  // Hot leads — senior decision makers at target industries
  { first: 'Sarah',   last: 'Chen',       title: 'VP of Engineering', companyName: 'Acme Technologies', domain: 'acmetech.example',   industry: 'saas',        size: '51-200',   country: 'US', source: 'website_form',  archetype: 'hot' },
  { first: 'Marcus',  last: 'Weber',      title: 'CTO',               companyName: 'BlueLabs GmbH',     domain: 'bluelabs.example',   industry: 'fintech',     size: '201-500',  country: 'DE', source: 'landing_page',  archetype: 'hot' },
  { first: 'Priya',   last: 'Patel',      title: 'Head of Growth',    companyName: 'Zenith AI',         domain: 'zenithai.example',   industry: 'technology',  size: '11-50',    country: 'US', source: 'webhook',       archetype: 'hot' },
  { first: 'Diego',   last: 'Martinez',   title: 'CEO',               companyName: 'Peak Consulting',   domain: 'peakconsulting.example', industry: 'consulting', size: '11-50',  country: 'ES', source: 'website_form',  archetype: 'hot' },

  // Warm leads — good fit, mid-level
  { first: 'Olivia',  last: 'Thompson',   title: 'Marketing Director', companyName: 'Nova Studio',      domain: 'novastudio.example', industry: 'marketing',   size: '51-200',   country: 'GB', source: 'api',           archetype: 'warm' },
  { first: 'Lucas',   last: 'Janssen',    title: 'Product Manager',    companyName: 'Northwave BV',     domain: 'northwave.example',  industry: 'ecommerce',   size: '201-500',  country: 'NL', source: 'csv_import',    archetype: 'warm' },
  { first: 'Amelie',  last: 'Dubois',     title: 'Sales Manager',      companyName: 'Atelier Dubois',   domain: 'atelierd.example',   industry: 'software',    size: '11-50',    country: 'FR', source: 'landing_page',  archetype: 'warm' },
  { first: 'Tom',     last: 'Hargreaves', title: 'Operations Manager', companyName: 'Stonebridge Ltd',  domain: 'stonebridge.example',industry: 'consulting',  size: '51-200',   country: 'GB', source: 'website_form',  archetype: 'warm' },

  // Cold leads — lower authority, smaller companies
  { first: 'Emma',    last: 'Larsson',    title: 'Junior Analyst',    companyName: 'Sparkline Inc',   domain: 'sparkline.example',  industry: 'marketing',   size: '1-10',     country: 'US', source: 'csv_import',    archetype: 'cold' },
  { first: 'Ravi',    last: 'Kumar',      title: 'Intern',            companyName: 'Beacon Tech',     domain: 'beacontech.example', industry: 'technology',  size: '1-10',     country: 'US', source: 'manual',        archetype: 'cold' },
  { first: 'Sofia',   last: 'Rossi',      title: 'Coordinator',       companyName: 'Milano Design',   domain: 'milanodesign.example',industry: 'design',     size: '11-50',    country: 'IT', source: 'api',           archetype: 'cold' },

  // Raw leads — no enrichment yet
  { first: 'Alex',    last: 'Kim',        title: '',                  companyName: '',                 domain: 'unknown.example',    industry: '',            size: '1-10',     country: '',   source: 'website_form',  archetype: 'raw' },
  { first: 'Jordan',  last: 'Reyes',      title: '',                  companyName: '',                 domain: 'freemail.example',   industry: '',            size: '1-10',     country: '',   source: 'landing_page',  archetype: 'raw' },

  // Disqualified — competitor / personal email pattern
  { first: 'Pat',     last: 'Competitor', title: 'Researcher',        companyName: 'RivalCorp',        domain: 'rivalcorp.example',  industry: 'saas',        size: '5000+',    country: 'US', source: 'website_form',  archetype: 'disqualified' },
];

function scoreForArchetype(a: LeadSpec['archetype']): { score: number | null; status: LeadStatus } {
  switch (a) {
    case 'hot':          return { score: 88, status: 'qualified' };
    case 'warm':         return { score: 68, status: 'scored' };
    case 'cold':         return { score: 32, status: 'scored' };
    case 'raw':          return { score: null, status: 'new' };
    case 'disqualified': return { score: 15, status: 'disqualified' };
  }
}

// ─── Main seed function ──────────────────────────────────────────
export interface DemoSeedResult {
  leads: number;
  qualified: number;
  scored: number;
  new: number;
  disqualified: number;
  avg_score: number | null;
  sample_lead_ids: string[];
  message: string;
}

/**
 * Populate the pipeline with a realistic demo dataset spanning multiple
 * archetypes: hot (senior decision-makers), warm (mid-level at target
 * industries), cold (junior/small companies), raw (no enrichment yet),
 * and disqualified. Every lead gets appropriate enrichment and scoring
 * state so downstream tools — lead_list, lead_search, lead_score,
 * crm_export, pipeline_stats — return meaningful output immediately.
 * Safe to call multiple times: each call appends a fresh batch.
 */
export async function seedDemoLeads(store?: Storage): Promise<DemoSeedResult> {
  const s = store ?? defaultStorage;
  const now = new Date();
  const nowMs = now.getTime();

  const leads: Lead[] = [];
  let qualified = 0, scored = 0, newCount = 0, disqualified = 0;
  let scoreSum = 0, scoreN = 0;

  for (let i = 0; i < LEAD_SPECS.length; i++) {
    const spec = LEAD_SPECS[i];
    const { score, status } = scoreForArchetype(spec.archetype);

    // Spread creation over last ~60 days
    const ageDays = 2 + (i * 4) % 58;
    const createdAt = new Date(nowMs - ageDays * 86_400_000);
    const enrichedAt = spec.archetype === 'raw' ? null : new Date(createdAt.getTime() + 3_600_000);
    const scoredAt = score != null ? new Date((enrichedAt ?? createdAt).getTime() + 60_000) : null;

    const hasCompany = spec.archetype !== 'raw' && spec.companyName !== '';
    const company: CompanyInfo | undefined = hasCompany
      ? {
          name: spec.companyName,
          domain: spec.domain,
          industry: spec.industry,
          size: spec.size,
          country: spec.country,
          description: `${spec.companyName} — ${spec.industry} company, ${spec.size} employees.`,
          linkedin_url: `https://linkedin.com/company/${spec.domain.replace(/\./g, '-')}`,
          tech_stack: spec.industry === 'saas' || spec.industry === 'technology'
            ? ['TypeScript', 'Node.js', 'React', 'PostgreSQL']
            : spec.industry === 'fintech'
            ? ['Python', 'Go', 'Kubernetes', 'Redis']
            : ['JavaScript', 'WordPress'],
        }
      : undefined;

    const firstLower = spec.first.toLowerCase();
    const lastLower = spec.last.toLowerCase();
    const emailDomain = spec.domain || 'example.test';
    const email = `${firstLower}.${lastLower}@${emailDomain}`;

    const lead: Lead = {
      id: randomUUID(),
      email,
      first_name: spec.first,
      last_name: spec.last,
      full_name: `${spec.first} ${spec.last}`,
      phone: spec.archetype === 'hot' || spec.archetype === 'warm' ? `+1-555-${String(1000 + i).padStart(4, '0')}` : undefined,
      job_title: spec.title || undefined,
      company,
      source: spec.source,
      source_detail: spec.source === 'landing_page' ? '/pricing' : spec.source === 'website_form' ? '/contact' : undefined,
      tags: spec.archetype === 'hot' ? ['enterprise', 'priority'] : spec.archetype === 'warm' ? ['follow-up'] : [],
      custom_fields: spec.archetype === 'hot'
        ? { budget: '50k-100k', timeline: 'Q2-Q3' }
        : {},
      score,
      score_breakdown: score != null
        ? {
            total: score,
            job_title_score: spec.archetype === 'hot' ? 95 : spec.archetype === 'warm' ? 70 : 30,
            company_size_score: spec.size === '11-50' || spec.size === '51-200' || spec.size === '201-500' ? 85 : 40,
            industry_score: ['saas', 'fintech', 'technology', 'ecommerce', 'marketing', 'consulting'].includes(spec.industry) ? 90 : 45,
            engagement_score: spec.archetype === 'hot' ? 80 : spec.archetype === 'warm' ? 55 : 25,
            recency_score: Math.max(0, 100 - ageDays * 2),
            custom_rules_score: 0,
            details: [
              { rule: 'high_value_title', points: spec.archetype === 'hot' ? 20 : 0, reason: `Title "${spec.title}" ${spec.archetype === 'hot' ? 'matches' : 'does not match'} high-value list` },
              { rule: 'preferred_size', points: (spec.size === '11-50' || spec.size === '51-200' || spec.size === '201-500') ? 15 : -5, reason: `Size ${spec.size}` },
            ],
          }
        : null,
      status,
      created_at: createdAt.toISOString(),
      updated_at: (scoredAt ?? enrichedAt ?? createdAt).toISOString(),
      enriched_at: enrichedAt ? enrichedAt.toISOString() : null,
      scored_at: scoredAt ? scoredAt.toISOString() : null,
      exported_at: null,
    };

    leads.push(lead);
    if (status === 'qualified') qualified++;
    else if (status === 'scored') scored++;
    else if (status === 'disqualified') disqualified++;
    else if (status === 'new') newCount++;
    if (score != null) { scoreSum += score; scoreN++; }
  }

  // Persist
  for (const l of leads) await s.addLead(l);

  const avgScore = scoreN > 0 ? Math.round((scoreSum / scoreN) * 10) / 10 : null;

  return {
    leads: leads.length,
    qualified,
    scored,
    new: newCount,
    disqualified,
    avg_score: avgScore,
    sample_lead_ids: leads.slice(0, 5).map((l) => l.id),
    message: `Seeded ${leads.length} leads (${qualified} qualified, ${scored} scored, ${newCount} new, ${disqualified} disqualified). Try: lead_list with status filter, or crm_export with min_score=60.`,
  };
}
