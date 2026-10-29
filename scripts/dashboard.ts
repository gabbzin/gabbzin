/**
 * Gera os SVGs do dashboard do perfil (hoje e semanal).
 *
 *   GITHUB_TOKEN=... node scripts/dashboard.ts            -> dados reais
 *   node scripts/dashboard.ts --mock                      -> dados fake (preview)
 *
 * Saída: dist/dashboard-today.svg e dist/dashboard-week.svg
 */
import { mkdir, writeFile } from "node:fs/promises";

const USER = process.env.DASHBOARD_USER ?? "gabbzin";
const TZ = process.env.DASHBOARD_TZ ?? "America/Sao_Paulo";
const OUT_DIR = process.env.DASHBOARD_OUT ?? "dist";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const MOCK = process.argv.includes("--mock");

type Period = "today" | "week";

type Lang = { name: string; color: string; weight: number };

type Stats = {
  period: Period;
  from: Date;
  to: Date;
  commits: number;
  repos: number;
  prs: number;
  additions: number;
  deletions: number;
  languages: Lang[];
};

// ---------------------------------------------------------------------------
// Datas / fuso horário
// ---------------------------------------------------------------------------

/** Offset (ms) do fuso em relação ao UTC num dado instante. */
function tzOffset(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Meia-noite local (no fuso TZ) de `daysAgo` dias atrás. */
function localMidnight(now: Date, daysAgo: number): Date {
  const offset = tzOffset(now, TZ);
  const local = new Date(now.getTime() + offset);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo);
  return new Date(midnightLocal - offset);
}

function range(period: Period, now = new Date()): { from: Date; to: Date } {
  return { from: localMidnight(now, period === "today" ? 0 : 6), to: now };
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "gabbzin-dashboard" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors) throw new Error(`GraphQL: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  return json.data as T;
}

type RepoNode = {
  nameWithOwner: string;
  languages: { totalSize: number; edges: { size: number; node: { name: string; color: string | null } }[] };
};
type ByRepo = { repository: RepoNode; contributions: { totalCount: number } }[];

const CONTRIBUTIONS_QUERY = /* GraphQL */ `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      id
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        restrictedContributionsCount
        commitContributionsByRepository(maxRepositories: 100) { ...Repo }
        pullRequestContributionsByRepository(maxRepositories: 100) { ...Repo }
        issueContributionsByRepository(maxRepositories: 100) { ...Repo }
        pullRequestReviewContributionsByRepository(maxRepositories: 100) { ...Repo }
      }
    }
  }
  fragment Repo on ContributionsCollectionRepositoryContribution {
    contributions { totalCount }
    repository {
      nameWithOwner
      languages(first: 6, orderBy: { field: SIZE, direction: DESC }) {
        totalSize
        edges { size node { name color } }
      }
    }
  }
`;

const HISTORY_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $author: ID!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 100, after: $cursor, since: $since, until: $until, author: { id: $author }) {
              pageInfo { hasNextPage endCursor }
              nodes { additions deletions }
            }
          }
        }
      }
    }
  }
`;

type HistoryResult = {
  repository: {
    defaultBranchRef: {
      target: {
        history?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { additions: number; deletions: number }[];
        };
      };
    } | null;
  } | null;
};

