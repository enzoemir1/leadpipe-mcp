import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import {
  LeadIngestInputSchema,
  LeadBatchIngestInputSchema,
  LeadSearchInputSchema,
  LeadExportInputSchema,
  CompanySizeSchema,
  CustomRuleSchema,
} from './models/lead.js';
import { ingestLead, ingestBatch } from './tools/ingest.js';
import { enrichLead } from './services/enrichment.js';
import { scoreLead } from './services/scoring-engine.js';
import { exportLeads } from './services/crm/exporter.js';
import { seedDemoLeads } from './services/demo-seed.js';
import { qualifyLeads, type QualificationCriteria } from './services/qualify.js';
import { storage } from './services/storage.js';
import { handleToolError } from './utils/errors.js';

const SERVER_VERSION = '1.4.1';

const server = new McpServer({
  name: 'leadpipe-mcp',
  version: SERVER_VERSION,
});

// ━━━ TOOL: lead_demo_seed ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'lead_demo_seed',
  {
    title: 'Seed Demo Leads',
    description: 'Populate the pipeline with a realistic demo dataset: 14 leads across 5 archetypes (hot decision-makers, warm mid-level, cold junior/small-co, raw unenriched, and disqualified). Each lead has appropriate enrichment state, scoring breakdown, and status, so every downstream tool — lead_list, lead_search, lead_score, crm_export, and the pipeline-overview resource — returns meaningful output immediately. Use this to evaluate LeadPipe via MCP Inspector without Hunter, HubSpot, or Pipedrive API keys. Safe to call multiple times; each call appends a fresh batch with new UUIDs. Returns counts by status plus sample_lead_ids you can feed into lead_enrich, lead_score, or crm_export.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async () => {
    try {
      const result = await seedDemoLeads();
      const lines = [
        `Seeded ${result.leads} demo leads:`,
        `  Qualified: ${result.qualified}`,
        `  Scored: ${result.scored}`,
        `  New (unscored): ${result.new}`,
        `  Disqualified: ${result.disqualified}`,
        `  Avg score: ${result.avg_score ?? 'n/a'}`,
        ``,
        `Sample lead ids (use with lead_enrich, lead_score):`,
        ...result.sample_lead_ids.map((id) => `  - ${id}`),
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: lead_qualify ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const QualificationCriteriaSchema = z.object({
  reject_freemail: z.boolean().optional().describe('Reject gmail/yahoo/outlook/etc. — non-business emails.'),
  required_title_keywords: z.array(z.string()).optional().describe('Case-insensitive substrings a lead\'s job_title must contain (any match passes). E.g. ["vp", "director", "head"].'),
  exclude_title_keywords: z.array(z.string()).optional().describe('Case-insensitive substrings that disqualify if present in job_title.'),
  target_countries: z.array(z.string()).optional().describe('ISO 3166-1 alpha-2 country codes to target. E.g. ["US", "CA", "GB"].'),
  target_industries: z.array(z.string()).optional().describe('Industries the company must belong to (case-insensitive). E.g. ["saas", "fintech"].'),
  min_company_size: z.enum(['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+']).optional().describe('Reject leads below this company-size tier.'),
  domain_allowlist: z.array(z.string()).optional().describe('Only accept these domains (full domain or suffix match). E.g. ["acme.com", "stripe.com"].'),
  domain_blocklist: z.array(z.string()).optional().describe('Reject these domains. E.g. ["competitor.com"].'),
  required_tech_stack: z.array(z.string()).optional().describe('Tech-stack tokens the company.tech_stack must include. Useful when chained after a platform-detection tool (e.g. Detecto). E.g. ["shopify", "stripe"].'),
});

server.registerTool(
  'lead_qualify',
  {
    title: 'ICP Pre-Qualification (Pre-Enrichment Filter)',
    description:
      'Filter leads against your Ideal Customer Profile BEFORE spending enrichment credits. Uses only locally-available signals (email domain, job_title, country, industry hints, tech_stack) so nothing is charged to Hunter.io, HubSpot, Pipedrive, or any other external service. Set auto_disqualify=true to also update rejected leads to status="disqualified" with the reject reasons stored in custom_fields. If lead_ids is omitted, evaluates every lead currently in status="new". Pairs naturally with upstream platform-detection tools (e.g. Detecto\'s detect_platform) — run that first to populate company.tech_stack, then run lead_qualify with required_tech_stack=["shopify"] to drop wrong-platform leads before they cost a single API call. Returns qualified/rejected counts, per-lead reasons, and an estimated credit savings figure.',
    inputSchema: z.object({
      lead_ids: z.array(z.string().uuid()).optional().describe('Specific lead IDs to evaluate. If omitted, evaluates all leads with status="new".'),
      criteria: QualificationCriteriaSchema.describe('At least one criterion is required. All provided criteria must pass for a lead to qualify.'),
      auto_disqualify: z.boolean().default(false).describe('If true, rejected leads have status set to "disqualified" and reasons stored in custom_fields. If false (default), just returns the evaluation without mutating storage.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ lead_ids, criteria, auto_disqualify }) => {
    try {
      const summary = await qualifyLeads({
        lead_ids,
        criteria: criteria as QualificationCriteria,
        auto_disqualify,
      });
      const lines = [
        `ICP qualification run:`,
        `  Evaluated: ${summary.evaluated}`,
        `  Qualified: ${summary.qualified}`,
        `  Rejected:  ${summary.rejected}`,
        `  Auto-disqualified in storage: ${summary.auto_disqualified}`,
        ``,
        `Cost savings: ${summary.cost_savings_estimate.note}`,
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: summary as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: lead_ingest ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'lead_ingest',
  {
    title: 'Ingest Lead',
    description:
      'Add a single lead to the pipeline. Required: email. Optional: first_name, last_name, job_title, company_name, phone, source ("website"|"linkedin"|"referral"|"event"|"cold_outreach"|"partner"|"other"), tags (string array), custom_fields. Returns the stored lead object with a generated UUID, initial status="new", created_at, and a null score (run lead_score to populate). Throws a duplicate error if the email is already in the pipeline — use lead_search first if you need upsert behaviour.',
    inputSchema: LeadIngestInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const lead = await ingestLead(input);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Lead ingested: ${lead.email} (id: ${lead.id}, status: ${lead.status})`,
          },
        ],
        structuredContent: lead,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: lead_batch_ingest ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'lead_batch_ingest',
  {
    title: 'Batch Ingest Leads',
    description:
      'Add 1 to 100 leads in a single call. Each lead uses the same schema as lead_ingest. Returns {ingested: Lead[], skipped: Array<{email, reason}>} — duplicates are skipped (not failed) so a partial batch still succeeds. Prefer this over repeated lead_ingest calls for bulk imports (CSV/webhook drops).',
    inputSchema: LeadBatchIngestInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const result = await ingestBatch(input.leads);
      const summary = `Batch complete: ${result.ingested.length} ingested, ${result.skipped.length} skipped.`;
      return {
        content: [{ type: 'text' as const, text: summary }],
        structuredContent: result,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: lead_enrich ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'lead_enrich',
  {
    title: 'Enrich Lead',
    description:
      'Derive and attach company data to an existing lead using the email domain: company name, industry, size, country, website, estimated headcount, and common tech stack. Does not call external APIs — enrichment is driven by the built-in domain knowledge base. Updates the lead in place and returns the enriched record, ready for lead_score. Run this before lead_score for the best qualification accuracy.',
    inputSchema: z.object({
      lead_id: z.string().uuid().describe('UUID of the lead to enrich (returned by lead_ingest or lead_search)'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ lead_id }) => {
    try {
      const lead = await enrichLead(lead_id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Lead enriched: ${lead.email} — Company: ${lead.company?.name ?? 'unknown'}, Industry: ${lead.company?.industry ?? 'unknown'}, Size: ${lead.company?.size ?? 'unknown'}`,
          },
        ],
        structuredContent: lead,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: lead_score ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'lead_score',
  {
    title: 'Score Lead',
    description:
      'Compute a 6-dimensional qualification score (0-100) for a lead: job_title, company_size, industry, engagement, recency, and custom_rules. Each dimension is weighted via config_scoring; the final score is their weighted average. Updates the lead status to "qualified" (≥60) or "disqualified" (<60) and stores score_breakdown alongside the total. Returns the updated lead with the breakdown. Run lead_enrich first for the most accurate industry/size signals.',
    inputSchema: z.object({
      lead_id: z.string().uuid().describe('UUID of the lead to score'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ lead_id }) => {
    try {
      const lead = await scoreLead(lead_id);
      const breakdown = lead.score_breakdown;
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Lead scored: ${lead.email} → ${lead.score}/100 (${lead.status})`,
              '',
              'Breakdown:',
              `  Job Title: ${breakdown?.job_title_score}/100`,
              `  Company Size: ${breakdown?.company_size_score}/100`,
              `  Industry: ${breakdown?.industry_score}/100`,
              `  Engagement: ${breakdown?.engagement_score}/100`,
              `  Recency: ${breakdown?.recency_score}/100`,
              `  Custom Rules: ${breakdown?.custom_rules_score}/100`,
            ].join('\n'),
          },
        ],
        structuredContent: lead,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: lead_search ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'lead_search',
  {
    title: 'Search Leads',
    description:
      'Search and filter the lead pipeline. Optional filters: query (free-text over name/email/company), status ("new"|"qualified"|"disqualified"|"contacted"|"converted"), min_score, max_score, source, tags (array), date_from/date_to. Pagination via limit (default 50, max 200) and offset. Returns {total, leads[]}. Use this to drive exports, targeted scoring, and dashboards.',
    inputSchema: LeadSearchInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const result = await storage.searchLeads(input);
      return {
        content: [
          { type: 'text' as const, text: `Found ${result.total} leads (showing ${result.leads.length}).` },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: lead_export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'lead_export',
  {
    title: 'Export Leads',
    description:
      'Push leads to an external destination. target must be one of "hubspot", "pipedrive", "google_sheets", "csv", or "json". For CRM targets (hubspot, pipedrive) the respective API key env var must be set (HUBSPOT_API_KEY, PIPEDRIVE_API_TOKEN) — if missing, the tool returns a dry-run payload instead of erroring. Filter the export via lead_ids (explicit list) or min_score (everything above threshold). Returns {target, count, summary, errors?}.',
    inputSchema: LeadExportInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const result = await exportLeads(input);
      return {
        content: [{ type: 'text' as const, text: result.summary }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: pipeline_stats ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'pipeline_stats',
  {
    title: 'Pipeline Statistics',
    description:
      'Portfolio-wide pipeline analytics across all leads. Returns {total_leads, leads_today, leads_this_week, leads_this_month, avg_score, qualified_rate (percent), by_status (counts per status), by_source (counts per source), score_distribution}. Takes no input — always aggregates the full dataset. Ideal for dashboards, stand-ups, and conversion-rate tracking.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const stats = await storage.getStats();
      const lines = [
        'Pipeline Stats',
        `Total leads: ${stats.total_leads}`,
        `Today: ${stats.leads_today} | This week: ${stats.leads_this_week} | This month: ${stats.leads_this_month}`,
        `Average score: ${stats.avg_score ?? 'N/A'}`,
        `Qualified rate: ${stats.qualified_rate}%`,
        '',
        `By status: ${Object.entries(stats.by_status).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        `By source: ${Object.entries(stats.by_source).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: stats as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ TOOL: config_scoring ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'config_scoring',
  {
    title: 'Scoring Configuration',
    description:
      'View or update the global lead scoring configuration used by lead_score. Call with no fields (empty object) to fetch the current config. Pass any subset of fields to patch-update: six dimension weights (each 0–1, should sum to ~1 but not enforced), high_value_titles (string array), high_value_industries (string array), preferred_company_sizes, and custom_rules (array of {name, condition, points}). Changes apply to future lead_score calls only — previously scored leads keep their scores until re-scored.',
    inputSchema: z.object({
      job_title_weight: z.number().min(0).max(1).optional().describe('Weight for the job_title dimension (0–1). Default 0.25. The six weights should sum to ~1 but it is not strictly enforced.'),
      company_size_weight: z.number().min(0).max(1).optional().describe('Weight for the company_size dimension (0–1). Default 0.20.'),
      industry_weight: z.number().min(0).max(1).optional().describe('Weight for the industry dimension (0–1). Default 0.20.'),
      engagement_weight: z.number().min(0).max(1).optional().describe('Weight for the engagement dimension (0–1). Default 0.15.'),
      recency_weight: z.number().min(0).max(1).optional().describe('Weight for the recency dimension (0–1). Default 0.10. Recently created leads score higher.'),
      custom_rules_weight: z.number().min(0).max(1).optional().describe('Weight for the custom_rules dimension (0–1). Default 0.10.'),
      high_value_titles: z.array(z.string()).optional().describe('Lowercase substrings that mark a job_title as high-value. Defaults: ["ceo", "cto", "vp", "director", "head", "founder", "owner", "manager"]. Match is case-insensitive substring.'),
      high_value_industries: z.array(z.string()).optional().describe('Lowercase substrings that mark a company industry as high-value. Defaults: ["saas", "technology", "software", "fintech", "ecommerce", "marketing", "consulting"].'),
      preferred_company_sizes: z.array(CompanySizeSchema).optional().describe('Company size tiers earning the maximum company_size_score. Defaults: ["11-50", "51-200", "201-500"].'),
      custom_rules: z.array(CustomRuleSchema).optional().describe('Array of custom scoring rules. Each rule is {field, operator, value, points (-50..+50), description}. Replaces the existing rule list when provided.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const hasUpdates = Object.values(input).some((v) => v !== undefined);
      if (hasUpdates) {
        const config = await storage.updateScoringConfig(input);
        return {
          content: [{ type: 'text' as const, text: 'Scoring configuration updated.' }],
          structuredContent: config,
        };
      }
      const config = await storage.getScoringConfig();
      return {
        content: [
          { type: 'text' as const, text: `Current scoring config:\n${JSON.stringify(config, null, 2)}` },
        ],
        structuredContent: config,
      };
    } catch (error) {
      return handleToolError(error);
    }
  }
);

// ━━━ RESOURCES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerResource(
  'recent-leads',
  'leads://recent',
  {
    title: 'Recent Leads',
    description: 'The 50 most recently added leads',
    mimeType: 'application/json',
  },
  async (uri) => {
    const result = await storage.searchLeads({ limit: 50, offset: 0 });
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(result.leads, null, 2),
        },
      ],
    };
  }
);

server.registerResource(
  'pipeline-overview',
  'leads://pipeline',
  {
    title: 'Pipeline Overview',
    description: 'Active pipeline summary with lead counts by status',
    mimeType: 'application/json',
  },
  async (uri) => {
    const stats = await storage.getStats();
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }
);

server.registerResource(
  'scoring-config',
  'leads://config',
  {
    title: 'Scoring Configuration',
    description: 'Current scoring engine configuration',
    mimeType: 'application/json',
  },
  async (uri) => {
    const config = await storage.getScoringConfig();
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(config, null, 2),
        },
      ],
    };
  }
);

// ━━━ PROMPTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.registerPrompt(
  'lead_qualification',
  { title: 'Lead Qualification Review', description: 'Guide through reviewing and qualifying a batch of new leads. Helps prioritize which leads to focus on based on scoring and enrichment data.' },
  async () => ({
    messages: [{
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'I\'ll help you review and qualify your leads. Let me start by checking your pipeline.\n\n1. First, I\'ll use `lead_search` to find unscored leads\n2. Then `lead_score` each one to get AI qualification scores\n3. Finally, I\'ll summarize the top prospects for your review\n\nWould you like me to start with all new leads, or filter by a specific source or tag?' },
    }],
  }),
);

server.registerPrompt(
  'pipeline_review',
  { title: 'Pipeline Health Review', description: 'Comprehensive review of your lead pipeline health — conversion rates, score distribution, source effectiveness, and actionable recommendations.' },
  async () => ({
    messages: [{
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'Let me run a complete pipeline health check.\n\n1. I\'ll use `pipeline_stats` to get current metrics\n2. Review score distribution and conversion rates\n3. Identify your best-performing lead sources\n4. Provide recommendations to improve qualification rates\n\nShall I proceed with the full analysis?' },
    }],
  }),
);

server.registerPrompt(
  'crm_export',
  { title: 'CRM Export Workflow', description: 'Guide through exporting qualified leads to your CRM — select criteria, choose target, and execute the export.' },
  async () => ({
    messages: [{
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'I\'ll help you export leads to your CRM.\n\n1. First, let\'s define criteria — minimum score, status, or tags\n2. I\'ll preview the leads that match\n3. Choose your target: HubSpot, Pipedrive, CSV, or JSON\n4. Execute the export\n\nWhich CRM would you like to export to?' },
    }],
  }),
);

// ━━━ SMITHERY SANDBOX ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _sandboxMode = false;
export function createSandboxServer() {
  _sandboxMode = true;
  return server;
}

// ━━━ START SERVER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  const isHTTP = process.env.PORT || process.env.MCPIZE;

  if (isHTTP) {
    // Production: Streamable HTTP for MCPize deployment
    const port = parseInt(process.env.PORT ?? '8080', 10);

    const httpServer = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'leadpipe-mcp', version: SERVER_VERSION }));
        return;
      }

      if ((req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE') && req.url === '/mcp') {
        try {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          try { await server.close(); } catch { /* not connected yet */ }
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch (err) {
          console.error('[LeadPipe MCP] Request error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    httpServer.listen(port, () => {
      console.error(`LeadPipe MCP Server v${SERVER_VERSION} running on HTTP port ${port}`);
    });
  } else {
    // Local development: stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`LeadPipe MCP Server v${SERVER_VERSION} running on stdio`);
  }
}

setTimeout(() => {
  if (!_sandboxMode) {
    main().catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  }
}, 0);
