// Genererar den gemensamma menyraden (header) för alla publika HTML-sidor.
// Startsidans menyrad är källan till sanningen: kör om skriptet efter en
// ändring i renderHeader() i stället för att redigera varje sida för hand.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'src');

const DESKTOP_LEFT = [
  ['/foretag', 'Företag'],
  ['/fest', 'Fest'],
  ['/brollop', 'Bröllop'],
  ['/semester', 'Semester']
];

const DESKTOP_RIGHT = [
  ['/digital-visning', 'Digital visning'],
  ['/boende', 'Boendet'],
  ['/aktiviteter', 'Aktiviteter'],
  ['/boka', 'Boka']
];

const MOBILE_LINKS = [
  ...DESKTOP_LEFT,
  ...DESKTOP_RIGHT.slice(0, 3),
  ['/priser', 'Priser'],
  ...DESKTOP_RIGHT.slice(3),
  ['/vanliga-fragor', 'Vanliga frågor']
];

function desktopLink([href, label], route, indent) {
  const active = href === route;
  return `${indent}<a href="${href}" class="header-link${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>${label}</a>`;
}

function mobileLink([href, label], route, indent) {
  const active = href === route;
  return `${indent}<a href="${href}"${active ? ' class="active" aria-current="page"' : ''}>${label}</a>`;
}

export function renderHeader(route) {
  return [
    '<header class="header" role="banner">',
    '  <div class="header-side">',
    '    <button class="mobile-toggle" aria-label="Meny" aria-expanded="false">&#9776;</button>',
    ...DESKTOP_LEFT.map((link) => desktopLink(link, route, '    ')),
    '  </div>',
    '  <a href="/" class="header-logo"><img width="512" height="512" src="/images/logo.png" alt="Skadevi Gård"></a>',
    '  <div class="header-side">',
    ...DESKTOP_RIGHT.map((link) => desktopLink(link, route, '    ')),
    '  </div>',
    '  <nav class="header-nav" role="navigation" aria-label="Meny">',
    ...MOBILE_LINKS.map((link) => mobileLink(link, route, '    ')),
    '  </nav>',
    '</header>'
  ].join('\n');
}

function routeFor(file) {
  if (file === path.join(srcDir, 'index.html')) return '/';
  return `/${path.basename(file, '.html')}`;
}

async function main() {
  const pages = [
    path.join(srcDir, 'index.html'),
    ...(await readdir(path.join(srcDir, 'pages')))
      .filter((name) => name.endsWith('.html'))
      .map((name) => path.join(srcDir, 'pages', name))
  ];

  for (const file of pages) {
    const source = await readFile(file, 'utf8');
    const headerPattern = /<header class="header(?: [^"]*)?"[\s\S]*?<\/header>/;
    if (!headerPattern.test(source)) {
      throw new Error(`Saknar header: ${path.relative(root, file)}`);
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const header = renderHeader(routeFor(file)).replaceAll('\n', newline);
    const next = source.replace(headerPattern, header);
    if (next !== source) {
      await writeFile(file, next);
      console.log(`Uppdaterade ${path.relative(root, file)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
