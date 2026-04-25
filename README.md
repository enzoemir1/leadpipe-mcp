# LeadPipe MCP

**AI-powered lead qualification engine for the Model Context Protocol**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-2A9D8F.svg)](https://modelcontextprotocol.io/)

LeadPipe ingests leads from any source, enriches them with company data, scores them 0-100 using configurable AI rules, and exports qualified leads to your CRM — all through the MCP protocol.

---

## Features

- **Lead ingestion** from webhooks, forms, APIs, or CSV — single or batch (up to 100)
- **Auto-enrichment** with company data: industry, size, country, tech stack (via Hunter.io or domain heuristics)
- **AI scoring engine** (0-100) with 6 weighted dimensions + custom rules
- **CRM export** to HubSpot, Pipedrive, CSV, or JSON
- **ICP pre-qualification** to filter leads on freemail/title/country/tech-stack *before* spending a single enrichment credit
- **Pipeline analytics** with real-time stats, score distribution, conversion rates
- **Configurable** scoring weights, high-value titles/industries, custom rules
- **10 MCP tools** + **3 MCP resources** covering the full lead lifecycle

---

## Quick Start

### Install from MCPize Marketplace

1. Search for **LeadPipe MCP** on [mcpize.com](https://mcpize.com)
2. Click **Install** and select your subscription tier
3. Tools and resources are automatically available in any MCP-compatible client (Cursor, VS Code, etc.)

### Build from Source

```bash
git clone https://github.com/enzoemir1/leadpipe-mcp.git
cd leadpipe-mcp
npm ci
npm run build
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "leadpipe": {
      "command": "node",
      "args": ["path/to/leadpipe-mcp/dist/index.js"]
    }
  }
}
```

---

## Tools

### lead_qualify

Filter leads against your Ideal Customer Profile **before** spending any enrichment credits. Uses only locally-available signals — email domain, job title, country, industry, company size, tech stack — so nothing is charged to Hunter.io, HubSpot, or Pipedrive.

```json
{
  "criteria": {
    "reject_freemail": true,
    "required_title_keywords": ["vp", "director", "head", "founder"],
    "target_countries": ["US", "CA", "GB"],
    "min_company_size": "11-50",
    "required_tech_stack": ["shopify"]
  },
  "auto_disqualify": true
}
```

Returns per-lead qualified/rejected decisions with reasons and an estimated credit savings figure.

> **Pairs well with platform detection tools.** If you chain a tool like [Detecto](https://github.com/) (`detect_platform`) *before* `lead_qualify`, the detected tech stack populates `company.tech_stack`, and `required_tech_stack` can drop wrong-platform leads before they ever reach enrichment or scoring.

### lead_ingest

Add a single lead to the pipeline.

```json
{
  "email": "jane@acme.com",
  "first_name": "Jane",
  "last_name": "Smith",
  "job_title": "VP of Engineering",
  "company_name": "Acme Corp",
  "company_domain": "acme.com",
  "source": "website_form",
  "tags": ["demo-request"]
}
```

### lead_batch_ingest

Add 1-100 leads at once. Duplicates are automatically skipped.

```json
{
  "leads": [
    { "email": "lead1@corp.com", "job_title": "CEO" },
    { "email": "lead2@startup.io", "job_title": "CTO" }
  ]
}
```

### lead_enrich

Enrich a lead with company data using the email domain.

```json
{ "lead_id": "uuid-of-lead" }
```

Returns: company name, industry, size, country, tech stack, LinkedIn URL.

### lead_score

Calculate a qualification score (0-100). Leads scoring 60+ are marked **qualified**.

```json
{ "lead_id": "uuid-of-lead" }
```

Returns score + detailed breakdown across all 6 dimensions.

### lead_search

Search and filter leads with pagination.

```json
{
  "query": "acme",
  "status": "qualified",
  "min_score": 60,
  "limit": 20,
  "offset": 0
}
```

### lead_export

Export leads to CRM or file format.

```json
{
  "target": "hubspot",
  "min_score": 60
}
```

Targets: `hubspot`, `pipedrive`, `csv`, `json`

> Google Sheets export is on the roadmap. Currently returns Sheets-ready formatted data.

### pipeline_stats

Get pipeline analytics. No input required.

Returns: total leads, status/source breakdown, average score, score distribution, qualified rate, leads today/week/month.

### config_scoring

View or update scoring configuration.

```json
{
  "job_title_weight": 0.30,
  "high_value_titles": ["ceo", "cto", "vp", "founder"],
  "custom_rules": [
    {
      "field": "company_industry",
      "operator": "equals",
      "value": "fintech",
      "points": 15,
      "description": "Bonus for fintech companies"
    }
  ]
}
```

---

## Resources

| Resource | Description |
|----------|-------------|
| `leads://recent` | The 50 most recently added leads |
| `leads://pipeline` | Pipeline summary with status counts, scores, conversion rates |
| `leads://config` | Current scoring engine configuration |

---

## Scoring Engine

Leads are scored 0-100 using a weighted average of 6 dimensions:

| Dimension | Default Weight | How It Works |
|-----------|---------------|--------------|
| Job Title | 25% | C-level/Founder: 100, VP/Director: 85, Manager: 65, Senior: 50, Junior: 15 |
| Company Size | 20% | Preferred sizes (11-50, 51-200, 201-500): 90, others scaled accordingly |
| Industry | 20% | High-value industries (SaaS, fintech, etc.): 90, others: 40 |
| Engagement | 15% | Phone provided, full name, tags, source type (landing page > CSV) |
| Recency | 10% | Today: 100, last week: 75, last month: 35, 3+ months: 5 |
| Custom Rules | 10% | User-defined rules with -50 to +50 points each |

**Formula:** `score = sum(dimension_score * weight)`

Leads with score >= 60 are **qualified**. Below 60 are **disqualified**.

---

## CRM Integration

### HubSpot

Set the `HUBSPOT_API_KEY` environment variable with your HubSpot private app access token.

```bash
export HUBSPOT_API_KEY="pat-xxx-xxx"
```

### Pipedrive

Set the `PIPEDRIVE_API_KEY` environment variable.

```bash
export PIPEDRIVE_API_KEY="xxx"
```

### CSV / JSON

No configuration needed. Export returns data directly.

---

## Enrichment

LeadPipe extracts the domain from the lead's email and looks up company data:

1. **Hunter.io** (if `HUNTER_API_KEY` is set) — returns organization, industry, country, tech stack
2. **Domain heuristics** — maps known domains to company data
3. **Freemail detection** — gmail.com, yahoo.com, etc. are flagged (no company enrichment)

---

## Pricing

| Tier | Price | Leads/month | Features |
|------|-------|-------------|----------|
| Free | $0 | 25 | Ingest, manual scoring, ICP pre-qualification |
| Pro | $19/mo | 300 | AI scoring, Hunter.io enrichment, CRM export |
| Business | $39/mo | 2,500 | Pipeline analytics, custom rules, priority support |
| Agency | $99/mo | 10,000 | Multi-client, white-label exports |

Available on the [MCPize Marketplace](https://mcpize.com).

---

## Development

```bash
npm run dev        # Hot reload development
npm run build      # Production build
npm test           # Run unit tests
npm run inspect    # Open MCP Inspector
```

---

## Pro License

LeadPipe ships in **Free mode** — `lead_demo_seed`, `lead_ingest`, `lead_batch_ingest`, `lead_search`, `lead_score`, and `config_scoring` are open. The following tools require a **Pro license**:

- `lead_qualify` — ICP pre-filter
- `lead_enrich` — domain knowledge-base enrichment
- `lead_export` — HubSpot / Pipedrive / Google Sheets / CSV / JSON
- `pipeline_stats` — portfolio analytics

**Buy a Pro License (€19, lifetime, 3 machines):** https://automatiabcn.lemonsqueezy.com/buy/360565a3-2577-45e2-93dd-1548a881f456

Or get the **[Indie MCP Stack Bundle](https://automatiabcn.lemonsqueezy.com/buy/55e932fd-8319-47f0-8e95-0b86a29f2617)** (€69, all 4 servers).

Then activate by setting the env var:

```bash
export LEMONSQUEEZY_LICENSE_KEY=YOUR-KEY-HERE
```

Or in your Claude Desktop / MCP client config:

```json
{
  "mcpServers": {
    "leadpipe-mcp": {
      "command": "npx",
      "args": ["-y", "leadpipe-mcp-server"],
      "env": { "LEMONSQUEEZY_LICENSE_KEY": "YOUR-KEY-HERE" }
    }
  }
}
```

Validation is cached locally for 24 h, so the server is fully offline-capable after the first run.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

Built by [Automatia BCN](https://github.com/enzoemir1).
