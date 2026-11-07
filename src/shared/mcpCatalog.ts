// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A73: bounded port of frozen MCPCatalog — the curated server registry
// the Settings "Browse catalog" picker offers, each entry carrying its
// fields, env/header templates with {key} placeholders and the docs/key
// pages. Resolution mirrors frozen MCPCatalogEntry+Resolve: {key} fills
// from the typed value or the field default; an optional field left
// empty drops its env var/header outright.
// Bounded: brand assets are the colour dot only (upstream image set not
// ported); OAuth transports are listed but unservable in this build —
// the picker disables them with the honest note.

import type { McpServerConfig } from "./mcp";

export type McpCategory =
  | "developer" | "browser" | "search" | "work" | "data" | "cloud" | "knowledge";

export interface McpCatalogField {
  key: string;
  label: string;
  placeholder: string;
  kind: "secret" | "text" | "path";
  help?: string;
  /** Prefilled when the user types nothing. "~" expands to the home dir. */
  defaultValue?: string;
  isRequired?: boolean; // default true
}

export type McpCatalogTransport =
  | { kind: "stdio"; command: string; args: string[] }
  | { kind: "http"; url: string; headers: Record<string, string> }
  | { kind: "oauth"; url: string };

export interface McpCatalogEntry {
  id: string;
  name: string;
  vendor: string;
  summary: string;
  category: McpCategory;
  /** 0xRRGGBB brand tint for the mark. */
  color: number;
  monochrome?: boolean;
  transport: McpCatalogTransport;
  fields?: McpCatalogField[];
  env?: Record<string, string>;
  docsURL: string;
  sampleTools: string[];
  keysURL?: string;
}

const E = (e: McpCatalogEntry): McpCatalogEntry => e;

