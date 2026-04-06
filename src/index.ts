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
import { storage } from './services/storage.js';
import { handleToolError } from './utils/errors.js';

const server = new McpServer({
  name: 'leadpipe-mcp',
  version: '1.0.0',
});

// ━━━ TOOL: lead_ingest ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.registerTool(
  'lead_ingest',
  {
    title: 'Ingest Lead',
    description:
      'Add a new lead to the pipeline. Provide email (required) and optional fields like name, job title, company. Duplicate emails are rejected.',
    inputSchema: LeadIngestInputSchema,
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
      'Add multiple leads at once (1-100). Returns count of ingested and skipped (duplicates).',
    inputSchema: LeadBatchIngestInputSchema,
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
      'Enrich a lead with company data (industry, size, country, tech stack) using the email domain. Provide the lead ID.',
    inputSchema: z.object({
      lead_id: z.string().describe('The lead ID to enrich'),
    }),
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
      'Calculate an AI-powered qualification score (0-100) for a lead based on job title, company size, industry, and custom rules. Updates the lead status to qualified (>=60) or disqualified (<60).',
    inputSchema: z.object({
      lead_id: z.string().describe('The lead ID to score'),
    }),
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
      'Search and filter leads by text query, status, score range, source, or tags. Supports pagination.',
    inputSchema: LeadSearchInputSchema,
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
      'Export leads to HubSpot, Pipedrive, Google Sheets, CSV, or JSON. Optionally filter by lead IDs or minimum score.',
    inputSchema: LeadExportInputSchema,
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
      'Get lead pipeline analytics: total leads, status/source breakdown, average score, score distribution, conversion rates.',
    inputSchema: z.object({}),
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
      'View or update the lead scoring configuration. Pass empty object to view current config. Pass fields to update weights, titles, industries, or custom rules.',
    inputSchema: z.object({
      job_title_weight: z.number().min(0).max(1).optional(),
      company_size_weight: z.number().min(0).max(1).optional(),
      industry_weight: z.number().min(0).max(1).optional(),
      engagement_weight: z.number().min(0).max(1).optional(),
      recency_weight: z.number().min(0).max(1).optional(),
      custom_rules_weight: z.number().min(0).max(1).optional(),
      high_value_titles: z.array(z.string()).optional(),
      high_value_industries: z.array(z.string()).optional(),
      preferred_company_sizes: z.array(CompanySizeSchema).optional(),
      custom_rules: z.array(CustomRuleSchema).optional(),
    }),
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

// ━━━ START SERVER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  const isHTTP = process.env.PORT || process.env.MCPIZE;

  if (isHTTP) {
    // Production: Streamable HTTP for MCPize deployment
    const port = parseInt(process.env.PORT ?? '8080', 10);

    const httpServer = createServer(async (req, res) => {
      // Health check endpoint
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
        return;
      }

      // MCP endpoint
      if (req.method === 'POST' && req.url === '/mcp') {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    httpServer.listen(port, () => {
      console.error(`LeadPipe MCP Server v1.0.0 running on HTTP port ${port}`);
    });
  } else {
    // Local development: stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('LeadPipe MCP Server v1.0.0 running on stdio');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
