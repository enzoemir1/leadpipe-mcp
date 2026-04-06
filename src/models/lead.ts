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
  field: z.string(),
  operator: OperatorSchema,
  value: z.string(),
  points: z.number().min(-50).max(50),
  description: z.string(),
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
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  phone: z.string().optional(),
  job_title: z.string().optional(),
  company_name: z.string().optional(),
  company_domain: z.string().optional(),
  source: LeadSourceSchema.default('api'),
  source_detail: z.string().optional(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.string(), z.string()).optional(),
});
export type LeadIngestInput = z.infer<typeof LeadIngestInputSchema>;

/** Batch ingest input — array of leads (1-100). */
export const LeadBatchIngestInputSchema = z.object({
  leads: z.array(LeadIngestInputSchema).min(1).max(100),
});
export type LeadBatchIngestInput = z.infer<typeof LeadBatchIngestInputSchema>;

/** Input schema for searching/filtering leads. */
export const LeadSearchInputSchema = z.object({
  query: z.string().optional(),
  status: LeadStatusSchema.optional(),
  min_score: z.number().optional(),
  max_score: z.number().optional(),
  source: LeadSourceSchema.optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().default(0),
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
  lead_ids: z.array(z.string()).optional(),
  target: ExportTargetSchema,
  min_score: z.number().optional(),
});
export type LeadExportInput = z.infer<typeof LeadExportInputSchema>;
