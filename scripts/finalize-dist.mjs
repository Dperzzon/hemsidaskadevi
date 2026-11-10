// Avslutar bygget: skapar de oförändrade sökvägar som de fyra föråldrade
// mallsidorna (priser, mat-dryck, om-oss, digital-visning) läser — se
// vite.config.mjs för varför de inte får transformeras av Vite.
//   dist/css/style.css  <- src/css/style.css (orörd kopia; den hashade
//                          style-chunken innehåller även @font-face som skulle
//                          ändra de sidornas renderingsfel-fonts)
//   dist/js/main.js     <- dist/assets/main-<hash>.js (samma kod, classic-script-kompatibel)
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(projectRoot, 'dist');
const assets = path.join(dist, 'assets');

const files = await readdir(assets);
const main = files.find((name) => /^main-[\w-]+\.js$/.test(name));
if (!main) throw new Error('Bygget saknar main-chunk');

await mkdir(path.join(dist, 'css'), { recursive: true });
await mkdir(path.join(dist, 'js'), { recursive: true });
await copyFile(path.join(projectRoot, 'src', 'css', 'style.css'), path.join(dist, 'css', 'style.css'));
await copyFile(path.join(assets, main), path.join(dist, 'js', 'main.js'));
console.log(`Kopierade src/css/style.css -> /css/style.css och ${main} -> /js/main.js`);
