'use strict';

const { URL } = require('url');

const DROP_TAGS = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];

function dropTag(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
  let out = html;
  let prev;
  do {
    prev = out;
    out = out.replace(re, ' ');
  } while (out !== prev);
  out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi'), ' ');
  return out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
}

function decodeCodePoint(raw, radix) {
  const value = Number.parseInt(raw, radix);
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return '\uFFFD';
  }
  return String.fromCodePoint(value);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => decodeCodePoint(h, 16))
    .replace(/&#(\d+);/g, (_, d) => decodeCodePoint(d, 10))
    .replace(/&amp;/gi, '&');
}

function absolutize(href, baseUrl) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^javascript:/i.test(h) || /^data:/i.test(h) || h.startsWith('#')) return '';
  if (!baseUrl) return h;
  try {
    return new URL(h, baseUrl).href;
  } catch {
    return h;
  }
}

function pickBody(html) {
  for (const tag of ['main', 'article']) {
    const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i'));
    if (m && m[1].trim()) return m[1];
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  if (body && body[1].trim()) return body[1];
  return html;
}

function normalizeMarkdownWhitespace(raw) {
  const lines = [];
  let inCodeFence = false;
  let blankRun = 0;
  for (const rawLine of String(raw).replace(/\r\n?/g, '\n').split('\n')) {
    if (rawLine.trim() === '```') {
      lines.push('```');
      inCodeFence = !inCodeFence;
      blankRun = 0;
      continue;
    }
    const line = inCodeFence
      ? rawLine.replace(/\u00a0/g, ' ')
      : rawLine.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!inCodeFence && !line) {
      if (blankRun === 0) lines.push('');
      blankRun += 1;
      continue;
    }
    blankRun = 0;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/**
 * HTML to lightweight Markdown using bounded string transformations.
 * @param {string} rawHtml
 * @param {{ baseUrl?: string, maxChars?: number }} [opts]
 * @returns {{ title: string, text: string, truncated: boolean }}
 */
function extractFromHtml(rawHtml, opts = {}) {
  const maxChars = Number.isFinite(Number(opts.maxChars)) ? Number(opts.maxChars) : Infinity;
  const baseUrl = opts.baseUrl || '';
  let html = String(rawHtml || '');
  if (!html.trim()) return { title: '', text: '', truncated: false };

  html = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP_TAGS) html = dropTag(html, tag);

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  let s = pickBody(html);

  const codeBlocks = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner) => {
    const code = decodeEntities(inner.replace(/<\/?code\b[^>]*>/gi, '').replace(/<[^>]+>/g, ''));
    codeBlocks.push(code.replace(/^\n+|\n+$/g, ''));
    return `\n\u0000CODE${codeBlocks.length - 1}\u0000\n`;
  });
  s = s.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi,
    (_, inner) => `\`${decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()}\``,
  );

  s = s.replace(
    /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_, _q, d, sq, bare, inner) => {
      const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      const href = absolutize(d ?? sq ?? bare ?? '', baseUrl);
      if (!text) return ' ';
      return href ? `[${text}](${href})` : text;
    },
  );

  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_, level, inner) => `\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}\n`,
  );

  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol\s*>/gi, (_, inner) => {
    let index = 0;
    return `\n${inner.replace(/<li\b[^>]*>([\s\S]*?)(?=<li\b|<\/ol|$)/gi, (__, item) => {
      index += 1;
      return `\n${index}. ${item.replace(/<\/li\s*>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`;
    })}\n`;
  });
  s = s.replace(
    /<li\b[^>]*>([\s\S]*?)(?=<li\b|<\/ul|<\/ol|$)/gi,
    (_, item) => `\n- ${item.replace(/<\/li\s*>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`,
  );

  s = s.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi,
    (_, inner) => `\n> ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n`,
  );

  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|tr|table|h[1-6]|ul|ol|li|blockquote)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s);
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `\n\`\`\`\n${codeBlocks[Number(i)]}\n\`\`\`\n`);

  s = normalizeMarkdownWhitespace(s);

  const truncated = s.length > maxChars;
  return { title, text: truncated ? s.slice(0, maxChars) : s, truncated };
}

module.exports = { extractFromHtml };
