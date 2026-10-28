(function () {
  'use strict';

  const BASE = 'images/';
  const WIX = 'https://static.wixstatic.com/media/';

  const Registry = {
    /* ---- Hero ---- */
    'hero': {
      remote: WIX + 'c4c03c_6fe34c498ef043949b95eb01baa8bb03~mv2.jpg/v1/crop/x_0,y_80,w_3000,h_1789/fill/w_2111,h_1252,al_c,q_90,usm_0.66_1.00_0.01,enc_avif,quality_auto/Skadevi%20G%C3%A5rd%20Foto_edited.jpg',
      local: BASE + 'startsida.jpeg'
    },

    /* ---- Gallery ---- */
    'gallery-1': {
      remote: WIX + 'c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg',
      local: BASE + 'gallery/Kök Öppen Spis Akvarell.jpg'
    },
    'gallery-2': {
      remote: WIX + 'c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg',
      local: BASE + 'gallery/Vardagsrum Akvarell.jpg'
    },
    'gallery-3': {
      remote: WIX + 'c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg',
      local: BASE + 'gallery/Blommigt Rum Akvarell.jpg'
    },
    'gallery-4': {
      remote: WIX + 'c4c03c_a0978ea78d7c4bdb8eb06c79e2b6d6e5~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/96b74d75-8839-42ee-90ce-2c1cd160c05e.jpg',
      local: BASE + 'gallery/Svart Badrum Akvarell.jpg'
    },
    'gallery-5': {
      remote: WIX + 'c4c03c_4a5dee1d48d74fe2a12aceddbc530434~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/8e858783-5ef2-4144-83e9-9da832a96561_edited.jpg',
      local: BASE + 'gallery/Grönt badrum Akvarell.jpg'
    },
    'gallery-6': {
      remote: WIX + 'c4c03c_f27113fb4f5640ffa76a0112eda3b3ff~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/8f62c902-ac97-47cd-92d6-d37fc1374fa3_edited.jpg',
      local: BASE + 'gallery/Dukning Långbord Inomhus Akvarell.jpg'
    },
    'gallery-7': {
      remote: WIX + 'c4c03c_0514cc108d844479b395d4a39f1f9dd8~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/b8f4280a-61dc-4dee-9383-2435a0fa35c5_edited.jpg',
      local: BASE + 'gallery/Dukning Pergola Akvarell.png'
    },
    'gallery-8': {
      remote: WIX + 'c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg',
      local: BASE + 'gallery/Möhippa Pergola Akvarell.jpg'
    },
    'gallery-9': {
      remote: WIX + 'c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg',
      local: BASE + 'gallery/Tennisplan Akvarell.png'
    },
    'gallery-10': {
      remote: WIX + 'c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg',
      local: BASE + 'gallery/Biljardbord akvarell.png'
    },
    'gallery-11': {
      remote: WIX + 'c4c03c_a0978ea78d7c4bdb8eb06c79e2b6d6e5~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/96b74d75-8839-42ee-90ce-2c1cd160c05e.jpg',
      local: BASE + 'gallery/Badtunna akvarell.png'
    },
    'gallery-thumb-1': {
      remote: WIX + 'c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg',
      local: BASE + 'gallery/Kök Öppen Spis Akvarell.jpg'
    },
    'gallery-thumb-2': {
      remote: WIX + 'c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg',
      local: BASE + 'gallery/Vardagsrum Akvarell.jpg'
    },
    'gallery-thumb-3': {
      remote: WIX + 'c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg',
      local: BASE + 'gallery/Blommigt Rum Akvarell.jpg'
    },
    'gallery-thumb-4': {
      remote: WIX + 'c4c03c_a0978ea78d7c4bdb8eb06c79e2b6d6e5~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/96b74d75-8839-42ee-90ce-2c1cd160c05e.jpg',
      local: BASE + 'gallery/Svart Badrum Akvarell.jpg'
    },
    'gallery-thumb-5': {
      remote: WIX + 'c4c03c_4a5dee1d48d74fe2a12aceddbc530434~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/8e858783-5ef2-4144-83e9-9da832a96561_edited.jpg',
      local: BASE + 'gallery/Grönt badrum Akvarell.jpg'
    },
    'gallery-thumb-6': {
      remote: WIX + 'c4c03c_f27113fb4f5640ffa76a0112eda3b3ff~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/8f62c902-ac97-47cd-92d6-d37fc1374fa3_edited.jpg',
      local: BASE + 'gallery/Dukning Långbord Inomhus Akvarell.jpg'
    },
    'gallery-thumb-7': {
      remote: WIX + 'c4c03c_0514cc108d844479b395d4a39f1f9dd8~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/b8f4280a-61dc-4dee-9383-2435a0fa35c5_edited.jpg',
      local: BASE + 'gallery/Dukning Pergola Akvarell.png'
    },
    'gallery-thumb-8': {
      remote: WIX + 'c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg',
      local: BASE + 'gallery/Möhippa Pergola Akvarell.jpg'
    },
    'gallery-thumb-9': {
      remote: WIX + 'c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg',
      local: BASE + 'gallery/Tennisplan Akvarell.png'
    },
    'gallery-thumb-10': {
      remote: WIX + 'c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg',
      local: BASE + 'gallery/Biljardbord akvarell.png'
    },
    'gallery-thumb-11': {
      remote: WIX + 'c4c03c_a0978ea78d7c4bdb8eb06c79e2b6d6e5~mv2.jpg/v1/fill/w_147,h_147,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/96b74d75-8839-42ee-90ce-2c1cd160c05e.jpg',
      local: BASE + 'gallery/Badtunna akvarell.png'
    },

    /* ---- Section images ---- */
    'location': {
      remote: WIX + 'c4c03c_6fe34c498ef043949b95eb01baa8bb03~mv2.jpg/v1/crop/x_0,y_80,w_3000,h_1789/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/Skadevi%20G%C3%A5rd%20Foto_edited.jpg',
      local: BASE + 'gallery/Skadevi Gård.png'
    },
    'corporate': {
      remote: WIX + 'c4c03c_8f7a19b699fd4fbfa9c33dcf98df5ddb~mv2.jpg/v1/crop/x_542,y_0,w_1917,h_2000/fill/w_800,h_500,al_c,q_85,enc_avif,quality_auto/Go%20Team%20_edited.jpg',
      local: BASE + 'gallery/Företag Akvarell.png'
    },
    'vacation': {
      remote: WIX + 'c4c03c_35d43f89d70646648750ab3982cd7fa0~mv2.jpg/v1/crop/x_542,y_0,w_1917,h_2000/fill/w_800,h_500,al_c,q_85,enc_avif,quality_auto/Relaxing%20by%20the%20Water_edited.jpg',
      local: BASE + 'gallery/Tennisplan Akvarell.png'
    },
    'wedding': {
      remote: WIX + 'c4c03c_28e87d2205194311984dc92664c0b6b8~mv2.jpg/v1/crop/x_0,y_248,w_2400,h_2504/fill/w_800,h_500,al_c,q_85,enc_avif,quality_auto/a%20bride%20and%20groom%20hold%20their%20hands%20toget.jpg',
      local: BASE + 'gallery/Dukning Pergola Akvarell.png'
    },
    'party': {
      remote: WIX + 'c4c03c_8aaa7aa6108447b98977c1c66a5126c5~mv2.jpg/v1/crop/x_526,y_0,w_1948,h_2000/fill/w_800,h_500,al_c,q_85,enc_avif,quality_auto/Wine%20tasting%20in%20Paso%20Robles__edited.jpg',
      local: BASE + 'gallery/Möhippa Pergola Akvarell.jpg'
    },

    /* ---- OG / meta ---- */
    'og-image': {
      remote: WIX + 'c4c03c_6fe34c498ef043949b95eb01baa8bb03~mv2.jpg',
      local: BASE + 'Startsida.jpeg'
    },

    /* ---- Hero strip cards ---- */
    'strip-1': {
      remote: WIX + 'c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_6ce29a634f834f44aa9d6cd869f26572~mv2.jpg',
      local: BASE + 'gallery/Tennisplan Akvarell.png'
    },
    'strip-2': {
      remote: WIX + 'c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_a13ced9f3e6b4566a629b751fb20c6ac~mv2.jpg',
      local: BASE + 'gallery/Dukning Pergola Akvarell.png'
    },
    'strip-3': {
      remote: WIX + 'c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_d5c3b5dea07f4237a512db68ccb137af~mv2.jpg',
      local: BASE + 'gallery/Biljardbord akvarell.png'
    },
    'strip-4': {
      remote: WIX + 'c4c03c_a0978ea78d7c4bdb8eb06c79e2b6d6e5~mv2.jpg/v1/fill/w_800,h_600,al_c,q_85,enc_avif,quality_auto/96b74d75-8839-42ee-90ce-2c1cd160c05e.jpg',
      local: BASE + 'gallery/Badtunna akvarell.png'
    },

    /* ---- Sub-pages ---- */
    'page-aktiviteter': {
      remote: WIX + '242229e2404b4161a60a74d8cf3da058.jpg/v1/fill/w_1200,h_500,al_c,q_85,enc_avif,quality_auto/242229e2404b4161a60a74d8cf3da058.jpg',
      local: BASE + 'page-aktiviteter.jpg'
    },
    'page-fest': {
      remote: WIX + '359a5f6d127f443ea17ee6b2043a891a.jpg/v1/fill/w_1200,h_500,al_c,q_85,enc_avif,quality_auto/359a5f6d127f443ea17ee6b2043a891a.jpg',
      local: BASE + 'page-fest.jpg'
    },
    'page-semester': {
      remote: WIX + '13348835c8b5410c8c2900d673711a5b.jpg/v1/crop/x_0,y_499,w_5616,h_1393/fill/w_1200,h_500,al_c,q_85,enc_avif,quality_auto/Group%20practicing%20tai%20chi.jpg',
      local: BASE + 'page-semester.jpg'
    },
    'page-boende': {
      remote: WIX + 'c4c03c_aa05e0ce433b4328bf86eef2e50a0898~mv2.jpg/v1/fill/w_1200,h_600,al_c,q_85,enc_avif,quality_auto/c4c03c_aa05e0ce433b4328bf86eef2e50a0898~mv2.jpg',
      local: BASE + 'page-boende.jpg'
    },
    'page-brollop': {
      remote: WIX + 'c4c03c_28e87d2205194311984dc92664c0b6b8~mv2.jpg/v1/crop/x_0,y_248,w_2400,h_2504/fill/w_1200,h_600,al_c,q_85,enc_avif,quality_auto/a%20bride%20and%20groom%20hold%20their%20hands%20toget.jpg',
      local: BASE + 'page-brollop.jpg'
    },
    'page-foretag': {
      remote: WIX + 'c4c03c_1294fb65c0c442dd81662ba0353026bf~mv2.jpg/v1/crop/x_0,y_480,w_1745,h_820/fill/w_1725,h_810,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/_W1A9773.jpg',
      local: BASE + 'page-foretag.jpg'
    }
  };

  const ImageStorage = {
    _useLocal: true,

    get useLocal() { return this._useLocal; },
    set useLocal(val) { this._useLocal = val; },

    getUrl(key) {
      const entry = Registry[key];
      if (!entry) return '';
      return this._useLocal ? entry.local : entry.remote;
    },

    getSrcSet(key) {
      return this.getUrl(key);
    }
  };

  /* ---- Lazy loading ---- */
  function initLazyLoading() {
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('img[data-image]').forEach(img => {
        const key = img.getAttribute('data-image');
        img.src = ImageStorage.getUrl(key);
      });
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        const key = img.getAttribute('data-image');
        if (key) img.src = ImageStorage.getUrl(key);
        img.removeAttribute('data-image');
        observer.unobserve(img);
      });
    }, { rootMargin: '200px' });

    document.querySelectorAll('img[data-image]').forEach(img => observer.observe(img));
  }

  /* ---- Gallery carousel ---- */
  function initGallery() {
    const imgEl = document.getElementById('gallery-img');
    const thumbs = document.querySelectorAll('.gallery-thumb');
    const prevBtn = document.getElementById('gallery-prev');
    const nextBtn = document.getElementById('gallery-next');
    if (!imgEl || thumbs.length === 0) return;

    const total = thumbs.length;
    let current = 0;
    const fullKeys = Array.from({ length: total }, (_, i) => 'gallery-' + (i + 1));

    thumbs.forEach((t, i) => {
      const idx = t.getAttribute('data-gallery-thumb');
      if (idx) {
        const thumbImg = t.querySelector('img');
        if (thumbImg) thumbImg.src = ImageStorage.getUrl('gallery-thumb-' + idx);
      }
    });

    function goTo(index) {
      if (index < 0) index = total - 1;
      if (index >= total) index = 0;
      current = index;
      imgEl.src = ImageStorage.getUrl(fullKeys[current]);
      thumbs.forEach((t, i) => t.classList.toggle('active', i === current));
    }

    if (prevBtn) prevBtn.addEventListener('click', () => goTo(current - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => goTo(current + 1));
    thumbs.forEach((t, i) => t.addEventListener('click', () => goTo(i)));

    goTo(0);
  }

  /* ---- Init ---- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initLazyLoading();
      initGallery();
    });
  } else {
    initLazyLoading();
    initGallery();
  }

  window.ImageStorage = ImageStorage;
})();
