// Bildregister för alla JS-laddade bilder (hero, galleri, sektionsbilder).
// Lokala, optimerade filer under /images/. IntersectionObserver laddar
// bilder strax utanför vyn; galleriet byter huvudbild vid klick.

const IMAGE_PATHS = {
  hero: '/images/hero-startsida.webp',

  'gallery-1': '/images/gallery/kok-open-spis.webp',
  'gallery-2': '/images/gallery/vardagsrum.webp',
  'gallery-3': '/images/gallery/blommigt-rum.webp',
  'gallery-4': '/images/gallery/svart-badrum.webp',
  'gallery-5': '/images/gallery/gront-badrum.webp',
  'gallery-6': '/images/gallery/dukning-langbord.webp',
  'gallery-7': '/images/gallery/dukning-pergola.webp',
  'gallery-8': '/images/gallery/mohippa-pergola.webp',
  'gallery-9': '/images/gallery/tennisplan.webp',
  'gallery-10': '/images/gallery/biljardbord.webp',
  'gallery-11': '/images/gallery/badtunna.webp',

  'gallery-thumb-1': '/images/gallery/kok-open-spis.webp',
  'gallery-thumb-2': '/images/gallery/vardagsrum.webp',
  'gallery-thumb-3': '/images/gallery/blommigt-rum.webp',
  'gallery-thumb-4': '/images/gallery/svart-badrum.webp',
  'gallery-thumb-5': '/images/gallery/gront-badrum.webp',
  'gallery-thumb-6': '/images/gallery/dukning-langbord.webp',
  'gallery-thumb-7': '/images/gallery/dukning-pergola.webp',
  'gallery-thumb-8': '/images/gallery/mohippa-pergola.webp',
  'gallery-thumb-9': '/images/gallery/tennisplan.webp',
  'gallery-thumb-10': '/images/gallery/biljardbord.webp',
  'gallery-thumb-11': '/images/gallery/badtunna.webp',

  location: '/images/gallery/skadevi-gard.webp',
  corporate: '/images/gallery/foretag-akvarell.webp',
  vacation: '/images/gallery/tennisplan.webp',
  wedding: '/images/gallery/dukning-pergola.webp',
  party: '/images/gallery/mohippa-pergola.webp',

  'strip-1': '/images/gallery/tennisplan.webp',
  'strip-2': '/images/gallery/dukning-pergola.webp',
  'strip-3': '/images/gallery/biljardbord.webp',
  'strip-4': '/images/gallery/badtunna.webp'
};

function getUrl(key) {
  return IMAGE_PATHS[key] ?? '';
}

function initLazyLoading() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('img[data-image]').forEach((img) => {
      img.src = getUrl(img.getAttribute('data-image'));
    });
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      const key = img.getAttribute('data-image');
      if (key) img.src = getUrl(key);
      img.removeAttribute('data-image');
      observer.unobserve(img);
    });
  }, { rootMargin: '200px' });

  document.querySelectorAll('img[data-image]').forEach((img) => observer.observe(img));
}

function initGallery() {
  const imgEl = document.getElementById('gallery-img');
  const thumbs = document.querySelectorAll('.gallery-thumb');
  const prevBtn = document.getElementById('gallery-prev');
  const nextBtn = document.getElementById('gallery-next');
  if (!imgEl || thumbs.length === 0) return;

  const total = thumbs.length;
  let current = 0;
  const fullKeys = Array.from({ length: total }, (_, i) => `gallery-${i + 1}`);

  thumbs.forEach((thumb) => {
    const index = thumb.getAttribute('data-gallery-thumb');
    if (index) {
      const thumbImg = thumb.querySelector('img');
      if (thumbImg) thumbImg.src = getUrl(`gallery-thumb-${index}`);
    }
  });

  function goTo(index) {
    if (index < 0) index = total - 1;
    if (index >= total) index = 0;
    current = index;
    imgEl.src = getUrl(fullKeys[current]);
    thumbs.forEach((thumb, i) => thumb.classList.toggle('active', i === current));
  }

  if (prevBtn) prevBtn.addEventListener('click', () => goTo(current - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => goTo(current + 1));
  thumbs.forEach((thumb, i) => thumb.addEventListener('click', () => goTo(i)));

  goTo(0);
}

function init() {
  initLazyLoading();
  initGallery();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Exponeras för felsökning och testharness.
window.ImageStorage = { getUrl };
