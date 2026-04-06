import { v4 as uuidv4 } from 'uuid';
import type { Lead, LeadIngestInput } from '../models/lead.js';
import { storage } from '../services/storage.js';
import { DuplicateError } from '../utils/errors.js';

export async function ingestLead(input: LeadIngestInput): Promise<Lead> {
  const existing = await storage.getLeadByEmail(input.email);
  if (existing) {
    throw new DuplicateError('email', input.email);
  }

  const now = new Date().toISOString();
  const lead: Lead = {
    id: uuidv4(),
    email: input.email,
    first_name: input.first_name,
    last_name: input.last_name,
    full_name:
      input.first_name && input.last_name
        ? `${input.first_name} ${input.last_name}`
        : input.first_name ?? input.last_name,
    phone: input.phone,
    job_title: input.job_title,
    company: input.company_name || input.company_domain
      ? {
          name: input.company_name,
          domain: input.company_domain,
        }
      : undefined,
    source: input.source ?? 'api',
    source_detail: input.source_detail,
    tags: input.tags ?? [],
    custom_fields: input.custom_fields ?? {},
    score: null,
    score_breakdown: null,
    status: 'new',
    created_at: now,
    updated_at: now,
    enriched_at: null,
    scored_at: null,
    exported_at: null,
  };

  return storage.addLead(lead);
}

export async function ingestBatch(inputs: LeadIngestInput[]): Promise<{
  ingested: Lead[];
  skipped: { email: string; reason: string }[];
}> {
  const ingested: Lead[] = [];
  const skipped: { email: string; reason: string }[] = [];

  for (const input of inputs) {
    try {
      const lead = await ingestLead(input);
      ingested.push(lead);
    } catch (error) {
      if (error instanceof DuplicateError) {
        skipped.push({ email: input.email, reason: 'duplicate' });
      } else {
        skipped.push({ email: input.email, reason: String(error) });
      }
    }
  }

  return { ingested, skipped };
}
