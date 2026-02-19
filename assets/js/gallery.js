(() => {
  const galleryItems = Array.from(document.querySelectorAll('.gallery-item'));
  if (galleryItems.length === 0) return;

  const modal = document.createElement('div');
  modal.className = 'gallery-modal';
  modal.innerHTML = `
    <button class="close" aria-label="Close gallery">&times;</button>
    <button class="prev" aria-label="Previous image">&#9664;</button>
    <img src="" alt="">
    <button class="next" aria-label="Next image">&#9654;</button>
  `;
  document.body.appendChild(modal);

  const imgEl = modal.querySelector('img');
  const closeBtn = modal.querySelector('.close');
  const prevBtn = modal.querySelector('.prev');
  const nextBtn = modal.querySelector('.next');

  let currentIndex = 0;

  const openModal = (index) => {
    currentIndex = index;
    const href = galleryItems[currentIndex].getAttribute('href');
    imgEl.src = href;
    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden'; // prevent background scroll
  };

  const closeModal = () => {
    modal.classList.remove('is-open');
    document.body.style.overflow = '';      // restore scroll
  };

  const showPrev = () => {
    currentIndex = (currentIndex - 1 + galleryItems.length) % galleryItems.length;
    imgEl.src = galleryItems[currentIndex].getAttribute('href');
  };

  const showNext = () => {
    currentIndex = (currentIndex + 1) % galleryItems.length;
    imgEl.src = galleryItems[currentIndex].getAttribute('href');
  };

  // Open the modal when a thumbnail is clicked
  galleryItems.forEach((item, idx) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(idx);
    });
  });

  // Close button / click‑outside
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // Navigation arrows
  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showPrev();
  });
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showNext();
  });

  // Keyboard shortcuts (Esc, ←, →)
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('is-open')) return;
    if (e.key === 'Escape') closeModal();
    else if (e.key === 'ArrowLeft') showPrev();
    else if (e.key === 'ArrowRight') showNext();
  });
})();