async function lineChanges(repo: string, authorId: string, from: Date, to: Date) {
  const [owner, name] = repo.split("/");
  let additions = 0;
  let deletions = 0;
  let cursor: string | null = null;
  do {
    const data: HistoryResult = await gql<HistoryResult>(HISTORY_QUERY, {
      owner,
      name,
      author: authorId,
      since: from.toISOString(),
      until: to.toISOString(),
      cursor,
    });
    const history = data.repository?.defaultBranchRef?.target.history;
    if (!history) break;
    for (const c of history.nodes) {
      additions += c.additions;
      deletions += c.deletions;
    }
    cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (cursor);
  return { additions, deletions };
}

async function fetchStats(period: Period): Promise<Stats> {
  const { from, to } = range(period);
  const { user } = await gql<{
    user: {
      id: string;
      contributionsCollection: {
        totalCommitContributions: number;
        totalPullRequestContributions: number;
        restrictedContributionsCount: number;
        commitContributionsByRepository: ByRepo;
        pullRequestContributionsByRepository: ByRepo;
        issueContributionsByRepository: ByRepo;
        pullRequestReviewContributionsByRepository: ByRepo;
      };
    };
  }>(CONTRIBUTIONS_QUERY, { login: USER, from: from.toISOString(), to: to.toISOString() });

  const cc = user.contributionsCollection;
  const repos = new Set(
    [
      ...cc.commitContributionsByRepository,
      ...cc.pullRequestContributionsByRepository,
      ...cc.issueContributionsByRepository,
      ...cc.pullRequestReviewContributionsByRepository,
    ].map((r) => r.repository.nameWithOwner),
  );

  let additions = 0;
  let deletions = 0;
  const langs = new Map<string, Lang>();

  for (const { repository, contributions } of cc.commitContributionsByRepository) {
    const lines = await lineChanges(repository.nameWithOwner, user.id, from, to).catch((err) => {
      console.warn(`[warn] ${repository.nameWithOwner}: ${err.message}`);
      return { additions: 0, deletions: 0 };
    });
    additions += lines.additions;
    deletions += lines.deletions;

    // Peso do repo = linhas alteradas (ou nº de commits, se não deu pra medir),
    // distribuído entre as linguagens do repo proporcionalmente ao tamanho.
    const repoWeight = lines.additions + lines.deletions || contributions.totalCount;
    const { totalSize, edges } = repository.languages;
    for (const { size, node } of edges) {
      const prev = langs.get(node.name) ?? { name: node.name, color: node.color ?? "#7070e3", weight: 0 };
      prev.weight += totalSize ? (repoWeight * size) / totalSize : 0;
      langs.set(node.name, prev);
    }
  }

  return {
    period,
    from,
    to,
    commits: cc.totalCommitContributions,
    repos: repos.size,
    prs: cc.totalPullRequestContributions,
    additions,
    deletions,
    languages: normalize([...langs.values()]),
  };
}

function normalize(langs: Lang[]): Lang[] {
  const total = langs.reduce((s, l) => s + l.weight, 0);
  if (!total) return [];
  return langs
    .map((l) => ({ ...l, weight: l.weight / total }))
    .filter((l) => l.weight >= 0.01)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6);
}

function mockStats(period: Period): Stats {
  const { from, to } = range(period);
  const k = period === "today" ? 1 : 6;
  return {
    period,
    from,
    to,
    commits: 4 * k + 1,
    repos: period === "today" ? 2 : 5,
    prs: period === "today" ? 1 : 4,
    additions: 312 * k,
    deletions: 87 * k,
    languages: normalize([
      { name: "TypeScript", color: "#3178c6", weight: 62 },
      { name: "CSS", color: "#663399", weight: 14 },
      { name: "JavaScript", color: "#f1e05a", weight: 9 },
      { name: "Python", color: "#3572A5", weight: 8 },
      { name: "Dockerfile", color: "#384d54", weight: 4 },
      { name: "HTML", color: "#e34c26", weight: 3 },
    ]),
  };
}

// ---------------------------------------------------------------------------
// ASCII art
// ---------------------------------------------------------------------------

