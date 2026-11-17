// Injicerar den gemensamma analysdelen (Consent Mode v2 + GTM) i alla publika
// HTML-sidor. Körs om efter ändringar i shared/analytics.js:
//   npm run sync:analytics
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderAnalyticsHead } = require('../shared/analytics.js');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'src');
const START = '<!-- SKADEVI ANALYTICS START -->';
const END = '<!-- SKADEVI ANALYTICS END -->';

async function pages() {
  const pagesDir = path.join(srcDir, 'pages');
  return [
    path.join(srcDir, 'index.html'),
    path.join(srcDir, '404.html'),
    ...(await readdir(pagesDir))
      .filter((name) => name.endsWith('.html'))
      .map((name) => path.join(pagesDir, name))
  ];
}

function inject(source, snippet) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  let base = source;
  if (start !== -1 && end !== -1 && end > start) {
    base = (source.slice(0, start) + source.slice(end + END.length)).replace(/^\s*\n/, '');
  }
  // Analysdelen får aldrig hamna före meta charset: då kan webbläsaren tolka
  // sidan med fel teckenkodning innan charset hunnit läsas.
  const charset = /<meta charset="[^"]*">\r?\n?/.exec(base);
  const head = /<head[^>]*>\r?\n?/.exec(base);
  if (!charset && !head) throw new Error('Saknar <head>');
  const anchor = charset || head;
  const insertAt = anchor.index + anchor[0].length;
  let output = base.slice(0, insertAt) + snippet + '\n' + base.slice(insertAt);
  // Håll head städat även när blocket har flyttats mellan körningar.
  output = output.replace(/(<head[^>]*>)\r?\n(?:[ \t]*\r?\n)+([ \t]*<meta charset)/, '$1\n$2');
  output = output.replace(/(SKADEVI ANALYTICS END -->)(?:[ \t]*\r?\n){2,}/, '$1\n\n');
  return output;
}

for (const file of await pages()) {
  const source = await readFile(file, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const snippet = renderAnalyticsHead().replaceAll('\n', newline);
  const next = inject(source, snippet);
  if (next !== source) {
    await writeFile(file, next);
    console.log(`Uppdaterade ${path.relative(root, file)}`);
  }
}
