import type { Lead, LeadExportInput } from '../../models/lead.js';
import { storage } from '../storage.js';

const FETCH_TIMEOUT_MS = 15_000;

export interface ExportResult {
  target: string;
  exported_count: number;
  failed_count: number;
  summary: string;
  errors?: string[];
  data?: unknown;
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function getLeadsForExport(input: LeadExportInput): Promise<Lead[]> {
  if (input.lead_ids && input.lead_ids.length > 0) {
    const leads: Lead[] = [];
    for (const id of input.lead_ids) {
      const lead = await storage.getLeadById(id);
      if (lead) leads.push(lead);
    }
    return leads;
  }

  const all = await storage.getAllLeads();
  return all.filter((lead) => {
    if (input.min_score != null && (lead.score == null || lead.score < input.min_score)) {
      return false;
    }
    return lead.status === 'qualified' || lead.status === 'scored';
  });
}

function leadsToCSV(leads: Lead[]): string {
  const headers = [
    'id', 'email', 'first_name', 'last_name', 'job_title',
    'company', 'industry', 'company_size', 'score', 'status',
    'source', 'created_at',
  ];

  const rows = leads.map((lead) => [
    lead.id,
    lead.email,
    lead.first_name ?? '',
    lead.last_name ?? '',
    lead.job_title ?? '',
    lead.company?.name ?? '',
    lead.company?.industry ?? '',
    lead.company?.size ?? '',
    lead.score?.toString() ?? '',
    lead.status,
    lead.source,
    lead.created_at,
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));

  return [headers.join(','), ...rows].join('\n');
}

function formatForCRM(lead: Lead): Record<string, string> {
  return {
    email: lead.email,
    firstname: lead.first_name ?? '',
    lastname: lead.last_name ?? '',
    jobtitle: lead.job_title ?? '',
    company: lead.company?.name ?? '',
    phone: lead.phone ?? '',
    leadsource: lead.source,
    lead_score: lead.score?.toString() ?? '',
  };
}

async function markExported(leadIds: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const id of leadIds) {
    await storage.updateLead(id, { status: 'exported', exported_at: now });
  }
}

async function exportToHubSpot(leads: Lead[]): Promise<ExportResult> {
  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) {
    return {
      target: 'hubspot',
      exported_count: 0,
      failed_count: 0,
      summary: 'HubSpot export requires HUBSPOT_API_KEY. Set it in your MCP client configuration or environment.',
      data: { contacts: leads.map(formatForCRM) },
    };
  }

  const successIds: string[] = [];
  const errors: string[] = [];

  for (const lead of leads) {
    try {
      const res = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: formatForCRM(lead) }),
      });
      if (res.ok) {
        successIds.push(lead.id);
      } else {
        const body = await res.text().catch(() => 'unknown');
        errors.push(`${lead.email}: HTTP ${res.status} — ${body.slice(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${lead.email}: ${msg}`);
      console.error(`[HubSpot export error] ${lead.email}:`, msg);
    }
  }

  if (successIds.length > 0) await markExported(successIds);

  return {
    target: 'hubspot',
    exported_count: successIds.length,
    failed_count: leads.length - successIds.length,
    summary: `Exported ${successIds.length}/${leads.length} contacts to HubSpot.${errors.length > 0 ? ` ${errors.length} failed.` : ''}`,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function exportToPipedrive(leads: Lead[]): Promise<ExportResult> {
  const apiKey = process.env.PIPEDRIVE_API_KEY;
  if (!apiKey) {
    return {
      target: 'pipedrive',
      exported_count: 0,
      failed_count: 0,
      summary: 'Pipedrive export requires PIPEDRIVE_API_KEY. Set it in your MCP client configuration or environment.',
      data: { persons: leads.map(formatForCRM) },
    };
  }

  const successIds: string[] = [];
  const errors: string[] = [];

  for (const lead of leads) {
    try {
      // API key in header, not URL (security: prevents key leakage in logs/proxies)
      const res = await fetchWithTimeout('https://api.pipedrive.com/v1/persons', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-token': apiKey,
        },
        body: JSON.stringify({
          name: lead.full_name ?? lead.email,
          email: [{ value: lead.email, primary: true }],
          phone: lead.phone ? [{ value: lead.phone, primary: true }] : undefined,
        }),
      });
      if (res.ok) {
        successIds.push(lead.id);
      } else {
        const body = await res.text().catch(() => 'unknown');
        errors.push(`${lead.email}: HTTP ${res.status} — ${body.slice(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${lead.email}: ${msg}`);
      console.error(`[Pipedrive export error] ${lead.email}:`, msg);
    }
  }

  if (successIds.length > 0) await markExported(successIds);

  return {
    target: 'pipedrive',
    exported_count: successIds.length,
    failed_count: leads.length - successIds.length,
    summary: `Exported ${successIds.length}/${leads.length} persons to Pipedrive.${errors.length > 0 ? ` ${errors.length} failed.` : ''}`,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export async function exportLeads(input: LeadExportInput): Promise<ExportResult> {
  const leads = await getLeadsForExport(input);

  if (leads.length === 0) {
    return {
      target: input.target,
      exported_count: 0,
      failed_count: 0,
      summary: 'No leads matched the export criteria.',
    };
  }

  switch (input.target) {
    case 'hubspot':
      return exportToHubSpot(leads);

    case 'pipedrive':
      return exportToPipedrive(leads);

    case 'google_sheets':
      return {
        target: 'google_sheets',
        exported_count: leads.length,
        failed_count: 0,
        summary: `Prepared ${leads.length} leads for Google Sheets. Set GOOGLE_SHEETS_CREDENTIALS to enable direct export.`,
        data: { rows: leads.map(formatForCRM) },
      };

    case 'csv': {
      const csv = leadsToCSV(leads);
      const ids = leads.map((l) => l.id);
      await markExported(ids);
      return {
        target: 'csv',
        exported_count: leads.length,
        failed_count: 0,
        summary: `Exported ${leads.length} leads as CSV.`,
        data: csv,
      };
    }

    case 'json': {
      const ids = leads.map((l) => l.id);
      await markExported(ids);
      return {
        target: 'json',
        exported_count: leads.length,
        failed_count: 0,
        summary: `Exported ${leads.length} leads as JSON.`,
        data: leads,
      };
    }

    default:
      return {
        target: input.target,
        exported_count: 0,
        failed_count: 0,
        summary: `Unknown export target: ${input.target}`,
      };
  }
}