// Fonte em blocos 5x5. '#' vira '█' na renderização.
const FONT: Record<string, string[]> = {
  A: [" ### ", "#   #", "#####", "#   #", "#   #"],
  B: ["#### ", "#   #", "#### ", "#   #", "#### "],
  C: [" ####", "#    ", "#    ", "#    ", " ####"],
  D: ["#### ", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#### ", "#    ", "#####"],
  F: ["#####", "#    ", "#### ", "#    ", "#    "],
  G: [" ####", "#    ", "#  ##", "#   #", " ####"],
  H: ["#   #", "#   #", "#####", "#   #", "#   #"],
  I: ["#####", "  #  ", "  #  ", "  #  ", "#####"],
  J: ["#####", "   # ", "   # ", "#  # ", " ##  "],
  K: ["#   #", "#  # ", "###  ", "#  # ", "#   #"],
  L: ["#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", " ### "],
  P: ["#### ", "#   #", "#### ", "#    ", "#    "],
  Q: [" ### ", "#   #", "# # #", "#  # ", " ## #"],
  R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
  S: [" ####", "#    ", " ### ", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", " ### "],
  V: ["#   #", "#   #", "#   #", " # # ", "  #  "],
  W: ["#   #", "#   #", "# # #", "## ##", "#   #"],
  X: ["#   #", " # # ", "  #  ", " # # ", "#   #"],
  Y: ["#   #", " # # ", "  #  ", "  #  ", "  #  "],
  Z: ["#####", "   # ", "  #  ", " #   ", "#####"],
  "0": [" ### ", "#  ##", "# # #", "##  #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "  ## ", " #   ", "#####"],
  "3": ["#### ", "    #", " ### ", "    #", "#### "],
  "4": ["#   #", "#   #", "#####", "    #", "    #"],
  "5": ["#####", "#    ", "#### ", "    #", "#### "],
  "6": [" ### ", "#    ", "#### ", "#   #", " ### "],
  "7": ["#####", "   # ", "  #  ", " #   ", " #   "],
  "8": [" ### ", "#   #", " ### ", "#   #", " ### "],
  "9": [" ### ", "#   #", " ####", "    #", " ### "],
  "#": [" # # ", "#####", " # # ", "#####", " # # "],
  "+": ["     ", "  #  ", " ### ", "  #  ", "     "],
  "<": ["   # ", "  #  ", " #   ", "  #  ", "   # "],
  ">": [" #   ", "  #  ", "   # ", "  #  ", " #   "],
  "/": ["    #", "   # ", "  #  ", " #   ", "#    "],
  "?": [" ### ", "#   #", "  ## ", "     ", "  #  "],
};

const ABBR: Record<string, string> = {
  TypeScript: "TS",
  JavaScript: "JS",
  Python: "PY",
  Java: "JAVA",
  C: "C",
  "C++": "C++",
  "C#": "C#",
  Go: "GO",
  Rust: "RS",
  Ruby: "RB",
  PHP: "PHP",
  HTML: "HTML",
  CSS: "CSS",
  SCSS: "SCSS",
  Shell: "SH",
  Kotlin: "KT",
  Swift: "SWFT",
  Dart: "DART",
  Vue: "VUE",
  Svelte: "SV",
  Dockerfile: "DOCK",
  Lua: "LUA",
  PLpgSQL: "SQL",
  "Jupyter Notebook": "IPYN",
  Elixir: "EX",
  Haskell: "HS",
  Prisma: "PRSM",
  MDX: "MDX",
};

function abbr(name: string): string {
  if (ABBR[name]) return ABBR[name];
  const clean = name.toUpperCase().replace(/[^A-Z0-9#+]/g, "");
  return clean.slice(0, 3) || "?";
}

/** Logo no estilo "quadrado com letras" (tipo o logo do TS/JS), em ASCII. */
function asciiLogo(text: string): string[] {
  const glyphs = [...text].map((ch) => FONT[ch] ?? FONT["?"]);
  const rows = Array.from({ length: 5 }, (_, r) => glyphs.map((g) => g[r]).join(" "));
  const inner = rows[0].length + 4;
  const pad = " ".repeat(inner);
  const body = [pad, ...rows.map((r) => `  ${r}  `), pad];
  return [`╔${"═".repeat(inner)}╗`, ...body.map((l) => `║${l.replaceAll("#", "█")}║`), `╚${"═".repeat(inner)}╝`];
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const W = 840;
const H = 330;
const C = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  accent: "#7070e3",
  yellow: "#f9c701",
  text: "#e6edf3",
  muted: "#8b949e",
  green: "#3fb950",
  red: "#f85149",
};
const MONO = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number) => new Intl.NumberFormat("pt-BR").format(Math.round(n));
const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "short" }).format(d).replace(".", "");
const fmtTime = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);

function card(x: number, y: number, w: number, label: string, value: string, delay: number): string {
  return `
  <g class="card" style="animation-delay:${delay}s">
    <rect x="${x}" y="${y}" width="${w}" height="78" rx="10" fill="${C.panel}" stroke="${C.border}"/>
    <text x="${x + 16}" y="${y + 26}" class="label">${esc(label)}</text>
    <text x="${x + 16}" y="${y + 60}" class="value">${value}</text>
  </g>`;
}

function languagePanel(langs: Lang[], x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2;
  const frame = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.panel}" stroke="${C.border}"/>
    <text x="${x + 16}" y="${y + 26}" class="label">linguagens</text>`;

  if (!langs.length) {
    const logo = asciiLogo("</>");
    return `${frame}
    <g class="idle">${logoText(logo, cx, y + 60, C.muted)}</g>
    <text x="${cx}" y="${y + h - 24}" text-anchor="middle" class="lang-name" fill="${C.muted}">nada por aqui ainda<tspan class="cursor">▌</tspan></text>`;
  }

  // Cada linguagem aparece por SLOT segundos, piscando ao entrar e sair.
  const SLOT = 3;
  const n = langs.length;
  const total = SLOT * n;
  const w100 = 100 / n;
  const at = (f: number) => (f * w100).toFixed(3);
  const keyframes =
    n === 1
      ? `@keyframes blink { 0%,100% { opacity: 1 } 46% { opacity: 1 } 48% { opacity: .15 } 50% { opacity: 1 } 52% { opacity: .15 } 54% { opacity: 1 } }`
      : `@keyframes blink {
      0% { opacity: 0 } ${at(0.03)}% { opacity: 1 } ${at(0.06)}% { opacity: .1 } ${at(0.09)}% { opacity: 1 }
      ${at(0.12)}% { opacity: .2 } ${at(0.15)}% { opacity: 1 } ${at(0.55)}% { opacity: 1 } ${at(0.58)}% { opacity: .55 }
      ${at(0.61)}% { opacity: 1 } ${at(0.88)}% { opacity: 1 } ${at(0.91)}% { opacity: .1 } ${at(0.94)}% { opacity: 1 }
      ${at(0.97)}% { opacity: 0 } 100% { opacity: 0 } }`;

  const logos = langs
    .map((lang, i) => {
      const logo = asciiLogo(abbr(lang.name));
      return `<g class="logo" style="animation-delay:${i * SLOT}s">
      ${logoText(logo, cx, y + 58, lang.color)}
      <text x="${cx}" y="${y + h - 40}" text-anchor="middle" class="lang-name">${esc(lang.name)}<tspan class="cursor">▌</tspan></text>
      <text x="${cx}" y="${y + h - 20}" text-anchor="middle" class="lang-pct" fill="${lang.color}">${(lang.weight * 100).toFixed(1)}%</text>
    </g>`;
    })
    .join("");

  return `<style>
    ${keyframes}
    .logo { opacity: ${n === 1 ? 1 : 0}; animation: blink ${total}s linear infinite; }
  </style>
  ${frame}
  ${logos}`;
}

function logoText(lines: string[], cx: number, top: number, color: string): string {
  const LH = 13;
  return lines
    .map(
      (l, i) =>
        `<text x="${cx}" y="${top + i * LH}" text-anchor="middle" class="ascii" fill="${color}" xml:space="preserve">${esc(l)}</text>`,
    )
    .join("\n      ");
}

function languageBar(langs: Lang[], x: number, y: number, w: number): string {
  if (!langs.length) return "";
  let cursor = x;
  const segs = langs
    .map((l) => {
      const sw = l.weight * w;
      const s = `<rect x="${cursor.toFixed(2)}" y="${y}" width="${sw.toFixed(2)}" height="8" fill="${l.color}"/>`;
      cursor += sw;
      return s;
    })
    .join("");
  let lx = x;
  const legend = langs
    .slice(0, 5)
    .map((l) => {
      const label = `${l.name} ${(l.weight * 100).toFixed(0)}%`;
      const s = `<circle cx="${lx + 5}" cy="${y + 26}" r="4" fill="${l.color}"/><text x="${lx + 14}" y="${y + 30}" class="legend">${esc(label)}</text>`;
      lx += 22 + label.length * 6.4;
      return s;
    })
    .join("");
  return `<clipPath id="bar"><rect x="${x}" y="${y}" width="${w}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#bar)" class="bar">${segs}</g>
  ${legend}`;
}

function render(s: Stats): string {
  const isToday = s.period === "today";
  const title = isToday ? "hoje" : "últimos 7 dias";
  const flag = isToday ? "--hoje" : "--semana";
  const when = isToday ? fmtDate(s.to) : `${fmtDate(s.from)} → ${fmtDate(s.to)}`;

  const PAD = 24;
  const GAP = 14;
  const leftW = 520;
  const cardW = (leftW - GAP) / 2;
  const top = 72;

  const lines = `<tspan fill="${C.green}">+${fmt(s.additions)}</tspan><tspan fill="${C.muted}" dx="8" font-size="20">/</tspan><tspan fill="${C.red}" dx="8">−${fmt(s.deletions)}</tspan>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Dashboard GitHub de ${USER} (${title})">
  <title>Dashboard GitHub · ${title}</title>
  <style>
    text { font-family: ${SANS}; }
    .prompt { font-family: ${MONO}; font-size: 15px; fill: ${C.text}; }
    .meta { font-family: ${MONO}; font-size: 12px; fill: ${C.muted}; }
    .label { font-family: ${MONO}; font-size: 12px; fill: ${C.muted}; letter-spacing: .5px; text-transform: uppercase; }
    .value { font-size: 30px; font-weight: 700; fill: ${C.text}; }
    .ascii { font-family: ${MONO}; font-size: 13px; line-height: 1; font-weight: 700; }
    .lang-name { font-family: ${MONO}; font-size: 15px; font-weight: 700; fill: ${C.text}; }
    .lang-pct { font-family: ${MONO}; font-size: 13px; }
    .legend { font-family: ${MONO}; font-size: 11px; fill: ${C.muted}; }
    .cursor { fill: ${C.yellow}; animation: cursor 1s steps(1) infinite; }
    .card { opacity: 0; animation: fadein .6s ease-out forwards; }
    .bar { animation: grow 1.2s ease-out both; transform-origin: ${PAD}px 0; }
    .idle { animation: pulse 2.4s ease-in-out infinite; }
    @keyframes cursor { 50% { opacity: 0 } }
    @keyframes fadein { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
    @keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
    @keyframes pulse { 50% { opacity: .35 } }
  </style>

  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="14" fill="${C.bg}" stroke="${C.border}"/>
  <circle cx="${PAD + 4}" cy="30" r="5" fill="#ff5f56"/><circle cx="${PAD + 20}" cy="30" r="5" fill="#ffbd2e"/><circle cx="${PAD + 36}" cy="30" r="5" fill="#27c93f"/>
  <text x="${PAD + 56}" y="35" class="prompt"><tspan fill="${C.accent}">${esc(USER)}@github</tspan><tspan fill="${C.muted}">:</tspan><tspan fill="${C.yellow}">~</tspan><tspan fill="${C.muted}">$ </tspan>dashboard ${flag}<tspan class="cursor">▌</tspan></text>
  <text x="${W - PAD}" y="35" text-anchor="end" class="meta">${esc(when)} · atualizado ${fmtTime(s.to)}</text>

  ${card(PAD, top, cardW, "commits", fmt(s.commits), 0)}
  ${card(PAD + cardW + GAP, top, cardW, "repos", fmt(s.repos), 0.1)}
  ${card(PAD, top + 78 + GAP, cardW, "PRs abertos", fmt(s.prs), 0.2)}
  ${card(PAD + cardW + GAP, top + 78 + GAP, cardW, "linhas +/−", lines, 0.3)}

  ${languageBar(s.languages, PAD, top + 2 * 78 + GAP + 22, leftW)}

  ${languagePanel(s.languages, PAD + leftW + 20, top, W - PAD * 2 - leftW - 20, H - top - PAD)}
</svg>
`;
}

// ---------------------------------------------------------------------------

async function main() {
  if (!MOCK && !TOKEN) throw new Error("Defina GITHUB_TOKEN (ou rode com --mock).");
  await mkdir(OUT_DIR, { recursive: true });
  for (const period of ["today", "week"] as const) {
    const stats = MOCK ? mockStats(period) : await fetchStats(period);
    await writeFile(`${OUT_DIR}/dashboard-${period}.svg`, render(stats));
    console.log(`${period}: ${JSON.stringify({ ...stats, languages: stats.languages.map((l) => l.name) })}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
