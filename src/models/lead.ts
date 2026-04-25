// src/models/lead.ts
import { z } from 'zod/v4';

/** Lead source enumeration. */
export const LeadSourceSchema = z.enum([
  'website_form',
  'landing_page',
  'api',
  'csv_import',
  'manual',
  'webhook',
]);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

/** Lead status enumeration. */
export const LeadStatusSchema = z.enum([
  'new',
  'enriched',
  'scored',
  'qualified',
  'disqualified',
  'exported',
  'archived',
]);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

/** Company size enumeration. */
export const CompanySizeSchema = z.enum([
  '1-10',
  '11-50',
  '51-200',
  '201-500',
  '501-1000',
  '1001-5000',
  '5000+',
]);
export type CompanySize = z.infer<typeof CompanySizeSchema>;

/** Information about a company. */
export const CompanyInfoSchema = z.object({
  name: z.string().optional(),
  domain: z.string().optional(),
  industry: z.string().optional(),
  size: CompanySizeSchema.optional(),
  country: z.string().optional(),
  description: z.string().optional(),
  linkedin_url: z.string().optional(),
  tech_stack: z.array(z.string()).optional(),
});
export type CompanyInfo = z.infer<typeof CompanyInfoSchema>;

/** Details of a single scoring rule application. */
export const ScoringDetailSchema = z.object({
  rule: z.string(),
  points: z.number(),
  reason: z.string(),
});
export type ScoringDetail = z.infer<typeof ScoringDetailSchema>;

/** Breakdown of a lead's score across all dimensions. */
export const ScoreBreakdownSchema = z.object({
  total: z.number().min(0).max(100),
  job_title_score: z.number().min(0).max(100),
  company_size_score: z.number().min(0).max(100),
  industry_score: z.number().min(0).max(100),
  engagement_score: z.number().min(0).max(100),
  recency_score: z.number().min(0).max(100),
  custom_rules_score: z.number().min(0).max(100),
  details: z.array(ScoringDetailSchema),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

/** Operator enumeration for custom scoring rules. */
export const OperatorSchema = z.enum([
  'equals',
  'contains',
  'starts_with',
  'ends_with',
  'gt',
  'lt',
  'regex',
]);
export type Operator = z.infer<typeof OperatorSchema>;

/** Custom rule used in scoring configuration. */
export const CustomRuleSchema = z.object({
  field: z.string().describe('Lead field to evaluate. Dot-paths are supported (e.g. "email", "job_title", "company.industry", "custom_fields.utm_source").'),
  operator: OperatorSchema.describe('How field is compared to value: "equals" / "contains" / "starts_with" / "ends_with" for strings, "gt" / "lt" for numeric, or "regex" for full pattern match.'),
  value: z.string().describe('Comparison value as a string. For numeric operators (gt/lt) the string is parsed as a number. For regex it is the pattern.'),
  points: z.number().min(-50).max(50).describe('Score adjustment when the rule matches. Range -50..+50. Positive boosts the lead, negative penalizes.'),
  description: z.string().describe('Human-readable description shown in score_breakdown.details so users understand why a lead got the points.'),
});
export type CustomRule = z.infer<typeof CustomRuleSchema>;

/** Configuration for the scoring engine. */
export const ScoringConfigSchema = z.object({
  job_title_weight: z.number().min(0).max(1).default(0.25),
  company_size_weight: z.number().min(0).max(1).default(0.20),
  industry_weight: z.number().min(0).max(1).default(0.20),
  engagement_weight: z.number().min(0).max(1).default(0.15),
  recency_weight: z.number().min(0).max(1).default(0.10),
  custom_rules_weight: z.number().min(0).max(1).default(0.10),
  high_value_titles: z
    .array(z.string())
    .default(['ceo', 'cto', 'vp', 'director', 'head', 'founder', 'owner', 'manager']),
  high_value_industries: z
    .array(z.string())
    .default(['saas', 'technology', 'software', 'fintech', 'ecommerce', 'marketing', 'consulting']),
  preferred_company_sizes: z.array(CompanySizeSchema).default(['11-50', '51-200', '201-500']),
  custom_rules: z.array(CustomRuleSchema).default([]),
});
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/** Core Lead object. */
export const LeadSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  phone: z.string().optional(),
  job_title: z.string().optional(),
  company: CompanyInfoSchema.optional(),
  source: LeadSourceSchema,
  source_detail: z.string().optional(),
  tags: z.array(z.string()).default([]),
  custom_fields: z.record(z.string(), z.string()).default({}),
  score: z.number().min(0).max(100).nullable().default(null),
  score_breakdown: ScoreBreakdownSchema.nullable().default(null),
  status: LeadStatusSchema.default('new'),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  enriched_at: z.string().datetime().nullable(),
  scored_at: z.string().datetime().nullable(),
  exported_at: z.string().datetime().nullable(),
});
export type Lead = z.infer<typeof LeadSchema>;