export const MCP_CATALOG: McpCatalogEntry[] = [
  E({ id: "github", name: "GitHub", vendor: "GitHub",
      summary: "Issues, pull requests and code across your repositories",
      category: "developer", color: 0x24292f, monochrome: true,
      transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer {token}" } },
      fields: [{ key: "token", label: "Personal access token", placeholder: "ghp_…", kind: "secret", help: "Create a fine-grained token on the page, then copy it" }],
      docsURL: "https://github.com/github/github-mcp-server",
      sampleTools: ["list_issues", "create_pull_request", "search_code", "get_file_contents"],
      keysURL: "https://github.com/settings/personal-access-tokens/new" }),
  E({ id: "gitlab", name: "GitLab", vendor: "GitLab",
      summary: "Issues, merge requests, pipelines and code across your projects",
      category: "developer", color: 0xfc6d26,
      transport: { kind: "oauth", url: "https://{instance}/api/v4/mcp" },
      fields: [{ key: "instance", label: "GitLab address", placeholder: "gitlab.com", kind: "text", help: "gitlab.com, or your own instance's host", defaultValue: "gitlab.com", isRequired: false }],
      docsURL: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
      sampleTools: ["list_merge_requests", "get_merge_request_diffs", "create_issue", "get_pipeline_jobs"] }),
  E({ id: "playwright", name: "Playwright", vendor: "Microsoft",
      summary: "Drives a real browser: open pages, click, fill forms, screenshot",
      category: "browser", color: 0x2ead33,
      transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      docsURL: "https://github.com/microsoft/playwright-mcp",
      sampleTools: ["browser_navigate", "browser_click", "browser_snapshot", "browser_take_screenshot"] }),
  E({ id: "chrome-devtools", name: "Chrome DevTools", vendor: "Google",
      summary: "Inspects pages, console messages and performance traces",
      category: "browser", color: 0x4285f4,
      transport: { kind: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
      docsURL: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
      sampleTools: ["navigate_page", "take_screenshot", "list_console_messages", "performance_start_trace"] }),
  E({ id: "context7", name: "Context7", vendor: "Upstash",
      summary: "Fresh docs and examples for the libraries you use",
      category: "knowledge", color: 0x5b8def,
      transport: { kind: "http", url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer {key}" } },
      fields: [{ key: "key", label: "API key", placeholder: "ctx7sk-…", kind: "secret", help: "Optional. Raises the rate limit", isRequired: false }],
      docsURL: "https://github.com/upstash/context7",
      sampleTools: ["resolve-library-id", "query-docs"],
      keysURL: "https://context7.com/dashboard" }),
  E({ id: "filesystem", name: "Filesystem", vendor: "Anthropic",
      summary: "Reads, writes and searches files in one folder",
      category: "developer", color: 0x8e8e93,
      transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "{root}"] },
      fields: [{ key: "root", label: "Folder", placeholder: "/Users/you/Projects", kind: "path", help: "The folder the server may use", defaultValue: "~" }],
      docsURL: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
      sampleTools: ["read_text_file", "write_file", "list_directory", "search_files"] }),
  E({ id: "fetch", name: "Fetch", vendor: "Anthropic",
      summary: "Downloads web pages as plain text to read",
      category: "browser", color: 0x0a84ff,
      transport: { kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
      docsURL: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
      sampleTools: ["fetch"] }),
  E({ id: "memory", name: "Memory", vendor: "Anthropic",
      summary: "Remembers people, facts and how they connect",
      category: "knowledge", color: 0xaf52de,
      transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
      docsURL: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
      sampleTools: ["create_entities", "create_relations", "search_nodes", "read_graph"] }),
  E({ id: "sequential-thinking", name: "Sequential Thinking", vendor: "Anthropic",
      summary: "Thinks hard problems through step by step",
      category: "knowledge", color: 0x30b0c7,
      transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
      docsURL: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
      sampleTools: ["sequentialthinking"] }),
  E({ id: "git", name: "Git", vendor: "Anthropic",
      summary: "Status, diffs, history and commits for a repo",
      category: "developer", color: 0xf05032,
      transport: { kind: "stdio", command: "uvx", args: ["mcp-server-git"] },
      docsURL: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
      sampleTools: ["git_status", "git_diff", "git_log", "git_commit"] }),
  E({ id: "brave-search", name: "Brave Search", vendor: "Brave",
      summary: "Searches the web, local places and news",
      category: "search", color: 0xfb542b,
      transport: { kind: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"] },
      fields: [{ key: "key", label: "API key", placeholder: "BSA…", kind: "secret", help: "Make a key on the page, then copy it" }],
      env: { BRAVE_API_KEY: "{key}" },
      docsURL: "https://github.com/brave/brave-search-mcp-server",
      sampleTools: ["brave_web_search", "brave_local_search", "brave_news_search"],
      keysURL: "https://api-dashboard.search.brave.com/app/keys" }),
  E({ id: "tavily", name: "Tavily", vendor: "Tavily",
      summary: "Searches the web and pulls out page content",
      category: "search", color: 0x0d9488,
      transport: { kind: "oauth", url: "https://mcp.tavily.com/mcp" },
      docsURL: "https://github.com/tavily-ai/tavily-mcp",
      sampleTools: ["tavily-search", "tavily-extract", "tavily-crawl"] }),
  E({ id: "exa", name: "Exa", vendor: "Exa",
      summary: "Searches the web and reads pages, with code-focused answers",
      category: "search", color: 0x1f4fff,
      transport: { kind: "oauth", url: "https://mcp.exa.ai/mcp" },
      docsURL: "https://github.com/exa-labs/exa-mcp-server",
      sampleTools: ["web_search_exa", "web_fetch_exa", "agent_run"] }),
  E({ id: "firecrawl", name: "Firecrawl", vendor: "Firecrawl",
      summary: "Scrapes, searches and maps whole websites",
      category: "browser", color: 0xff6b1a,
      transport: { kind: "stdio", command: "npx", args: ["-y", "firecrawl-mcp"] },
      fields: [{ key: "key", label: "API key", placeholder: "fc-…", kind: "secret", help: "Make a key on the page, then copy it" }],
      env: { FIRECRAWL_API_KEY: "{key}" },
      docsURL: "https://github.com/firecrawl/firecrawl-mcp-server",
      sampleTools: ["firecrawl_scrape", "firecrawl_search", "firecrawl_crawl", "firecrawl_map"],
      keysURL: "https://www.firecrawl.dev/app/api-keys" }),
  E({ id: "perplexity", name: "Perplexity", vendor: "Perplexity",
      summary: "Asks the web and answers with sources",
      category: "search", color: 0x20808d,
      transport: { kind: "stdio", command: "npx", args: ["-y", "@perplexity-ai/mcp-server"] },
      fields: [{ key: "key", label: "API key", placeholder: "pplx-…", kind: "secret", help: "Make a key on the page, then copy it" }],
      env: { PERPLEXITY_API_KEY: "{key}" },
      docsURL: "https://github.com/perplexityai/modelcontextprotocol",
      sampleTools: ["perplexity_search", "perplexity_ask", "perplexity_research", "perplexity_reason"],
      keysURL: "https://www.perplexity.ai/settings/api" }),
  E({ id: "slack", name: "Slack", vendor: "Slack",
      summary: "Lists channels, reads and posts messages",
      category: "work", color: 0x4a154b,
      transport: { kind: "stdio", command: "npx", args: ["-y", "slack-mcp-server@latest", "--transport", "stdio"] },
      fields: [{ key: "token", label: "Bot token", placeholder: "xoxb-…", kind: "secret", help: "Copy the Bot User OAuth Token from your app, then invite the bot to the channels it should read" }],
      env: { SLACK_MCP_XOXB_TOKEN: "{token}", SLACK_MCP_ADD_MESSAGE_TOOL: "true" },
      docsURL: "https://github.com/korotovsky/slack-mcp-server",
      sampleTools: ["channels_list", "conversations_history", "conversations_search_messages", "conversations_add_message"],
      keysURL: "https://api.slack.com/apps" }),
  E({ id: "notion", name: "Notion", vendor: "Notion",
      summary: "Finds and edits pages in your workspace",
      category: "work", color: 0x000000, monochrome: true,
      transport: { kind: "oauth", url: "https://mcp.notion.com/mcp" },
      docsURL: "https://developers.notion.com/docs/mcp",
      sampleTools: ["API-post-search", "API-retrieve-a-page", "API-patch-block-children"] }),
  E({ id: "linear", name: "Linear", vendor: "Linear",
      summary: "Issues and projects in your Linear teams",
      category: "work", color: 0x5e6ad2,
      transport: { kind: "oauth", url: "https://mcp.linear.app/mcp" },
      docsURL: "https://linear.app/docs/mcp",
      sampleTools: ["list_issues", "create_issue", "update_issue", "list_projects"] }),
  E({ id: "atlassian", name: "Atlassian", vendor: "Atlassian",
      summary: "Jira issues and Confluence pages",
      category: "work", color: 0x0052cc,
      transport: { kind: "oauth", url: "https://mcp.atlassian.com/v2/mcp" },
      docsURL: "https://developer.atlassian.com/cloud/rovo-mcp/",
      sampleTools: ["searchJiraIssuesUsingJql", "createJiraIssue", "getConfluenceContent"] }),
  E({ id: "figma", name: "Figma", vendor: "Figma",
      summary: "Design details and screenshots from files",
      category: "work", color: 0xf24e1e,
      transport: { kind: "oauth", url: "https://mcp.figma.com/mcp" },
      docsURL: "https://help.figma.com/hc/en-us/articles/32132100833559",
      sampleTools: ["get_design_context", "get_screenshot", "get_metadata"] }),
  E({ id: "sentry", name: "Sentry", vendor: "Sentry",
      summary: "Error reports and which projects they hit",
      category: "developer", color: 0x7b61ff,
      transport: { kind: "oauth", url: "https://mcp.sentry.dev/mcp" },
      docsURL: "https://mcp.sentry.dev",
      sampleTools: ["search_issues", "get_issue_details", "find_projects"] }),
  E({ id: "vercel", name: "Vercel", vendor: "Vercel",
      summary: "Projects, deployments and their build logs",
      category: "cloud", color: 0x000000, monochrome: true,
      transport: { kind: "oauth", url: "https://mcp.vercel.com" },
      docsURL: "https://vercel.com/docs/agent-resources/vercel-mcp",
      sampleTools: ["list_projects", "list_deployments", "get_deployment_build_logs"] }),
  E({ id: "cloudflare", name: "Cloudflare", vendor: "Cloudflare",
      summary: "Workers, storage buckets and databases",
      category: "cloud", color: 0xf38020,
      transport: { kind: "oauth", url: "https://bindings.mcp.cloudflare.com/mcp" },
      docsURL: "https://github.com/cloudflare/mcp-server-cloudflare",
      sampleTools: ["workers_list", "kv_namespaces_list", "r2_buckets_list", "d1_databases_list"] }),
  E({ id: "netlify", name: "Netlify", vendor: "Netlify",
      summary: "Sites, deploys, forms and environment variables",
      category: "cloud", color: 0x00c7b7,
      transport: { kind: "oauth", url: "https://netlify-mcp.netlify.app/mcp" },
      docsURL: "https://docs.netlify.com/welcome/build-with-ai/netlify-mcp-server/",
      sampleTools: ["get-projects", "deploy-site", "manage-env-vars", "get-deploy"] }),
  E({ id: "supabase", name: "Supabase", vendor: "Supabase",
      summary: "Projects, SQL queries and database changes",
      category: "data", color: 0x3ecf8e,
      transport: { kind: "oauth", url: "https://mcp.supabase.com/mcp" },
      docsURL: "https://supabase.com/docs/guides/ai-tools/mcp",
      sampleTools: ["list_projects", "execute_sql", "apply_migration", "query_logs"] }),
  E({ id: "stripe", name: "Stripe", vendor: "Stripe",
      summary: "Customers, payment links and balances",
      category: "work", color: 0x635bff,
      transport: { kind: "oauth", url: "https://mcp.stripe.com" },
      docsURL: "https://docs.stripe.com/mcp",
      sampleTools: ["create_customer", "list_customers", "create_payment_link", "retrieve_balance"] }),
  E({ id: "resend", name: "Resend", vendor: "Resend",
      summary: "Sends email and manages contacts, broadcasts and domains",
      category: "work", color: 0x000000, monochrome: true,
      transport: { kind: "oauth", url: "https://mcp.resend.com/mcp" },
      docsURL: "https://github.com/resend/resend-mcp",
      sampleTools: ["send-email", "list-contacts", "create-broadcast", "list-domains"] }),
  E({ id: "postgres", name: "PostgreSQL", vendor: "PostgreSQL",
      summary: "Runs SQL and explores the schema of a Postgres database",
      category: "data", color: 0x4169e1,
      transport: { kind: "stdio", command: "npx", args: ["-y", "@bytebase/dbhub@latest", "--transport", "stdio", "--dsn", "{url}"] },
      fields: [{ key: "url", label: "Connection string", placeholder: "postgresql://user:pass@host:5432/db", kind: "secret", help: "The connection string; a read-only user is safest" }],
      docsURL: "https://github.com/bytebase/dbhub",
      sampleTools: ["execute_sql", "search_objects"] }),
  E({ id: "sqlite", name: "SQLite", vendor: "SQLite",
      summary: "Reads and writes a local database file",
      category: "data", color: 0x0f80cc,
      transport: { kind: "stdio", command: "uvx", args: ["mcp-server-sqlite", "--db-path", "{path}"] },
      fields: [{ key: "path", label: "Database file", placeholder: "/path/to/app.db", kind: "path", help: "Created if it does not exist" }],
      docsURL: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite",
      sampleTools: ["read_query", "write_query", "list_tables", "describe-table"] }),
  E({ id: "mongodb", name: "MongoDB", vendor: "MongoDB",
      summary: "Finds and changes documents in your collections",
      category: "data", color: 0x47a248,
      transport: { kind: "stdio", command: "npx", args: ["-y", "mongodb-mcp-server"] },
      fields: [{ key: "url", label: "Connection string", placeholder: "mongodb+srv://…", kind: "secret", help: "In Atlas: Connect → Drivers, then copy the string" }],
      env: { MDB_MCP_CONNECTION_STRING: "{url}" },
      docsURL: "https://github.com/mongodb-js/mongodb-mcp-server",
      sampleTools: ["find", "aggregate", "list-collections", "insert-many"],
      keysURL: "https://cloud.mongodb.com" }),
  E({ id: "huggingface", name: "Hugging Face", vendor: "Hugging Face",
      summary: "Searches models, datasets and papers",
      category: "knowledge", color: 0xffb000,
      transport: { kind: "http", url: "https://huggingface.co/mcp", headers: { Authorization: "Bearer {token}" } },
      fields: [{ key: "token", label: "Access token", placeholder: "hf_…", kind: "secret", help: "Optional. Raises the limits", isRequired: false }],
      docsURL: "https://github.com/huggingface/hf-mcp-server",
      sampleTools: ["hub_repo_search", "hub_repo_details", "hf_fs", "hf_whoami"],
      keysURL: "https://huggingface.co/settings/tokens" }),
  E({ id: "deepwiki", name: "DeepWiki", vendor: "Cognition",
      summary: "Reads docs and answers questions about repos",
      category: "knowledge", color: 0x1d1d1f, monochrome: true,
      transport: { kind: "http", url: "https://mcp.deepwiki.com/mcp", headers: {} },
      docsURL: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
      sampleTools: ["read_wiki_structure", "read_wiki_contents", "ask_question"] }),
  E({ id: "aws-docs", name: "AWS Docs", vendor: "Amazon Web Services",
      summary: "Searches and reads the AWS documentation",
      category: "cloud", color: 0xff9900,
      transport: { kind: "stdio", command: "uvx", args: ["awslabs.aws-documentation-mcp-server@latest"] },
      env: { FASTMCP_LOG_LEVEL: "ERROR" },
      docsURL: "https://awslabs.github.io/mcp/servers/aws-documentation-mcp-server",
      sampleTools: ["read_documentation", "search_documentation", "recommend"] }),
];

export const MCP_CATEGORY_ORDER: McpCategory[] = [
  "developer", "browser", "search", "work", "data", "cloud", "knowledge",
];

export function catalogByCategory(): { category: McpCategory; entries: McpCatalogEntry[] }[] {
  return MCP_CATEGORY_ORDER
    .map((category) => ({ category, entries: MCP_CATALOG.filter((e) => e.category === category) }))
    .filter((g) => g.entries.length > 0);
}

export function catalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/** Whether the server needs something typed before it can connect. */
export function catalogNeedsInput(e: McpCatalogEntry): boolean {
  return (e.fields ?? []).some((f) => f.isRequired !== false);
}

/** Frozen fill(): `{key}` placeholders take the typed value, else the
 *  field's default, else "". "~" expands to the given home directory. A
 *  placeholder standing as a URL's host (`://{key}`) takes a host: a
 *  pasted "https://gitlab.example.com/" loses scheme and slashes
 *  (frozen fill). */
function fillTemplate(
  text: string,
  fields: McpCatalogField[],
  values: Record<string, string>,
  home: string,
): string {
  return text.replace(/\{([A-Za-z0-9_-]+)\}/g, (token, key: string) => {
    const field = fields.find((f) => f.key === key);
    let v = (values[key] || field?.defaultValue || "");
    if (text.includes(`://${token}`)) {
      v = v.trim();
      for (const scheme of ["https://", "http://"]) {
        if (v.toLowerCase().startsWith(scheme)) v = v.slice(scheme.length);
      }
      while (v.endsWith("/")) v = v.slice(0, -1);
    }
    if (v === "~") v = home;
    else if (v.startsWith("~/")) v = home + v.slice(1);
    return v;
  });
}

/** Frozen MCPCatalogEntry.resolve: produces the launchable
 *  McpServerConfig. OAuth entries resolve to null — the proxy route is
 *  out of this slice and the picker never offers them. An optional
 *  field left empty drops its env var/header entirely. */
export function resolveCatalogEntry(
  e: McpCatalogEntry,
  values: Record<string, string>,
  home: string,
): McpServerConfig | null {
  const fields = e.fields ?? [];
  const fill = (s: string) => fillTemplate(s, fields, values, home);
  const dropEmpty = (rec: Record<string, string>): Record<string, string> | undefined => {
    const out = Object.fromEntries(
      Object.entries(rec).map(([k, v]) => [k, fill(v)]).filter(([, v]) => v !== ""),
    );
    return Object.keys(out).length ? out : undefined;
  };
  switch (e.transport.kind) {
    case "stdio":
      return {
        id: e.id,
        name: e.name,
        transport: "stdio",
        command: fill(e.transport.command),
        args: e.transport.args.map(fill),
        env: dropEmpty(e.env ?? {}),
      };
    case "http":
      return {
        id: e.id,
        name: e.name,
        transport: "http",
        command: "",
        args: [],
        url: fill(e.transport.url),
        headers: dropEmpty(e.transport.headers),
      };
    case "oauth":
      return null;
  }
}
