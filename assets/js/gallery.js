/* assets/js/gallery.js
   -------------------------------------------------
   Light‑box for the gallery – vanilla JS.
   Shows tag badges inside the modal when the picture
   is expanded. Tags are read from the thumbnail's
   data‑tags attribute.
   ------------------------------------------------- */
(() => {
  const items = Array.from(document.querySelectorAll('.gallery-item'));
  if (!items.length) return;

  const modal = document.createElement('div');
  modal.className = 'gallery-modal';
  modal.innerHTML = `
    <button class="close" aria-label="Close gallery">&times;</button>
    <button class="prev" aria-label="Previous image">&#9664;</button>
    <img src="" alt="">
    <div class="gallery-caption-modal"></div>
    <button class="next" aria-label="Next image">&#9654;</button>
  `;
  document.body.appendChild(modal);

  const imgEl     = modal.querySelector('img');
  const closeBtn  = modal.querySelector('.close');
  const prevBtn   = modal.querySelector('.prev');
  const nextBtn   = modal.querySelector('.next');
  const captionEl = modal.querySelector('.gallery-caption-modal');

  let currentIdx = 0;

  const renderCaption = (tagsString) => {
    if (!tagsString) { captionEl.innerHTML = ''; return; }
    const tags = tagsString.split(',').filter(t => t.trim().length);
    if (!tags.length) { captionEl.innerHTML = ''; return; }
    const html = tags.map(t => `<a href="${'/gallery/tag/' + t + '/'}" class="tag-badge">${t}</a>`).join(' ');
    captionEl.innerHTML = html;
  };

  const open = (idx) => {
    currentIdx = idx;
    const link = items[currentIdx];
    imgEl.src = link.getAttribute('href');
    renderCaption(link.dataset.tags);
    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  };

  const close = () => {
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
    captionEl.innerHTML = '';
  };

  const showPrev = () => {
    currentIdx = (currentIdx - 1 + items.length) % items.length;
    const link = items[currentIdx];
    imgEl.src = link.getAttribute('href');
    renderCaption(link.dataset.tags);
  };

  const showNext = () => {
    currentIdx = (currentIdx + 1) % items.length;
    const link = items[currentIdx];
    imgEl.src = link.getAttribute('href');
    renderCaption(link.dataset.tags);
  };

  items.forEach((el, i) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      open(i);
    });
  });

  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showPrev();
  });

  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showNext();
  });

  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('is-open')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') showPrev();
    else if (e.key === 'ArrowRight') showNext();
  });
})();