/** Input schema for ingesting a single lead. */
export const LeadIngestInputSchema = z.object({
  email: z.string().email().describe('Business email address. Required and used as the unique key — duplicate emails are rejected, not upserted. Example: "alex@acme.com".'),
  first_name: z.string().optional().describe('Optional first name. Stored verbatim and used for personalization in CRM exports.'),
  last_name: z.string().optional().describe('Optional last name. Combined with first_name to populate full_name on the stored lead.'),
  phone: z.string().optional().describe('Optional phone number in any format. Stored verbatim and forwarded to CRM exports.'),
  job_title: z.string().optional().describe('Job title used by lead_score for the job_title dimension. High-value titles (ceo, cto, vp, director, head, founder) earn the highest points. Configurable via config_scoring.high_value_titles.'),
  company_name: z.string().optional().describe('Company display name. If omitted, lead_enrich will derive it from the email domain.'),
  company_domain: z.string().optional().describe('Company root domain (e.g. "acme.com"). If omitted, derived from the email. Used by lead_enrich for the domain knowledge-base lookup.'),
  source: LeadSourceSchema.default('api').describe('Where the lead originated. One of: website_form, landing_page, api, csv_import, manual, webhook. Defaults to "api".'),
  source_detail: z.string().optional().describe('Free-text refinement of source — e.g. "homepage hero form", "Q1 webinar", "Reddit r/SaaS post".'),
  tags: z.array(z.string()).optional().describe('Free-form tags for downstream filtering in lead_search and lead_export. Example: ["enterprise", "follow_up", "demo_requested"].'),
  custom_fields: z.record(z.string(), z.string()).optional().describe('Arbitrary string→string metadata. Use for UTM parameters, A/B test variants, or anything you want to preserve through scoring and export.'),
});
export type LeadIngestInput = z.infer<typeof LeadIngestInputSchema>;

/** Batch ingest input — array of leads (1-100). */
export const LeadBatchIngestInputSchema = z.object({
  leads: z.array(LeadIngestInputSchema).min(1).max(100).describe('Array of 1–100 leads, each using the same shape as lead_ingest input. Duplicates within the batch and against existing pipeline emails are SKIPPED (not failed) — partial success is the norm. Returns {ingested: Lead[], skipped: Array<{email, reason}>}.'),
});
export type LeadBatchIngestInput = z.infer<typeof LeadBatchIngestInputSchema>;

/** Input schema for searching/filtering leads. */
export const LeadSearchInputSchema = z.object({
  query: z.string().optional().describe('Case-insensitive substring search over email, first_name, last_name, job_title, and company.name. AND-combined with the other filters.'),
  status: LeadStatusSchema.optional().describe('Restrict to a single status: new (just ingested), enriched (lead_enrich done), scored (has score), qualified (score ≥ threshold), disqualified, exported, archived.'),
  min_score: z.number().optional().describe('Inclusive lower bound on score (0–100). Combine with status="qualified" for high-priority follow-up lists.'),
  max_score: z.number().optional().describe('Inclusive upper bound on score (0–100). Useful for review queues — e.g. min_score=40, max_score=60 to surface borderline leads.'),
  source: LeadSourceSchema.optional().describe('Filter to a single source channel.'),
  tags: z.array(z.string()).optional().describe('Tags that must ALL be present on the lead (AND semantics). Empty array is ignored.'),
  limit: z.number().int().min(1).max(100).default(20).describe('Page size, 1–100. Defaults to 20.'),
  offset: z.number().int().default(0).describe('Number of results to skip for pagination. Defaults to 0.'),
});
export type LeadSearchInput = z.infer<typeof LeadSearchInputSchema>;

/** Export target enumeration. */
export const ExportTargetSchema = z.enum([
  'hubspot',
  'pipedrive',
  'google_sheets',
  'csv',
  'json',
]);
export type ExportTarget = z.infer<typeof ExportTargetSchema>;

/** Input schema for exporting leads to CRM or file. */
export const LeadExportInputSchema = z.object({
  lead_ids: z.array(z.string()).optional().describe('Explicit list of lead UUIDs to export. If omitted, every lead matching min_score (or all leads, when min_score is also omitted) is exported.'),
  target: ExportTargetSchema.describe('Where to send the leads. "hubspot" / "pipedrive" require HUBSPOT_API_KEY / PIPEDRIVE_API_TOKEN env vars — without them, the tool returns a dry-run payload instead of erroring. "google_sheets" requires GOOGLE_SHEETS_CREDENTIALS. "csv" / "json" produce inline output you can pipe to disk.'),
  min_score: z.number().optional().describe('Inclusive minimum score for inclusion. Use 60+ for "qualified-only" exports. Ignored when lead_ids is provided.'),
});
export type LeadExportInput = z.infer<typeof LeadExportInputSchema>;
