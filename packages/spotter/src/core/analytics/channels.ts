/**
 * Traffic channel classification from referrer, UTM parameters and click-id
 * names. Pure and dependency-free: Console runs the same function server-side.
 *
 * Precedence: paid → email → social → search → direct → referral.
 */

export type Channel = "search" | "social" | "email" | "direct" | "paid" | "referral";

export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

/** Ad-platform click ids: their presence means a paid click. (`fbclid` is added to organic Facebook links too, so it's social.) */
const PAID_CLICK_IDS = new Set(["gclid", "gbraid", "wbraid", "dclid", "msclkid", "ttclid", "twclid", "li_fat_id"]);
const SOCIAL_CLICK_IDS = new Set(["fbclid"]);

const PAID_MEDIUM = /^(cpc|ppc|cpm|cpv|cpa|paid|paid[-_ ]?(search|social|media)|display|banner|retargeting|remarketing|affiliate|ads?)$/;
const EMAIL = /(^|[^a-z])(e-?mail|newsletter)([^a-z]|$)/;
const SOCIAL_MEDIUM = /^(social|social[-_ ]?(network|media)|sm|organic[-_ ]?social)$/;

const SEARCH_HOSTS =
  /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.co\.jp|baidu\.com|yandex\.[a-z.]+|ya\.ru|ecosia\.org|search\.brave\.com|startpage\.com|qwant\.com|naver\.com|seznam\.cz|kagi\.com|sogou\.com|so\.com|perplexity\.ai)$/;
const SOCIAL_HOSTS =
  /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|reddit\.com|redd\.it|youtube\.com|youtu\.be|tiktok\.com|pinterest\.[a-z.]+|pin\.it|threads\.net|bsky\.app|mastodon\.social|tumblr\.com|snapchat\.com|vk\.com|weibo\.com|quora\.com|news\.ycombinator\.com|discord\.com|telegram\.org|t\.me|whatsapp\.com)$/;
const EMAIL_HOSTS = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|mail\.proton\.me|mail\.aol\.com|mail\.zoho\.com|fastmail\.com)$/;

function hostOf(referrer: string | null | undefined): string {
  if (!referrer) return "";
  try {
    return new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function channelFor(referrer: string | null | undefined, utm?: Utm | null, clickIds?: readonly string[] | null): Channel {
  const medium = (utm?.medium ?? "").toLowerCase().trim();
  const source = (utm?.source ?? "").toLowerCase().trim();
  const ids = (clickIds ?? []).map((c) => c.toLowerCase());
  const host = hostOf(referrer);

  if (PAID_MEDIUM.test(medium) || ids.some((c) => PAID_CLICK_IDS.has(c))) return "paid";
  if (EMAIL.test(medium) || EMAIL.test(source) || EMAIL_HOSTS.test(host)) return "email";
  if (SOCIAL_MEDIUM.test(medium) || ids.some((c) => SOCIAL_CLICK_IDS.has(c)) || SOCIAL_HOSTS.test(host) || SOCIAL_HOSTS.test(source)) return "social";
  if (medium === "organic" || SEARCH_HOSTS.test(host) || SEARCH_HOSTS.test(source)) return "search";
  if (!host && !medium && !source && !ids.length) return "direct";
  return "referral";
}
