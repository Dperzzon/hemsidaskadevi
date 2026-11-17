// Genererar den gemensamma sidfoten för alla publika HTML-sidor.
// shared/footer.js är källan till sanningen: kör om skriptet efter en ändring
// i renderFooter() i stället för att redigera varje sida för hand.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderFooter } = require('../shared/footer.js');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'src');

async function main() {
  const pages = [
    path.join(srcDir, 'index.html'),
    ...(await readdir(path.join(srcDir, 'pages')))
      .filter((name) => name.endsWith('.html'))
      .map((name) => path.join(srcDir, 'pages', name))
  ];

  for (const file of pages) {
    const source = await readFile(file, 'utf8');
    const footerPattern = /<footer class="footer"[\s\S]*?<\/footer>/;
    if (!footerPattern.test(source)) {
      throw new Error(`Saknar footer: ${path.relative(root, file)}`);
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const footer = renderFooter().replaceAll('\n', newline);
    const next = source.replace(footerPattern, footer);
    if (next !== source) {
      await writeFile(file, next);
      console.log(`Uppdaterade ${path.relative(root, file)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
