import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Lead, LeadSearchInput, ScoringConfig } from '../models/lead.js';
import { ScoringConfigSchema } from '../models/lead.js';

export interface PipelineStats {
  total_leads: number;
  by_status: Record<string, number>;
  by_source: Record<string, number>;
  avg_score: number | null;
  score_distribution: { range: string; count: number }[];
  leads_today: number;
  leads_this_week: number;
  leads_this_month: number;
  qualified_rate: number;
}

class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let resolve: () => void;
    this.queue = new Promise<void>((r) => (resolve = r));
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }
}

/** JSON file-based storage with AsyncLock for concurrent write protection. Supports optional custom data directory for test isolation. */
export class Storage {
  private readonly dataDir: string;
  private readonly leadsPath: string;
  private readonly configPath: string;
  private readonly lock = new AsyncLock();
  private initialized = false;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? path.join(process.cwd(), 'data');
    this.leadsPath = path.join(this.dataDir, 'leads.json');
    this.configPath = path.join(this.dataDir, 'config.json');
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await fs.access(this.leadsPath);
    } catch {
      await fs.writeFile(this.leadsPath, '[]', 'utf-8');
    }
    try {
      await fs.access(this.configPath);
    } catch {
      const defaults = ScoringConfigSchema.parse({});
      await fs.writeFile(this.configPath, JSON.stringify(defaults, null, 2), 'utf-8');
    }
    this.initialized = true;
  }

  // ── Read helpers ──────────────────────────────────────────────

  private async readLeads(): Promise<Lead[]> {
    await this.init();
    const raw = await fs.readFile(this.leadsPath, 'utf-8');
    return JSON.parse(raw) as Lead[];
  }

  private async writeLeads(leads: Lead[]): Promise<void> {
    await fs.writeFile(this.leadsPath, JSON.stringify(leads, null, 2), 'utf-8');
  }

  private async readConfig(): Promise<ScoringConfig> {
    await this.init();
    const raw = await fs.readFile(this.configPath, 'utf-8');
    return JSON.parse(raw) as ScoringConfig;
  }

  private async writeConfig(config: ScoringConfig): Promise<void> {
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  // ── Lead CRUD ─────────────────────────────────────────────────

  async getAllLeads(): Promise<Lead[]> {
    return this.readLeads();
  }

  async getLeadById(id: string): Promise<Lead | null> {
    const leads = await this.readLeads();
    return leads.find((l) => l.id === id) ?? null;
  }

  async getLeadByEmail(email: string): Promise<Lead | null> {
    const leads = await this.readLeads();
    return leads.find((l) => l.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async addLead(lead: Lead): Promise<Lead> {
    return this.lock.run(async () => {
      const leads = await this.readLeads();
      leads.push(lead);
      await this.writeLeads(leads);
      return lead;
    });
  }

  async updateLead(id: string, updates: Partial<Lead>): Promise<Lead | null> {
    return this.lock.run(async () => {
      const leads = await this.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return null;
      leads[idx] = { ...leads[idx], ...updates, updated_at: new Date().toISOString() };
      await this.writeLeads(leads);
      return leads[idx];
    });
  }

  async deleteLead(id: string): Promise<boolean> {
    return this.lock.run(async () => {
      const leads = await this.readLeads();
      const filtered = leads.filter((l) => l.id !== id);
      if (filtered.length === leads.length) return false;
      await this.writeLeads(filtered);
      return true;
    });
  }

  // ── Search ────────────────────────────────────────────────────

  async searchLeads(filters: LeadSearchInput): Promise<{ leads: Lead[]; total: number }> {
    let leads = await this.readLeads();

    if (filters.query) {
      const q = filters.query.toLowerCase();
      leads = leads.filter(
        (l) =>
          l.email.toLowerCase().includes(q) ||
          (l.full_name?.toLowerCase().includes(q) ?? false) ||
          (l.first_name?.toLowerCase().includes(q) ?? false) ||
          (l.last_name?.toLowerCase().includes(q) ?? false) ||
          (l.company?.name?.toLowerCase().includes(q) ?? false) ||
          (l.job_title?.toLowerCase().includes(q) ?? false)
      );
    }

    if (filters.status) {
      leads = leads.filter((l) => l.status === filters.status);
    }

    if (filters.min_score != null) {
      leads = leads.filter((l) => l.score != null && l.score >= filters.min_score!);
    }

    if (filters.max_score != null) {
      leads = leads.filter((l) => l.score != null && l.score <= filters.max_score!);
    }

    if (filters.source) {
      leads = leads.filter((l) => l.source === filters.source);
    }

    if (filters.tags && filters.tags.length > 0) {
      leads = leads.filter((l) =>
        filters.tags!.every((tag) => l.tags.includes(tag))
      );
    }

    // Sort by created_at descending (newest first)
    leads.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = leads.length;
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 20;
    const paged = leads.slice(offset, offset + limit);

    return { leads: paged, total };
  }

  // ── Config ────────────────────────────────────────────────────

  async getScoringConfig(): Promise<ScoringConfig> {
    return this.readConfig();
  }

  async updateScoringConfig(updates: Partial<ScoringConfig>): Promise<ScoringConfig> {
    return this.lock.run(async () => {
      const current = await this.readConfig();
      const merged = { ...current, ...updates };
      await this.writeConfig(merged);
      return merged;
    });
  }

  // ── Stats ─────────────────────────────────────────────────────

  async getStats(): Promise<PipelineStats> {
    const leads = await this.readLeads();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const byStatus: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let scoreSum = 0;
    let scoreCount = 0;
    let qualifiedCount = 0;

    const buckets = [
      { range: '0-10', count: 0 },
      { range: '11-20', count: 0 },
      { range: '21-30', count: 0 },
      { range: '31-40', count: 0 },
      { range: '41-50', count: 0 },
      { range: '51-60', count: 0 },
      { range: '61-70', count: 0 },
      { range: '71-80', count: 0 },
      { range: '81-90', count: 0 },
      { range: '91-100', count: 0 },
    ];

    let leadsToday = 0;
    let leadsWeek = 0;
    let leadsMonth = 0;

    for (const lead of leads) {
      byStatus[lead.status] = (byStatus[lead.status] ?? 0) + 1;
      bySource[lead.source] = (bySource[lead.source] ?? 0) + 1;

      if (lead.score != null) {
        scoreSum += lead.score;
        scoreCount++;
        const bucketIdx = Math.min(Math.floor(lead.score / 10), 9);
        buckets[bucketIdx].count++;
      }

      if (lead.status === 'qualified') qualifiedCount++;

      const created = new Date(lead.created_at);
      if (created >= todayStart) leadsToday++;
      if (created >= weekStart) leadsWeek++;
      if (created >= monthStart) leadsMonth++;
    }

    return {
      total_leads: leads.length,
      by_status: byStatus,
      by_source: bySource,
      avg_score: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : null,
      score_distribution: buckets,
      leads_today: leadsToday,
      leads_this_week: leadsWeek,
      leads_this_month: leadsMonth,
      qualified_rate:
        leads.length > 0 ? Math.round((qualifiedCount / leads.length) * 1000) / 10 : 0,
    };
  }
}

/** Default global storage instance using process.cwd()/data directory. */
export const storage = new Storage();
