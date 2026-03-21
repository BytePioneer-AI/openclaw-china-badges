import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = [
  "@openclaw-china/channels",
  "@openclaw-china/dingtalk",
  "@openclaw-china/feishu-china",
  "@openclaw-china/qqbot",
  "@openclaw-china/shared",
  "@openclaw-china/wechat-mp",
  "@openclaw-china/wecom",
  "@openclaw-china/wecom-app",
  "@openclaw-china/wecom-kf",
];

const BADGE_DIR = ".github/badges";
const REQUEST_TIMEOUT_MS = 15_000;
const SOURCE_REPOSITORY = "https://github.com/BytePioneer-AI/openclaw-china";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const SOURCES = [
  {
    id: "npm",
    fileBase: "npm-downloads-18m",
    badgeLabel: "npm 18m",
    badgeColor: "#cb3837",
    registry: "npm public registry",
    buildContext() {
      const endDate = formatDateUTC(new Date());
      const startDate = formatDateUTC(monthsAgoUtc(new Date(), 18));
      return { endDate, startDate, months: 18 };
    },
    async fetchPackageStats(name, context) {
      const url = new URL(
        `https://api.npmjs.org/downloads/point/${context.startDate}:${context.endDate}/${encodeURIComponent(name)}`,
      );

      try {
        const body = await fetchJson(url);

        return {
          name,
          downloads: typeof body.downloads === "number" ? body.downloads : 0,
          status: "ok",
          period: {
            start: body.start ?? context.startDate,
            end: body.end ?? context.endDate,
          },
        };
      } catch (error) {
        return {
          name,
          downloads: 0,
          status: isHttpError(error) ? "unavailable" : "error",
          error: formatError(error),
        };
      }
    },
    buildSummary({ context, packages, totalDownloads }) {
      return {
        sourceRepository: SOURCE_REPOSITORY,
        scope: "openclaw-china",
        registry: this.registry,
        period: {
          label: "npm public API longest window",
          start: context.startDate,
          end: context.endDate,
          months: context.months,
        },
        totalDownloads,
        packages,
        unavailablePackages: packages
          .filter((pkg) => pkg.status !== "ok")
          .map(({ name, status, error }) => ({ name, status, error })),
      };
    },
  },
  {
    id: "npmmirror",
    fileBase: "npmmirror-downloads-total",
    badgeLabel: "npmmirror total",
    badgeColor: "#1f6feb",
    registry: "npmmirror",
    buildContext() {
      return { endDate: formatDateUTC(new Date()) };
    },
    async fetchPackageStats(name, context) {
      const metadataUrl = new URL(
        `https://registry.npmmirror.com/${encodeURIComponent(name)}`,
      );

      try {
        const metadata = await fetchJson(metadataUrl);
        const createdAt = metadata?.time?.created;

        if (typeof createdAt !== "string") {
          return {
            name,
            downloads: 0,
            status: "unavailable",
            error: "Missing package creation time in npmmirror metadata",
          };
        }

        const ranges = splitDateRangeByYear(createdAt.slice(0, 10), context.endDate);
        let downloads = 0;
        const yearlyRanges = [];

        for (const range of ranges) {
          const rangeUrl = new URL(
            `https://registry.npmmirror.com/downloads/range/${range.start}:${range.end}/${encodeURIComponent(name)}`,
          );
          const body = await fetchJson(rangeUrl);
          const rangeDownloads = Array.isArray(body.downloads)
            ? body.downloads.reduce(
                (sum, day) => sum + (typeof day.downloads === "number" ? day.downloads : 0),
                0,
              )
            : 0;

          downloads += rangeDownloads;
          yearlyRanges.push({
            start: range.start,
            end: range.end,
            downloads: rangeDownloads,
          });
        }

        return {
          name,
          downloads,
          status: "ok",
          createdAt,
          period: {
            start: ranges[0]?.start ?? createdAt.slice(0, 10),
            end: context.endDate,
          },
          yearlyRanges,
        };
      } catch (error) {
        return {
          name,
          downloads: 0,
          status: isHttpError(error) ? "unavailable" : "error",
          error: formatError(error),
        };
      }
    },
    buildSummary({ context, packages, totalDownloads }) {
      return {
        sourceRepository: SOURCE_REPOSITORY,
        scope: "openclaw-china",
        registry: this.registry,
        period: {
          label: "npmmirror historical total aggregated by yearly range API",
          end: context.endDate,
          rangeMode: "package created date -> current date, split by calendar year",
        },
        totalDownloads,
        packages,
        unavailablePackages: packages
          .filter((pkg) => pkg.status !== "ok")
          .map(({ name, status, error }) => ({ name, status, error })),
      };
    },
  },
];

