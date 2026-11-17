const fs = require('fs');
const files = ['src/index.html', 'src/404.html',
  ...fs.readdirSync('src/pages').filter(f => f.endsWith('.html')).map(f => 'src/pages/' + f)];
const titles = new Map();
const descs = new Map();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const g = (re) => (s.match(re) || [])[1] || '';
  const title = g(/<title>([\s\S]*?)<\/title>/).trim();
  const desc = g(/<meta\s+name="description"\s+content="([^"]*)"/).trim();
  const robots = g(/<meta\s+name="robots"\s+content="([^"]*)"/).trim();
  const canon = g(/rel="canonical"\s+href="([^"]*)"/).trim();
  const h1 = g(/<h1[^>]*>([\s\S]*?)<\/h1>/).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const jsonld = (s.match(/application\/ld\+json/g) || []).length;
  console.log(f);
  console.log('  TITLE(' + title.length + '): ' + title);
  console.log('  DESC(' + desc.length + '): ' + desc);
  console.log('  ROBOTS: ' + (robots || '(none)'));
  console.log('  CANON: ' + (canon || '(none)'));
  console.log('  H1: ' + h1);
  console.log('  JSONLD: ' + jsonld);
  if (title) titles.set(title, (titles.get(title) || []).concat(f));
  if (desc) descs.set(desc, (descs.get(desc) || []).concat(f));
}
console.log('\n=== DUPLICATE TITLES ===');
for (const [t, fs2] of titles) if (fs2.length > 1) console.log(JSON.stringify(t) + ' -> ' + fs2.join(', '));
console.log('=== DUPLICATE DESCRIPTIONS ===');
for (const [d, fs2] of descs) if (fs2.length > 1) console.log(JSON.stringify(d) + ' -> ' + fs2.join(', '));
console.log('=== TITLE LENGTHS > 60 ===');
for (const [t, fs2] of titles) if (t.length > 60) console.log(t.length + ' ' + JSON.stringify(t) + ' ' + fs2.join(','));
console.log('=== DESC LENGTHS outside 70-165 ===');
for (const [d, fs2] of descs) if (d.length < 70 || d.length > 165) console.log(d.length + ' ' + JSON.stringify(d) + ' ' + fs2.join(','));