async function main() {
  for (const source of SOURCES) {
    await updateSourceBadge(source);
  }
}

async function updateSourceBadge(source) {
  const context = source.buildContext();
  const packages = await Promise.all(
    PACKAGES.map((name) => source.fetchPackageStats(name, context)),
  );

  const totalDownloads = packages.reduce(
    (sum, pkg) => sum + (typeof pkg.downloads === "number" ? pkg.downloads : 0),
    0,
  );

  const summary = source.buildSummary({ context, packages, totalDownloads });
  const badge = {
    schemaVersion: 1,
    label: source.badgeLabel,
    message: formatNumber(totalDownloads),
    color: source.badgeColor,
  };

  const badgeDir = path.join(repoRoot, BADGE_DIR);
  await mkdir(badgeDir, { recursive: true });
  await writeJson(path.join(badgeDir, `${source.fileBase}.json`), badge);
  await writeFile(
    path.join(badgeDir, `${source.fileBase}.svg`),
    renderBadgeSvg(badge),
    "utf8",
  );
  await writeJson(path.join(badgeDir, `${source.fileBase}-summary.json`), summary);

  console.log(
    `[${source.id}] Updated badge: ${formatNumber(totalDownloads)} across ${packages.length} packages.`,
  );

  if (summary.unavailablePackages.length > 0) {
    console.warn(`[${source.id}] Packages without download data:`, summary.unavailablePackages);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "user-agent": "openclaw-china-badges/1.0",
      accept: "application/json",
    },
  });

  const body = await response.json();

  if (!response.ok) {
    throw new HttpError(
      response.status,
      typeof body?.error === "string" ? body.error : `HTTP ${response.status}`,
    );
  }

  return body;
}

function splitDateRangeByYear(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const ranges = [];
  let year = start.getUTCFullYear();

  while (year <= end.getUTCFullYear()) {
    const rangeStart =
      year === start.getUTCFullYear() ? startDate : `${year}-01-01`;
    const rangeEnd =
      year === end.getUTCFullYear() ? endDate : `${year}-12-31`;

    ranges.push({ start: rangeStart, end: rangeEnd });
    year += 1;
  }

  return ranges;
}

function monthsAgoUtc(date, months) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function renderBadgeSvg({ label, message, color }) {
  const leftWidth = computeBadgeWidth(label);
  const rightWidth = computeBadgeWidth(message);
  const totalWidth = leftWidth + rightWidth;
  const leftCenter = Math.round(leftWidth / 2);
  const rightCenter = leftWidth + Math.round(rightWidth / 2);
  const title = `${label}: ${message}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    '<linearGradient id="s" x2="0" y2="100%">',
    '<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>',
    '<stop offset="1" stop-opacity=".1"/>',
    "</linearGradient>",
    '<mask id="m">',
    `<rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>`,
    "</mask>",
    '<g mask="url(#m)">',
    `<rect width="${leftWidth}" height="20" fill="#555"/>`,
    `<rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${escapeXml(color)}"/>`,
    `<rect width="${totalWidth}" height="20" fill="url(#s)"/>`,
    "</g>",
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
    `<text x="${leftCenter}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>`,
    `<text x="${leftCenter}" y="14">${escapeXml(label)}</text>`,
    `<text x="${rightCenter}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>`,
    `<text x="${rightCenter}" y="14">${escapeXml(message)}</text>`,
    "</g>",
    "</svg>",
    "",
  ].join("");
}

function computeBadgeWidth(text) {
  const units = Array.from(text).reduce((sum, char) => sum + glyphWidth(char), 0);
  return Math.max(20, Math.round(units + 10));
}

function glyphWidth(char) {
  if ("ijlI1' ".includes(char)) {
    return 3.5;
  }

  if ("ftr()[]{}".includes(char)) {
    return 4.5;
  }

  if ("JKLsvxyz023456789".includes(char)) {
    return 6;
  }

  if ("ABCEFGHNPQRSTUVXYZabdghknopqu$#*+-<>=?_~".includes(char)) {
    return 7;
  }

  if ("mwMOW%&".includes(char)) {
    return 9;
  }

  return 6.5;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isHttpError(error) {
  return error instanceof HttpError;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

main().catch((error) => {
  console.error("Failed to update download badges.", error);
  process.exitCode = 1;
});
